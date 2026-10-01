import "server-only";
import { and, eq, ilike, inArray, ne, or, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { syncGmail, type GmailSyncResult } from "@/lib/gmail/sync";
import { analyzePending } from "@/lib/gmail/analyze";
import { loadIngestContext } from "@/lib/gmail/ingest";
import { syncCalendar, type CalendarSyncResult } from "@/lib/calendar/sync";
import { syncGranola, type GranolaSyncResult } from "@/lib/transcripts/granola";
import { CALENDAR_READ_SCOPE, GMAIL_READ_SCOPE, hasScope, safeErrorMessage, shouldSkipForBackoff, type SyncState } from "./core";
import { getGoogleAccount } from "./google";
import { IntegrationAuthError, ensureConnection, getConnection, recordSyncFailure, type Connection, type Provider } from "./store";

export type UserSyncReport = {
  userId: string;
  gmail?: GmailSyncResult | { error: string } | { skipped: string };
  calendar?: CalendarSyncResult | { error: string } | { skipped: string };
  granola?: GranolaSyncResult | { error: string } | { skipped: string };
  analyzed?: number;
};

async function guarded<T>(conn: Connection | null, respectBackoff: boolean, fn: () => Promise<T>): Promise<T | { error: string } | { skipped: string }> {
  if (conn && respectBackoff && shouldSkipForBackoff(conn.config as SyncState, new Date())) return { skipped: "backoff" };
  try {
    return await fn();
  } catch (e) {
    if (conn) {
      const fresh = (await getConnection(conn.userId, conn.provider as Provider)) ?? conn;
      await recordSyncFailure(fresh, e);
    }
    return { error: safeErrorMessage(e) };
  }
}

/**
 * Gmail + Calendar + Granola for one user. Errors are recorded per provider (status error → NS-30). `deadlineMs` (cron)
 * bounds the calendar step's brief preparation so later mailboxes still get synced inside the cron window.
 */
export async function runUserSync(userId: string, opts: { respectBackoff?: boolean; analyzeLimit?: number; deadlineMs?: number } = {}): Promise<UserSyncReport> {
  const respect = opts.respectBackoff ?? false;
  const report: UserSyncReport = { userId };
  const acct = await getGoogleAccount(userId);
  const wantsGmail = hasScope(acct?.scope, GMAIL_READ_SCOPE);
  const wantsCal = hasScope(acct?.scope, CALENDAR_READ_SCOPE);

  if (wantsGmail || wantsCal) {
    let ctx: Awaited<ReturnType<typeof loadIngestContext>> | undefined;
    try {
      ctx = await loadIngestContext(userId);
    } catch (e) {
      report.gmail = { error: safeErrorMessage(e) };
    }
    if (ctx) {
      if (wantsGmail) {
        const conn = await ensureConnection(userId, "gmail");
        report.gmail = await guarded(conn, respect, () => syncGmail(userId, { ctx }));
      }
      if (wantsCal) {
        const conn = await ensureConnection(userId, "calendar");
        report.calendar = await guarded(conn, respect, () => syncCalendar(userId, { ctx, deadlineMs: opts.deadlineMs }));
      }
    }
  } else {
    // Scope was removed/never granted: flag an existing connection so NS-30 can fire.
    const conn = await getConnection(userId, "gmail");
    if (conn && conn.status === "connected") {
      await recordSyncFailure(conn, new IntegrationAuthError("Gmail permission is missing. Reconnect your inbox in Settings."));
    }
    report.gmail = { skipped: "not_connected" };
  }

  const granola = await getConnection(userId, "granola");
  if (granola && granola.status !== "revoked" && granola.secretEncrypted) {
    report.granola = await guarded(granola, respect, () => syncGranola(userId));
  }

  try {
    report.analyzed = await analyzePending(userId, opts.analyzeLimit ?? 20);
  } catch {
    report.analyzed = 0;
  }
  return report;
}

/** Users to sync: anyone with a Gmail/Calendar grant or a Granola key (not banned, not pending). */
export async function usersToSync(): Promise<string[]> {
  const google = await db
    .selectDistinct({ id: s.account.userId })
    .from(s.account)
    .innerJoin(s.user, eq(s.user.id, s.account.userId))
    .where(
      and(
        eq(s.account.providerId, "google"),
        or(ilike(s.account.scope, "%gmail.readonly%"), ilike(s.account.scope, "%calendar.readonly%")),
        ne(s.user.role, "pending"),
        or(isNull(s.user.banned), eq(s.user.banned, false)),
      ),
    );
  const granola = await db
    .selectDistinct({ id: s.integrationConnections.userId })
    .from(s.integrationConnections)
    .where(and(eq(s.integrationConnections.provider, "granola"), inArray(s.integrationConnections.status, ["connected", "error"])));
  return [...new Set([...google.map((g) => g.id), ...granola.map((g) => g.id).filter((x): x is string => Boolean(x))])];
}

/** Cron entry: iterate users until the time budget is spent; the next run continues (per-user cursors). */
export async function runScheduledSync(deadlineMs: number): Promise<{ users: number; processed: number; reports: UserSyncReport[] }> {
  const ids = await usersToSync();
  // Least-recently-synced first so a slow mailbox can't starve others.
  const last = ids.length
    ? await db
        .select({ userId: s.integrationConnections.userId, lastSyncAt: s.integrationConnections.lastSyncAt })
        .from(s.integrationConnections)
        .where(and(inArray(s.integrationConnections.userId, ids), eq(s.integrationConnections.provider, "gmail")))
    : [];
  const lastBy = new Map(last.map((r) => [r.userId, r.lastSyncAt?.getTime() ?? 0]));
  ids.sort((a, b) => (lastBy.get(a) ?? 0) - (lastBy.get(b) ?? 0));
  const reports: UserSyncReport[] = [];
  for (const id of ids) {
    if (Date.now() > deadlineMs) break;
    reports.push(await runUserSync(id, { respectBackoff: true, deadlineMs }));
  }
  return { users: ids.length, processed: reports.length, reports };
}
