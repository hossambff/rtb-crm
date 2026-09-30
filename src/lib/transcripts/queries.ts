import "server-only";
import { and, desc, eq, exists, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealAccessWhere, scopeFor, type AppUser } from "@/lib/rbac/server";
import { visibleDealNames } from "@/lib/gmail/queries";
import type { TranscriptAnalysis } from "./analysis-core";

export type CallFilters = { q?: string; source?: string; status?: string; dealId?: string };

/**
 * Calls visibility: own = transcripts you uploaded/own; team/all widen by uploader. Transcripts linked to deals are
 * only shown to non-owners when the deal is visible to them (restricted/MNPI safe).
 */
async function visibleWhere(user: AppUser): Promise<SQL | null> {
  const scope = await scopeFor(user, "calls", "view");
  if (scope === "none") return null;
  const own = eq(s.transcripts.uploadedBy, user.id);
  if (scope === "own") return own;
  const dealWhere = await dealAccessWhere(user, "view");
  const dealOk = or(isNull(s.transcripts.dealId), exists(db.select({ x: sql`1` }).from(s.deals).where(and(eq(s.deals.id, s.transcripts.dealId), dealWhere))))!;
  const owner = scope === "team" ? inArray(s.transcripts.uploadedBy, user.teamMemberIds.length ? user.teamMemberIds : [user.id]) : sql`true`;
  return or(own, and(owner, dealOk))!;
}

export async function listTranscripts(user: AppUser, f: CallFilters, limit = 200) {
  const where = await visibleWhere(user);
  if (!where) return null;
  const conds: SQL[] = [where];
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, "\\$&")}%`;
    conds.push(or(ilike(s.transcripts.title, like), ilike(s.transcripts.rawText, like))!);
  }
  if (f.source) conds.push(eq(s.transcripts.source, f.source as (typeof s.transcriptSource.enumValues)[number]));
  if (f.status) conds.push(eq(s.transcripts.status, f.status as (typeof s.processingStatus.enumValues)[number]));
  if (f.dealId) conds.push(eq(s.transcripts.dealId, f.dealId));
  const rows = await db
    .select({
      id: s.transcripts.id,
      title: s.transcripts.title,
      source: s.transcripts.source,
      occurredAt: s.transcripts.occurredAt,
      createdAt: s.transcripts.createdAt,
      durationMin: s.transcripts.durationMin,
      status: s.transcripts.status,
      analysisEngine: s.transcripts.analysisEngine,
      appliedAt: s.transcripts.appliedAt,
      dealId: s.transcripts.dealId,
      accountName: s.accounts.name,
      uploadedBy: s.transcripts.uploadedBy,
      uploaderName: s.user.name,
    })
    .from(s.transcripts)
    .leftJoin(s.accounts, eq(s.accounts.id, s.transcripts.accountId))
    .leftJoin(s.user, eq(s.user.id, s.transcripts.uploadedBy))
    .where(and(...conds))
    .orderBy(sql`coalesce(${s.transcripts.occurredAt}, ${s.transcripts.createdAt}) desc`)
    .limit(limit);
  const names = await visibleDealNames(user, rows.map((r) => r.dealId));
  return rows.map((r) => ({ ...r, dealName: r.dealId ? (names.get(r.dealId) ?? null) : null }));
}
export type TranscriptListItem = NonNullable<Awaited<ReturnType<typeof listTranscripts>>>[number];

/** Transcript + analysis for the detail page, with edit rights. Null when not visible. */
export async function getTranscriptForUser(user: AppUser, id: string) {
  const where = await visibleWhere(user);
  if (!where) return null;
  const [t] = await db
    .select({ t: s.transcripts, accountName: s.accounts.name, uploaderName: s.user.name })
    .from(s.transcripts)
    .leftJoin(s.accounts, eq(s.accounts.id, s.transcripts.accountId))
    .leftJoin(s.user, eq(s.user.id, s.transcripts.uploadedBy))
    .where(and(eq(s.transcripts.id, id), where));
  if (!t) return null;
  const scope = await scopeFor(user, "calls", "view");
  const canEdit = t.t.uploadedBy === user.id || scope === "team" || scope === "all";
  let deal: { id: string; name: string; pipelineId: string; stageId: string; pipelineKey: string; stageName: string; muu: number | null; nextStep: string | null } | null = null;
  let stages: { id: string; name: string; category: string; sortOrder: number; requiresApproval: boolean }[] = [];
  if (t.t.dealId) {
    const dealWhere = await dealAccessWhere(user, "view");
    const [d] = await db
      .select({
        id: s.deals.id,
        name: s.deals.name,
        pipelineId: s.deals.pipelineId,
        stageId: s.deals.stageId,
        pipelineKey: s.pipelines.key,
        stageName: s.stages.name,
        muu: s.deals.muu,
        nextStep: s.deals.nextStep,
      })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
      .where(and(eq(s.deals.id, t.t.dealId), dealWhere));
    deal = d ?? null;
    if (deal) {
      stages = await db
        .select({ id: s.stages.id, name: s.stages.name, category: s.stages.category, sortOrder: s.stages.sortOrder, requiresApproval: s.stages.requiresApproval })
        .from(s.stages)
        .where(eq(s.stages.pipelineId, deal.pipelineId))
        .orderBy(s.stages.sortOrder);
    }
  }
  const [meeting] = t.t.meetingId
    ? await db.select({ id: s.meetings.id, title: s.meetings.title, startsAt: s.meetings.startsAt, attendees: s.meetings.attendees }).from(s.meetings).where(eq(s.meetings.id, t.t.meetingId))
    : [];
  return {
    transcript: t.t,
    analysis: (t.t.analysis as (TranscriptAnalysis & { analyzedAt?: string; applied?: { at: string; by: string; taskIds: string[] }[] }) | null) ?? null,
    accountName: t.accountName,
    uploaderName: t.uploaderName,
    canEdit,
    deal,
    stages,
    meeting: meeting ?? null,
  };
}
export type TranscriptDetail = NonNullable<Awaited<ReturnType<typeof getTranscriptForUser>>>;

/** CALL-8 helper for the Calls page: your external meetings that ended in the last 7 days without notes. */
export async function meetingsMissingNotes(user: AppUser) {
  const now = new Date();
  const rows = await db
    .select({ id: s.meetings.id, title: s.meetings.title, startsAt: s.meetings.startsAt, endsAt: s.meetings.endsAt, dealId: s.meetings.dealId, attendees: s.meetings.attendees })
    .from(s.meetings)
    .where(
      and(
        eq(s.meetings.ownerId, user.id),
        isNull(s.meetings.transcriptId),
        lte(s.meetings.endsAt, now),
        gte(s.meetings.endsAt, new Date(now.getTime() - 7 * 86_400_000)),
      ),
    )
    .orderBy(desc(s.meetings.endsAt))
    .limit(8);
  return rows;
}

/**
 * Deep link target for a meeting (alerts link to /calls?meeting=<id>): its transcript when one exists, otherwise the
 * upload form prefilled for that meeting. Only the meeting owner (or someone who can see the transcript) gets a link.
 */
export async function meetingLinkTarget(user: AppUser, meetingId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(meetingId)) return null;
  const [m] = await db.select({ ownerId: s.meetings.ownerId, transcriptId: s.meetings.transcriptId }).from(s.meetings).where(eq(s.meetings.id, meetingId));
  if (!m) return null;
  if (m.transcriptId && (await getTranscriptForUser(user, m.transcriptId))) return `/calls/${m.transcriptId}`;
  if (m.ownerId === user.id) return `/calls/upload?meetingId=${meetingId}`;
  return null;
}
