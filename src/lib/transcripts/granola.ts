import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { IntegrationAuthError, getConnection, recordSyncSuccess } from "@/lib/integrations/store";
import { GRANOLA_API, parseNote, parseNoteList, type GranolaNoteSummary } from "./granola-core";
import { normalizeTranscript } from "./parse";
import { ingestTranscript } from "./ingest";
import { directoryLoader } from "@/lib/integrations/directory";
import { analyzeTranscript } from "./analyze";

export class GranolaApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "GranolaApiError";
  }
}

async function granolaGet(key: string, path: string, query?: URLSearchParams | string): Promise<unknown> {
  const q = query ? `?${query.toString()}` : "";
  const res = await fetch(`${GRANOLA_API.base}${path}${q}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (res.status === 401 || res.status === 403) throw new IntegrationAuthError("Granola rejected the API key. Update it in Settings.");
  if (!res.ok) throw new GranolaApiError(`Granola API ${res.status} on ${path}`, res.status);
  try {
    return await res.json();
  } catch {
    throw new GranolaApiError(`Granola API returned non-JSON on ${path}`, res.status);
  }
}

/** Live check used when a user saves a key. Throws IntegrationAuthError for bad keys. */
export async function testGranolaKey(key: string): Promise<void> {
  const json = await granolaGet(key, GRANOLA_API.listNotes, new URLSearchParams({ page_size: "1" }));
  parseNoteList(json);
}

export type GranolaSyncResult = { listed: number; ingested: number; updated: number; skipped: number; at: string };

/**
 * CALL-2: poll the user's recent Granola notes (since cursor, re-checking the last 3 days for edits), fetch each
 * note with its transcript and ingest (dedupe on source+externalId; edited notes update the text + re-analyze).
 */
export async function syncGranola(userId: string): Promise<GranolaSyncResult> {
  const conn = await getConnection(userId, "granola");
  const at = new Date().toISOString();
  if (!conn || conn.status === "revoked" || !conn.secretEncrypted) return { listed: 0, ingested: 0, updated: 0, skipped: 0, at };
  const key = decryptSecret(conn.secretEncrypted);
  const [u] = await db.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, userId));

  const since = new Date(Math.min(conn.cursor ? new Date(conn.cursor).getTime() : Date.now() - 14 * 86_400_000, Date.now() - 3 * 86_400_000));
  const notes: GranolaNoteSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < GRANOLA_API.maxPages; page++) {
    const q = new URLSearchParams({ created_after: since.toISOString(), page_size: String(GRANOLA_API.pageSize) });
    if (cursor) q.set("cursor", cursor);
    const res = parseNoteList(await granolaGet(key, GRANOLA_API.listNotes, q));
    notes.push(...res.notes.filter((n) => !n.createdAt || n.createdAt >= since));
    if (!res.hasMore || !res.cursor) break;
    cursor = res.cursor;
  }

  let ingested = 0;
  let updated = 0;
  let skipped = 0;
  let newest = conn.cursor ? new Date(conn.cursor) : since;
  const directory = directoryLoader(); // loaded at most once per sync (M-23)
  for (const summary of notes.slice(0, 25)) {
    const note = parseNote(await granolaGet(key, GRANOLA_API.getNote(summary.id), GRANOLA_API.transcriptQuery), u?.name ?? "Me");
    const text = note.transcriptText ?? note.notesMarkdown;
    if (!text) {
      skipped++;
      continue;
    }
    const norm = normalizeTranscript(note.transcriptText ? null : "notes.md", text);
    const r = await ingestTranscript({
      source: "granola",
      externalId: note.id,
      title: note.title,
      rawText: norm.text,
      occurredAt: note.startsAt ?? note.createdAt,
      durationMin: note.startsAt && note.endsAt ? Math.max(1, Math.round((note.endsAt.getTime() - note.startsAt.getTime()) / 60_000)) : norm.durationMin,
      participants: [...note.attendees.map((a) => a.email ?? a.name ?? "").filter(Boolean), ...norm.speakers].slice(0, 50),
      uploadedBy: userId,
      calendarEventId: note.calendarEventId,
    }, { directory });
    if (r.created) ingested++;
    else if (r.changed) updated++;
    else skipped++;
    if (r.created || r.changed) await analyzeTranscript(r.id);
    const c = note.createdAt ?? summary.createdAt;
    if (c && c > newest) newest = c;
  }
  const result = { listed: notes.length, ingested, updated, skipped, at };
  await recordSyncSuccess(conn, { lastResult: result }, { cursor: newest.toISOString() });
  return result;
}
