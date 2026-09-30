import "server-only";
import { getSetting } from "@/lib/settings";
import { GMAIL_READ_SCOPE } from "@/lib/integrations/core";
import { GoogleApiError, getGoogleAccessToken } from "@/lib/integrations/google";
import { ensureConnection, recordSyncSuccess, type Connection } from "@/lib/integrations/store";
import { getMessage, getProfile, listHistory, listMessages, type MessageRef } from "./client";
import { ingestParsedMessage, loadIngestContext, wouldIngest, type IngestContext } from "./ingest";
import { parseGmailMessage, shouldSkipLabels } from "./parse";

/** Sync state stored in integration_connections(provider "gmail").config; cursor = last processed Gmail historyId. */
export type GmailSyncConfig = {
  backfillPageToken?: string | null;
  backfillHistoryId?: string | null;
  pendingIds?: MessageRef[];
  failures?: number;
  nextRetryAt?: string | null;
  lastResult?: GmailSyncResult;
};

export type GmailSyncResult = {
  mode: "backfill" | "incremental" | "paused";
  scanned: number;
  ingested: number;
  skipped: number;
  done: boolean;
  at: string;
};

const MAX_MESSAGES_PER_RUN = 250;
const MAX_PENDING = 2000;
const BACKFILL_QUERY = (days: number) => `newer_than:${days}d -in:chats -in:spam -in:trash -in:drafts`;

/**
 * EML-2: initial backfill (email.backfill_days via messages.list q=newer_than:Nd), then incremental via
 * users.history.list(startHistoryId = cursor). Bounded per run; leftovers continue next run.
 * Push (Pub/Sub watch) is not wired yet — the cron + "Sync now" provide near-real-time fallback.
 */
export async function syncGmail(userId: string, opts: { ctx?: IngestContext } = {}): Promise<GmailSyncResult> {
  const conn = await ensureConnection(userId, "gmail");
  const now = new Date().toISOString();
  if (conn.status === "revoked") return { mode: "paused", scanned: 0, ingested: 0, skipped: 0, done: true, at: now };

  const token = await getGoogleAccessToken(userId, GMAIL_READ_SCOPE);
  const cfg = (conn.config ?? {}) as GmailSyncConfig;
  const ctx = opts.ctx ?? (await loadIngestContext(userId));

  let refs: MessageRef[] = [...(cfg.pendingIds ?? [])];
  const patch: GmailSyncConfig = { pendingIds: [] };
  let cursor = conn.cursor;
  let mode: GmailSyncResult["mode"] = cursor ? "incremental" : "backfill";
  let done = true;

  if (!cursor) {
    const historyId = cfg.backfillHistoryId ?? (await getProfile(token)).historyId;
    const days = Math.max(1, Math.min(365, Number(await getSetting("email.backfill_days", 90)) || 90));
    let pageToken = cfg.backfillPageToken ?? null;
    do {
      const page = await listMessages(token, { q: BACKFILL_QUERY(days), pageToken, maxResults: 100 });
      refs.push(...(page.messages ?? []));
      pageToken = page.nextPageToken ?? null;
    } while (pageToken && refs.length < MAX_MESSAGES_PER_RUN);
    if (pageToken) {
      done = false;
      patch.backfillPageToken = pageToken;
      patch.backfillHistoryId = historyId;
    } else {
      patch.backfillPageToken = null;
      patch.backfillHistoryId = null;
      cursor = historyId; // switch to incremental from the point the backfill started
    }
  } else {
    try {
      let pageToken: string | null = null;
      let latest = cursor;
      let pages = 0;
      do {
        const page = await listHistory(token, cursor, pageToken);
        for (const h of page.history ?? []) for (const a of h.messagesAdded ?? []) refs.push({ id: a.message.id, threadId: a.message.threadId });
        latest = page.historyId ?? latest;
        pageToken = page.nextPageToken ?? null;
        pages++;
      } while (pageToken && pages < 20);
      cursor = latest;
    } catch (e) {
      // historyId too old (404) → restart with a backfill; dedupe makes this safe.
      if (e instanceof GoogleApiError && e.status === 404) {
        await recordSyncSuccess(conn, { backfillPageToken: null, backfillHistoryId: null, pendingIds: [] }, { cursor: null });
        return { mode: "incremental", scanned: 0, ingested: 0, skipped: 0, done: false, at: now };
      }
      throw e;
    }
    mode = "incremental";
  }

  // dedupe refs, process a bounded batch, carry the rest over
  const seen = new Set<string>();
  refs = refs.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  const batch = refs.slice(0, MAX_MESSAGES_PER_RUN);
  patch.pendingIds = refs.slice(MAX_MESSAGES_PER_RUN, MAX_MESSAGES_PER_RUN + MAX_PENDING);
  if (patch.pendingIds.length) done = false;

  let ingested = 0;
  let skipped = 0;
  for (const ref of batch) {
    const r = await processMessage(token, ctx, ref.id);
    if (r === "ingested") ingested++;
    else skipped++;
  }

  const result: GmailSyncResult = { mode, scanned: batch.length, ingested, skipped, done, at: now };
  await recordSyncSuccess(conn as Connection, { ...patch, lastResult: result }, { cursor });
  return result;
}

async function processMessage(token: string, ctx: IngestContext, id: string): Promise<"ingested" | "skipped"> {
  try {
    // metadata first: cheap relevance decision before downloading bodies
    const meta = parseGmailMessage(await getMessage(token, id, "metadata"));
    if (shouldSkipLabels(meta.labelIds) || !(await wouldIngest(ctx, meta))) return "skipped";
    const full = parseGmailMessage(await getMessage(token, id, "full"));
    const r = await ingestParsedMessage(ctx, { ...full, labelIds: full.labelIds.length ? full.labelIds : meta.labelIds });
    return r.status === "ingested" ? "ingested" : "skipped";
  } catch (e) {
    if (e instanceof GoogleApiError && e.status === 404) return "skipped"; // deleted since listed
    throw e;
  }
}
