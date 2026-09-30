import "server-only";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { autonomyLevel } from "@/lib/integrations/core";
import { bumpActivity, internalDomains, loadDirectory, resolveDealForAccount } from "@/lib/integrations/directory";
import type { Directory } from "@/lib/integrations/matching-core";
import { matchParticipants, normalizeEmail } from "@/lib/integrations/matching-core";
import { recomputeDealHealth } from "@/lib/deals/service";

export type TranscriptSource = (typeof s.transcriptSource.enumValues)[number];

export type IngestTranscriptInput = {
  source: TranscriptSource;
  externalId?: string | null;
  title: string | null;
  rawText: string; // canonical format (see parse.ts)
  occurredAt: Date | null;
  durationMin?: number | null;
  participants: string[]; // emails and/or speaker names
  uploadedBy: string | null;
  dealId?: string | null;
  accountId?: string | null;
  meetingId?: string | null;
  consent?: boolean;
  calendarEventId?: string | null;
};

const ACTIVITY_SOURCE: Record<TranscriptSource, (typeof s.activitySource.enumValues)[number]> = {
  granola: "granola",
  zoom: "zoom",
  meet: "meet",
  upload: "upload",
  paste: "upload",
};

/**
 * Store a transcript (dedupe on source+externalId; edited Granola notes update the text and re-queue analysis),
 * match it to a meeting (calendar event id, else owner ± 45 min) and deal (explicit → meeting → attendee domains),
 * and log one `call` activity.
 */
export async function ingestTranscript(
  input: IngestTranscriptInput,
  /** Share one memoized directory across a sync run (`directoryLoader()`), instead of a full reload per transcript (M-23). */
  opts: { directory?: () => Promise<Directory> } = {},
): Promise<{ id: string; created: boolean; changed: boolean }> {
  if (input.externalId) {
    const [existing] = await db
      .select({ id: s.transcripts.id, rawText: s.transcripts.rawText })
      .from(s.transcripts)
      .where(and(eq(s.transcripts.source, input.source), eq(s.transcripts.externalId, input.externalId)))
      .limit(1);
    if (existing) {
      if (existing.rawText === input.rawText) return { id: existing.id, created: false, changed: false };
      await db
        .update(s.transcripts)
        .set({ rawText: input.rawText, title: input.title, status: "pending", error: null })
        .where(eq(s.transcripts.id, existing.id));
      return { id: existing.id, created: false, changed: true };
    }
  }

  let meetingId = input.meetingId ?? null;
  let dealId = input.dealId ?? null;
  let accountId = input.accountId ?? null;

  // 1) meeting match
  if (!meetingId && input.uploadedBy) {
    let meeting: typeof s.meetings.$inferSelect | undefined;
    if (input.calendarEventId) {
      [meeting] = await db
        .select()
        .from(s.meetings)
        .where(and(eq(s.meetings.ownerId, input.uploadedBy), eq(s.meetings.calendarEventId, input.calendarEventId)))
        .limit(1);
    }
    if (!meeting && input.occurredAt) {
      const lo = new Date(input.occurredAt.getTime() - 45 * 60_000);
      const hi = new Date(input.occurredAt.getTime() + 45 * 60_000);
      [meeting] = await db
        .select()
        .from(s.meetings)
        .where(and(eq(s.meetings.ownerId, input.uploadedBy), gte(s.meetings.startsAt, lo), lte(s.meetings.startsAt, hi), isNull(s.meetings.transcriptId)))
        .limit(1);
    }
    if (meeting) {
      meetingId = meeting.id;
      dealId = dealId ?? meeting.dealId;
      accountId = accountId ?? meeting.accountId;
    }
  }

  // 2) attendee match (autonomy link_transcript ≥ 2 auto-links the deal)
  const emails = input.participants.map((p) => normalizeEmail(p)).filter((e): e is string => Boolean(e));
  if (!accountId && emails.length && input.uploadedBy) {
    const [u] = await db.select({ email: s.user.email }).from(s.user).where(eq(s.user.id, input.uploadedBy));
    const m = matchParticipants(emails, await (opts.directory ?? loadDirectory)(), { internalDomains: await internalDomains(u?.email), blocklist: [], ownerEmail: u?.email });
    accountId = m.accountId;
    const autonomy = await getSetting<Record<string, unknown>>("agent.autonomy", {});
    if (!dealId && accountId && autonomyLevel(autonomy, "link_transcript") >= 2) dealId = await resolveDealForAccount(accountId, input.uploadedBy);
  }
  if (dealId && !accountId) {
    const [d] = await db.select({ accountId: s.deals.accountId }).from(s.deals).where(eq(s.deals.id, dealId));
    accountId = d?.accountId ?? null;
  }

  const [row] = await db
    .insert(s.transcripts)
    .values({
      source: input.source,
      externalId: input.externalId ?? null,
      title: input.title,
      rawText: input.rawText,
      occurredAt: input.occurredAt,
      durationMin: input.durationMin ?? null,
      participants: input.participants.slice(0, 50),
      uploadedBy: input.uploadedBy,
      dealId,
      accountId,
      meetingId,
      status: "pending",
    })
    .onConflictDoNothing({ target: [s.transcripts.source, s.transcripts.externalId] })
    .returning({ id: s.transcripts.id });
  if (!row) {
    const [again] = await db
      .select({ id: s.transcripts.id })
      .from(s.transcripts)
      .where(and(eq(s.transcripts.source, input.source), eq(s.transcripts.externalId, input.externalId ?? "")))
      .limit(1);
    return { id: again!.id, created: false, changed: false };
  }

  if (meetingId) {
    await db
      .update(s.meetings)
      .set({ transcriptId: row.id, ...(input.consent ? { consentConfirmed: true } : {}) })
      .where(eq(s.meetings.id, meetingId));
  }
  const occurredAt = input.occurredAt ?? new Date();
  await db.insert(s.activities).values({
    type: "call",
    source: ACTIVITY_SOURCE[input.source],
    subject: input.title ?? "Call transcript",
    body: null,
    occurredAt,
    durationMin: input.durationMin ?? null,
    actorId: input.uploadedBy,
    dealId,
    accountId,
    transcriptId: row.id,
    meetingId,
    metadata: { consent: Boolean(input.consent), source: input.source },
  });
  await bumpActivity(dealId, [], occurredAt);
  if (dealId) await recomputeDealHealth(dealId);
  return { id: row.id, created: true, changed: false };
}

/** Attach/detach a deal after the fact; keeps the call activity in sync. */
export async function setTranscriptDeal(transcriptId: string, dealId: string | null) {
  let accountId: string | null = null;
  if (dealId) {
    const [d] = await db.select({ accountId: s.deals.accountId }).from(s.deals).where(eq(s.deals.id, dealId));
    accountId = d?.accountId ?? null;
  }
  await db.update(s.transcripts).set({ dealId, ...(dealId ? { accountId } : {}) }).where(eq(s.transcripts.id, transcriptId));
  await db
    .update(s.activities)
    .set({ dealId, ...(dealId ? { accountId } : {}) })
    .where(and(eq(s.activities.transcriptId, transcriptId), eq(s.activities.type, "call")));
  if (dealId) {
    await bumpActivity(dealId, [], new Date());
    await recomputeDealHealth(dealId);
  }
}
