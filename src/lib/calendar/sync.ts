import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { CALENDAR_READ_SCOPE } from "@/lib/integrations/core";
import { getGoogleAccessToken, googleFetch } from "@/lib/integrations/google";
import { matchParticipants } from "@/lib/integrations/matching-core";
import { resolveDealForAccount } from "@/lib/integrations/directory";
import { ensureConnection, recordSyncSuccess } from "@/lib/integrations/store";
import { loadIngestContext, type IngestContext } from "@/lib/gmail/ingest";
import { prepareDayBriefs } from "@/lib/briefs/meeting";
import { calendarWindow, isSyncableEvent, parseCalendarEvent, type CalendarEvent } from "./parse";

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export type CalendarSyncResult = { upserted: number; removed: number; skipped: number; at: string; briefs?: number };

/**
 * ACT-6: sync the primary calendar window (past 2 days → next 14 days) into rso.meetings.
 * Only meetings with at least one external (non-RTB) attendee are stored; deal/account are matched by attendee
 * contacts/domains. Cancelled events are removed unless a transcript is already attached.
 */
export async function syncCalendar(userId: string, opts: { ctx?: IngestContext; deadlineMs?: number } = {}): Promise<CalendarSyncResult> {
  const conn = await ensureConnection(userId, "calendar");
  const at = new Date().toISOString();
  if (conn.status === "revoked") return { upserted: 0, removed: 0, skipped: 0, at };
  const token = await getGoogleAccessToken(userId, CALENDAR_READ_SCOPE);
  const ctx = opts.ctx ?? (await loadIngestContext(userId));
  const { timeMin, timeMax } = calendarWindow(new Date());

  const events: CalendarEvent[] = [];
  let pageToken: string | null = null;
  let pages = 0;
  do {
    const p = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250", showDeleted: "true" });
    if (pageToken) p.set("pageToken", pageToken);
    const page: { items?: CalendarEvent[]; nextPageToken?: string } = await googleFetch(token, `${EVENTS_URL}?${p}`);
    events.push(...(page.items ?? []));
    pageToken = page.nextPageToken ?? null;
    pages++;
  } while (pageToken && pages < 5);

  let upserted = 0;
  let skipped = 0;
  const cancelledIds: string[] = [];
  for (const raw of events) {
    const e = parseCalendarEvent(raw);
    if (e.cancelled) {
      cancelledIds.push(e.id);
      continue;
    }
    if (!isSyncableEvent(e, raw, ctx.owner.email)) {
      skipped++;
      continue;
    }
    const match = matchParticipants(e.attendees, ctx.directory, { internalDomains: ctx.internal, blocklist: ctx.blocklist, ownerEmail: ctx.owner.email });
    if (match.reason === "blocked" || match.reason === "internal_only" || match.reason === "no_participants") {
      skipped++;
      continue;
    }
    const dealId = match.accountId ? await resolveDealForAccount(match.accountId, userId) : null;
    await db
      .insert(s.meetings)
      .values({
        ownerId: userId,
        calendarEventId: e.id,
        title: e.title,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        attendees: e.attendees,
        dealId,
        accountId: match.accountId,
      })
      .onConflictDoUpdate({
        target: [s.meetings.ownerId, s.meetings.calendarEventId],
        set: {
          title: e.title,
          startsAt: e.startsAt,
          endsAt: e.endsAt,
          attendees: e.attendees,
          // keep manual links; only fill when empty
          dealId: sql`coalesce(${s.meetings.dealId}, ${dealId}::uuid)`,
          accountId: sql`coalesce(${s.meetings.accountId}, ${match.accountId}::uuid)`,
        },
      });
    upserted++;
  }

  let removed = 0;
  if (cancelledIds.length) {
    const del = await db
      .delete(s.meetings)
      .where(and(eq(s.meetings.ownerId, userId), inArray(s.meetings.calendarEventId, cancelledIds), isNull(s.meetings.transcriptId)))
      .returning({ id: s.meetings.id });
    removed = del.length;
  }
  const result: CalendarSyncResult = { upserted, removed, skipped, at };
  await recordSyncSuccess(conn, { lastResult: result });
  // V2 A5: the morning sync prepares briefs for the rest of today's external meetings (idempotent; never throws).
  // CR L3: bounded — a per-user brief budget (or the caller's deadline, whichever is sooner) so later mailboxes still
  // get synced inside the cron window
  const budget = Date.now() + 20_000;
  result.briefs = await prepareDayBriefs(userId, { deadlineMs: opts.deadlineMs ? Math.min(opts.deadlineMs, budget) : budget });
  return result;
}
