import "server-only";
import { cache } from "react";
import { and, asc, desc, eq, ilike, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealValue } from "@/lib/pipeline-math";
import { can, dealAccessWhere, dealModule, getMatrix, inScope, ownedEntityWhere, scopeFor, type AppUser } from "@/lib/rbac/server";
import { SCOPE_RANK } from "@/lib/rbac/model";
import { filledKeys, GATE_FIELDS } from "./gates";
import { hiddenDealFields, stripHidden } from "./service";
import { parseStoredSummary } from "./summary-core";
import { allLimited } from "./concurrency";
import { coverageGaps } from "./rules";
import type { BoardDeal, BoardFilters, ContactLite, PipelineDTO, Picklist, StageCategory, StageDTO, UserLite } from "./types";

const DAY = 86_400_000;

/* ───────────── Pipelines & stages ───────────── */

function toPipelineDTO(p: typeof s.pipelines.$inferSelect): PipelineDTO {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    type: p.type,
    unit: p.unit,
    color: p.color,
    usdPerMuu: p.usdPerMuu,
    defaultRevSharePct: p.defaultRevSharePct,
    description: p.description,
  };
}

export const getAllPipelines = cache(async () => {
  const rows = await db.select().from(s.pipelines).where(eq(s.pipelines.active, true)).orderBy(asc(s.pipelines.sortOrder));
  return rows.map(toPipelineDTO);
});

export const getStagesByPipeline = cache(async (): Promise<Record<string, StageDTO[]>> => {
  const rows = await db.select().from(s.stages).orderBy(asc(s.stages.sortOrder));
  const out: Record<string, StageDTO[]> = {};
  for (const r of rows) {
    (out[r.pipelineId] ??= []).push({
      id: r.id,
      key: r.key,
      name: r.name,
      sortOrder: r.sortOrder,
      probability: r.probability,
      category: r.category,
      slaDays: r.slaDays,
      requiredFields: r.requiredFields,
    });
  }
  return out;
});

export type PipelinePerms = { canView: boolean; canCreate: boolean; canEdit: boolean; canAssign: boolean; canExport: boolean; canDelete: boolean };

export async function pipelinePerms(user: AppUser, key: string): Promise<PipelinePerms> {
  const m = (await getMatrix(user.role))[dealModule(key)] ?? {};
  const ok = (a: keyof typeof m) => SCOPE_RANK[m[a] ?? "none"] > 0;
  return { canView: ok("view"), canCreate: ok("create"), canEdit: ok("edit"), canAssign: ok("assign"), canExport: ok("export"), canDelete: ok("delete") };
}

/** Pipelines the user may view (matrix view scope ≠ none), with permissions. */
export async function listVisiblePipelines(user: AppUser): Promise<(PipelineDTO & { perms: PipelinePerms })[]> {
  const pipes = await getAllPipelines();
  const out = [];
  for (const p of pipes) {
    const perms = await pipelinePerms(user, p.key);
    if (perms.canView) out.push({ ...p, perms });
  }
  return out;
}

/* ───────────── Overview (/pipelines) ───────────── */

export type PipelineOverview = PipelineDTO & {
  perms: PipelinePerms;
  openCount: number;
  wonCount: number;
  overdueCount: number;
  muu: number;
  grossUsd: number;
  netUsd?: number;
  weightedUsd: number;
  liveCount: number; // activation motions
};

export async function pipelineOverview(user: AppUser): Promise<PipelineOverview[]> {
  // Sequential on purpose: see ./concurrency.ts (pooler + pipelining).
  const visible = await listVisiblePipelines(user);
  const where = await dealAccessWhere(user, "view");
  const stagesBy = await getStagesByPipeline();
  const hidden = await hiddenDealFields(user.role);
  if (!visible.length) return [];
  const rows = await db
    .select({
      pipelineId: s.deals.pipelineId,
      stageId: s.deals.stageId,
      muu: s.deals.muu,
      usdPerMuu: s.deals.usdPerMuu,
      revSharePct: s.deals.revSharePct,
      contractValueCents: s.deals.contractValueCents,
      annualizedValueCents: s.deals.annualizedValueCents,
      probabilityOverride: s.deals.probabilityOverride,
      overrideStatus: s.deals.overrideStatus,
      nextStepDueAt: s.deals.nextStepDueAt,
    })
    .from(s.deals)
    .where(and(where, inArray(s.deals.pipelineId, visible.map((p) => p.id))));
  const now = Date.now();
  return visible.map((p) => {
    const stageMap = new Map((stagesBy[p.id] ?? []).map((st) => [st.id, st]));
    const acc = { openCount: 0, wonCount: 0, overdueCount: 0, muu: 0, grossUsd: 0, netUsd: 0, weightedUsd: 0, liveCount: 0 };
    for (const r of rows) {
      if (r.pipelineId !== p.id) continue;
      const st = stageMap.get(r.stageId);
      if (!st) continue;
      if (st.category === "won") {
        acc.wonCount++;
        if (p.unit === "activation") acc.liveCount++;
        continue;
      }
      if (st.category !== "open") continue;
      acc.openCount++;
      if (r.nextStepDueAt && r.nextStepDueAt.getTime() < now) acc.overdueCount++;
      const v = dealValue({
        unit: p.unit,
        muu: r.muu,
        usdPerMuu: r.usdPerMuu,
        pipelineUsdPerMuu: p.usdPerMuu,
        revSharePct: r.revSharePct,
        pipelineRevSharePct: p.defaultRevSharePct,
        contractValueCents: r.contractValueCents,
        annualizedValueCents: r.annualizedValueCents,
        stageProbability: st.probability,
        probabilityOverride: r.probabilityOverride,
        overrideStatus: r.overrideStatus,
      });
      acc.muu += v.muu;
      acc.grossUsd += v.grossUsd;
      acc.netUsd += v.netUsd;
      acc.weightedUsd += v.weightedGrossUsd;
    }
    const out: PipelineOverview = { ...p, ...acc };
    if (hidden.has("revSharePct")) delete out.netUsd;
    return out;
  });
}

/* ───────────── Board ───────────── */

function likeEscape(q: string) {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export async function getPipelineByKey(key: string): Promise<PipelineDTO | null> {
  const all = await getAllPipelines();
  return all.find((p) => p.key === key) ?? null;
}

/**
 * Deals on a pipeline board visible to `user` (dealAccessWhere + restricted access) with URL filters applied.
 * Hidden fields are stripped; values are computed with pipeline-math.
 */
export async function listDealsForBoard(user: AppUser, pipelineKey: string, filters: BoardFilters = {}): Promise<BoardDeal[]> {
  const pipeline = await getPipelineByKey(pipelineKey);
  if (!pipeline) return [];
  const where = await dealAccessWhere(user, "view");
  const stagesBy = await getStagesByPipeline();
  const hidden = await hiddenDealFields(user.role);
  const editScope = await scopeFor(user, dealModule(pipelineKey), "edit");
  const stages = stagesBy[pipeline.id] ?? [];
  const stageMap = new Map(stages.map((st) => [st.id, st]));
  const customGateKeys = Array.from(new Set(stages.flatMap((st) => st.requiredFields).filter((k) => !(k in GATE_FIELDS))));

  const conds: SQL[] = [where, eq(s.deals.pipelineId, pipeline.id)];
  if (filters.q) {
    const pat = likeEscape(filters.q);
    conds.push(or(ilike(s.deals.name, pat), ilike(s.accounts.name, pat), ilike(s.accounts.domain, pat))!);
  }
  if (filters.owner === "me") conds.push(eq(s.deals.ownerId, user.id));
  else if (filters.owner === "none") conds.push(isNull(s.deals.ownerId));
  else if (filters.owner) conds.push(eq(s.deals.ownerId, filters.owner));
  if (filters.priority === "none") conds.push(isNull(s.deals.priority));
  else if (filters.priority) conds.push(eq(s.deals.priority, filters.priority));
  if (filters.category) conds.push(eq(s.accounts.category, filters.category));
  if (filters.status) conds.push(eq(s.deals.status, filters.status));
  if (filters.overdue) conds.push(and(eq(s.deals.status, "open"), lt(s.deals.nextStepDueAt, new Date()))!);

  const owner = alias(s.user, "owner");
  const rows = await db
    .select({
      deal: s.deals,
      accountName: s.accounts.name,
      accountDomain: s.accounts.domain,
      accountCategory: s.accounts.category,
      ownerName: owner.name,
      ownerImage: owner.image,
    })
    .from(s.deals)
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .leftJoin(owner, eq(owner.id, s.deals.ownerId))
    .where(and(...conds))
    .orderBy(desc(s.deals.updatedAt))
    .limit(5000);

  // Splits for the pipeline via a join (no giant IN-list: large parameter sets stall the transaction pooler).
  const splits = rows.length
    ? await db
        .select({ dealId: s.dealSplits.dealId, userId: s.dealSplits.userId, pct: s.dealSplits.pct, name: s.user.name, image: s.user.image })
        .from(s.dealSplits)
        .innerJoin(s.deals, eq(s.deals.id, s.dealSplits.dealId))
        .innerJoin(s.user, eq(s.user.id, s.dealSplits.userId))
        .where(and(eq(s.deals.pipelineId, pipeline.id), isNull(s.deals.deletedAt)))
    : [];
  const splitsBy = new Map<string, typeof splits>();
  for (const sp of splits) (splitsBy.get(sp.dealId) ?? splitsBy.set(sp.dealId, []).get(sp.dealId)!).push(sp);

  const now = Date.now();
  return rows.flatMap((r) => {
    const d = r.deal;
    const st = stageMap.get(d.stageId);
    if (!st) return [];
    const ds = splitsBy.get(d.id) ?? [];
    const v = dealValue({
      unit: pipeline.unit,
      muu: d.muu,
      usdPerMuu: d.usdPerMuu,
      pipelineUsdPerMuu: pipeline.usdPerMuu,
      revSharePct: d.revSharePct,
      pipelineRevSharePct: pipeline.defaultRevSharePct,
      contractValueCents: d.contractValueCents,
      annualizedValueCents: d.annualizedValueCents,
      stageProbability: st.probability,
      probabilityOverride: d.probabilityOverride,
      overrideStatus: d.overrideStatus,
    });
    const owners: BoardDeal["owners"] = [];
    if (d.ownerId) owners.push({ id: d.ownerId, name: r.ownerName ?? "Unknown", image: r.ownerImage, pct: ds.find((x) => x.userId === d.ownerId)?.pct ?? null });
    for (const sp of ds) if (sp.userId !== d.ownerId) owners.push({ id: sp.userId, name: sp.name, image: sp.image, pct: sp.pct });
    const dueMs = d.nextStepDueAt?.getTime();
    const bd: BoardDeal = {
      id: d.id,
      name: d.name,
      pipelineKey,
      stageId: d.stageId,
      status: d.status,
      accountId: d.accountId,
      accountName: r.accountName,
      accountDomain: r.accountDomain,
      accountCategory: r.accountCategory,
      ownerId: d.ownerId,
      owners,
      priority: d.priority,
      nextStep: d.nextStep,
      nextStepDueAt: d.nextStepDueAt?.toISOString() ?? null,
      nextStepWaitingReason: d.nextStepWaitingReason,
      overdueDays: dueMs && st.category === "open" && dueMs < now ? Math.max(1, Math.floor((now - dueMs) / DAY)) : 0,
      daysInStage: Math.max(0, Math.floor((now - d.stageEnteredAt.getTime()) / DAY)),
      stageEnteredAt: d.stageEnteredAt.toISOString(),
      lastActivityAt: d.lastActivityAt?.toISOString() ?? null,
      healthScore: d.healthScore,
      healthExplanation: d.healthExplanation,
      restricted: d.restricted,
      muu: v.muu,
      grossUsd: v.grossUsd,
      netUsd: v.netUsd,
      weightedUsd: v.weightedGrossUsd,
      weightedMuu: v.weightedMuu,
      probability: v.probability,
      overridden: v.overridden,
      overridePending: d.overrideStatus === "pending",
      contractValueCents: d.contractValueCents,
      filled: filledKeys(d as unknown as Record<string, unknown>, customGateKeys),
      canEdit: inScope(user, editScope, { ownerId: d.ownerId, teamId: d.teamId, splitUserIds: ds.map((x) => x.userId), pipelineKey }),
      createdAt: d.createdAt.toISOString(),
    };
    if (hidden.has("revSharePct")) delete bd.netUsd;
    return [bd];
  });
}

/* ───────────── Single deal ───────────── */

export type VisibleDeal = Partial<typeof s.deals.$inferSelect> & Pick<typeof s.deals.$inferSelect, "id" | "name" | "pipelineId" | "stageId" | "status" | "restricted">;

/**
 * A deal row the user may view, with field-level-security fields removed — or null (use notFound()).
 * Reusable by other modules (Copilot tools, calls, proposals) for permission-checked lookups.
 */
export const getDealForUser = cache(async (
  user: AppUser,
  id: string,
): Promise<(VisibleDeal & { pipeline: PipelineDTO; stage: StageDTO; hiddenFields: string[] }) | null> => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const where = await dealAccessWhere(user, "view");
  const [row] = await db
    .select({ deal: s.deals, pipeline: s.pipelines, stage: s.stages })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .where(and(eq(s.deals.id, id), where));
  if (!row) return null;
  const hidden = await hiddenDealFields(user.role);
  return {
    ...stripHidden(row.deal as unknown as Record<string, unknown>, hidden),
    ...{ id: row.deal.id, name: row.deal.name, pipelineId: row.deal.pipelineId, stageId: row.deal.stageId, status: row.deal.status, restricted: row.deal.restricted },
    pipeline: toPipelineDTO(row.pipeline),
    stage: {
      id: row.stage.id,
      key: row.stage.key,
      name: row.stage.name,
      sortOrder: row.stage.sortOrder,
      probability: row.stage.probability,
      category: row.stage.category,
      slaDays: row.stage.slaDays,
      requiredFields: row.stage.requiredFields,
    },
    hiddenFields: [...hidden],
  };
});

/* ───────────── Lookups ───────────── */

export const listActiveUsers = cache(async (): Promise<UserLite[]> => {
  return db
    .select({ id: s.user.id, name: s.user.name, image: s.user.image })
    .from(s.user)
    .where(and(ne(s.user.role, "pending"), sql`coalesce(${s.user.banned}, false) = false`))
    .orderBy(asc(s.user.name));
});

/** Users `user` may assign deals in this pipeline to (assign scope). */
export async function assignableUsers(user: AppUser, pipelineKey: string): Promise<UserLite[]> {
  const scope = await scopeFor(user, dealModule(pipelineKey), "assign");
  const all = await listActiveUsers();
  if (scope === "all" || scope === "pipeline") return all;
  if (scope === "team") return all.filter((u) => user.teamMemberIds.includes(u.id));
  return all.filter((u) => u.id === user.id);
}

export const getPicklist = cache(async (list: string): Promise<Picklist> => {
  return db
    .select({ value: s.picklists.value, label: s.picklists.label })
    .from(s.picklists)
    .where(and(eq(s.picklists.list, list), eq(s.picklists.active, true)))
    .orderBy(asc(s.picklists.sortOrder));
});

/* ───────────── Record page bundle ───────────── */

export type DealDetail = NonNullable<Awaited<ReturnType<typeof getDealDetail>>>;

export async function getDealDetail(user: AppUser, id: string) {
  const deal = await getDealForUser(user, id);
  if (!deal) return null;
  const hidden = new Set(deal.hiddenFields);
  const [stagesBy, perms, splits, owner, account] = await allLimited([
    () => getStagesByPipeline(),
    () => pipelinePerms(user, deal.pipeline.key),
    () => db
      .select({ userId: s.dealSplits.userId, pct: s.dealSplits.pct, role: s.dealSplits.role, name: s.user.name, image: s.user.image })
      .from(s.dealSplits)
      .innerJoin(s.user, eq(s.user.id, s.dealSplits.userId))
      .where(eq(s.dealSplits.dealId, id)),
    () => deal.ownerId
      ? db.select({ id: s.user.id, name: s.user.name, image: s.user.image }).from(s.user).where(eq(s.user.id, deal.ownerId)).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    () => deal.accountId
      ? db
          .select({ id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain, website: s.accounts.website, category: s.accounts.category, muu: s.accounts.muu, type: s.accounts.type })
          .from(s.accounts)
          .where(eq(s.accounts.id, deal.accountId))
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ], 2);
  const stages = stagesBy[deal.pipelineId] ?? [];
  const editScope = await scopeFor(user, dealModule(deal.pipeline.key), "edit");
  const canEdit = inScope(user, editScope, { ownerId: deal.ownerId, teamId: deal.teamId, splitUserIds: splits.map((x) => x.userId), pipelineKey: deal.pipeline.key });

  const actor = alias(s.user, "actor");
  const assignee = alias(s.user, "assignee");
  const author = alias(s.user, "author");
  const contactWhere = await ownedEntityWhere(user, "contacts", "view", s.contacts.ownerId);

  const [activities, tasks, stakeholders, accountContacts, documents, comments, muuHistory, invoices, migration, approval, lostReasons, holdReasons, users, assignable, canTask, canLog, canUseAi, canCreateContact] =
    await allLimited([
      () => db
        .select({
          id: s.activities.id,
          type: s.activities.type,
          source: s.activities.source,
          subject: s.activities.subject,
          body: s.activities.body,
          direction: s.activities.direction,
          occurredAt: s.activities.occurredAt,
          durationMin: s.activities.durationMin,
          pinned: s.activities.pinned,
          metadata: s.activities.metadata,
          actorId: s.activities.actorId,
          actorName: actor.name,
          actorImage: actor.image,
          contactName: s.contacts.fullName,
        })
        .from(s.activities)
        .leftJoin(actor, eq(actor.id, s.activities.actorId))
        .leftJoin(s.contacts, eq(s.contacts.id, s.activities.contactId))
        .where(eq(s.activities.dealId, id))
        .orderBy(desc(s.activities.pinned), desc(s.activities.occurredAt))
        .limit(150),
      () => db
        .select({
          id: s.tasks.id,
          title: s.tasks.title,
          description: s.tasks.description,
          status: s.tasks.status,
          priority: s.tasks.priority,
          dueAt: s.tasks.dueAt,
          origin: s.tasks.origin,
          owedBy: s.tasks.owedBy,
          evidence: s.tasks.evidence,
          evidenceSource: s.tasks.evidenceSource,
          completedAt: s.tasks.completedAt,
          assigneeId: s.tasks.assigneeId,
          assigneeName: assignee.name,
        })
        .from(s.tasks)
        .leftJoin(assignee, eq(assignee.id, s.tasks.assigneeId))
        .where(and(eq(s.tasks.dealId, id), ne(s.tasks.status, "cancelled")))
        .orderBy(asc(s.tasks.status), asc(s.tasks.dueAt))
        .limit(100),
      () => db
        .select({
          contactId: s.contacts.id,
          name: s.contacts.fullName,
          title: s.contacts.title,
          email: s.contacts.email,
          status: s.contacts.status,
          role: s.dealContacts.role,
          lastContactedAt: s.contacts.lastContactedAt,
        })
        .from(s.dealContacts)
        .innerJoin(s.contacts, eq(s.contacts.id, s.dealContacts.contactId))
        .where(and(eq(s.dealContacts.dealId, id), isNull(s.contacts.deletedAt))),
      () => deal.accountId
        ? db
            .select({ id: s.contacts.id, name: s.contacts.fullName, title: s.contacts.title, email: s.contacts.email })
            .from(s.contacts)
            .where(and(eq(s.contacts.accountId, deal.accountId), isNull(s.contacts.deletedAt), contactWhere))
            .orderBy(asc(s.contacts.fullName))
            .limit(200)
        : Promise.resolve([] as ContactLite[]),
      () => db.select().from(s.documents).where(eq(s.documents.dealId, id)).orderBy(desc(s.documents.createdAt)),
      () => db
        .select({ id: s.comments.id, body: s.comments.body, createdAt: s.comments.createdAt, authorId: s.comments.authorId, authorName: author.name, authorImage: author.image })
        .from(s.comments)
        .leftJoin(author, eq(author.id, s.comments.authorId))
        .where(and(eq(s.comments.entity, "deal"), eq(s.comments.entityId, id)))
        .orderBy(asc(s.comments.createdAt))
        .limit(200),
      () => deal.pipeline.unit === "muu" && deal.accountId
        ? db
            .select({ id: s.audienceMetrics.id, metric: s.audienceMetrics.metric, value: s.audienceMetrics.value, derivedMuu: s.audienceMetrics.derivedMuu, period: s.audienceMetrics.period, source: s.audienceMetrics.source, confidence: s.audienceMetrics.confidence, rawValue: s.audienceMetrics.rawValue, createdAt: s.audienceMetrics.createdAt })
            .from(s.audienceMetrics)
            .where(eq(s.audienceMetrics.accountId, deal.accountId))
            .orderBy(asc(s.audienceMetrics.period), asc(s.audienceMetrics.createdAt))
            .limit(60)
        : Promise.resolve([]),
      () => deal.pipeline.key === "ADS" ? db.select().from(s.invoices).where(eq(s.invoices.dealId, id)).orderBy(asc(s.invoices.dueAt)) : Promise.resolve([]),
      () => db.select({ id: s.migrationProjects.id, stage: s.migrationProjects.stage, name: s.migrationProjects.name }).from(s.migrationProjects).where(eq(s.migrationProjects.dealId, id)).then((r) => r[0] ?? null),
      () => db
        .select()
        .from(s.approvals)
        .where(and(eq(s.approvals.kind, "probability_override"), eq(s.approvals.entity, "deal"), eq(s.approvals.entityId, id), eq(s.approvals.status, "pending")))
        .orderBy(desc(s.approvals.createdAt))
        .then((r) => r[0] ?? null),
      () => getPicklist("lost_reason"),
      () => getPicklist("hold_reason"),
      () => listActiveUsers(),
      () => assignableUsers(user, deal.pipeline.key),
      () => can(user, "tasks", "create"),
      () => can(user, "activities", "create"),
      () => can(user, "copilot", "use_ai"),
      () => can(user, "contacts", "create"),
    ], 2);

  const v = dealValue({
    unit: deal.pipeline.unit,
    muu: deal.muu,
    usdPerMuu: deal.usdPerMuu,
    pipelineUsdPerMuu: deal.pipeline.usdPerMuu,
    revSharePct: hidden.has("revSharePct") ? null : deal.revSharePct,
    pipelineRevSharePct: deal.pipeline.defaultRevSharePct,
    contractValueCents: deal.contractValueCents,
    annualizedValueCents: deal.annualizedValueCents,
    stageProbability: deal.stage.probability,
    probabilityOverride: deal.probabilityOverride,
    overrideStatus: deal.overrideStatus,
  });
  const customGateKeys = Array.from(new Set(stages.flatMap((st) => st.requiredFields).filter((k) => !(k in GATE_FIELDS))));
  const now = Date.now();
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

  return {
    deal: {
      id: deal.id,
      name: deal.name,
      status: deal.status as StageCategory,
      restricted: deal.restricted,
      priority: deal.priority ?? null,
      source: deal.source ?? null,
      ownerId: deal.ownerId ?? null,
      primaryContactId: deal.primaryContactId ?? null,
      nextStep: deal.nextStep ?? null,
      nextStepDueAt: iso(deal.nextStepDueAt),
      nextStepWaitingReason: deal.nextStepWaitingReason ?? null,
      expectedCloseDate: iso(deal.expectedCloseDate),
      stageEnteredAt: iso(deal.stageEnteredAt)!,
      daysInStage: Math.max(0, Math.floor((now - (deal.stageEnteredAt?.getTime() ?? now)) / DAY)),
      overdueDays:
        deal.status === "open" && deal.nextStepDueAt && deal.nextStepDueAt.getTime() < now ? Math.max(1, Math.floor((now - deal.nextStepDueAt.getTime()) / DAY)) : 0,
      lastActivityAt: iso(deal.lastActivityAt),
      createdAt: iso(deal.createdAt)!,
      wonAt: iso(deal.wonAt),
      lostAt: iso(deal.lostAt),
      lostReason: deal.lostReason ?? null,
      holdReason: deal.holdReason ?? null,
      healthScore: deal.healthScore ?? null,
      healthExplanation: deal.healthExplanation ?? null,
      probabilityOverride: deal.probabilityOverride ?? null,
      overrideReason: deal.overrideReason ?? null,
      overrideStatus: deal.overrideStatus ?? null,
      // value fields (hidden ones become undefined)
      muu: deal.muu ?? null,
      usdPerMuu: deal.usdPerMuu ?? null,
      revSharePct: hidden.has("revSharePct") ? undefined : (deal.revSharePct ?? null),
      guaranteeType: hidden.has("guaranteeType") ? undefined : (deal.guaranteeType ?? null),
      guaranteeMonthlyCents: hidden.has("guaranteeMonthlyCents") ? undefined : (deal.guaranteeMonthlyCents ?? null),
      rampMonths: hidden.has("rampMonths") ? undefined : (deal.rampMonths ?? null),
      termYears: hidden.has("termYears") ? undefined : (deal.termYears ?? null),
      contractValueCents: deal.contractValueCents ?? null,
      annualizedValueCents: deal.annualizedValueCents ?? null,
      nextPaymentCents: deal.nextPaymentCents ?? null,
      nextPaymentAt: iso(deal.nextPaymentAt),
      renewalAt: iso(deal.renewalAt),
      r100: deal.r100 ?? {},
      tags: deal.tags ?? [],
      aiSummary: parseStoredSummary(deal.aiSummary),
      aiSummaryAt: iso(deal.aiSummaryAt),
      filled: filledKeys(deal as unknown as Record<string, unknown>, customGateKeys),
    },
    pipeline: deal.pipeline,
    stage: deal.stage,
    stages,
    account,
    owner,
    splits,
    value: {
      muu: v.muu,
      grossUsd: v.grossUsd,
      netUsd: hidden.has("revSharePct") ? undefined : v.netUsd,
      weightedGrossUsd: v.weightedGrossUsd,
      weightedNetUsd: hidden.has("revSharePct") ? undefined : v.weightedNetUsd,
      probability: v.probability,
      stageProbability: deal.stage.probability,
      overridden: v.overridden,
    },
    activities: activities.map((a) => {
      const isPrivate = (a.metadata as { private?: boolean } | null)?.private === true && a.actorId !== user.id;
      return { ...a, body: isPrivate ? null : a.body, metadata: undefined, occurredAt: a.occurredAt.toISOString(), private: isPrivate };
    }),
    tasks: tasks.map((t) => ({ ...t, dueAt: iso(t.dueAt), completedAt: iso(t.completedAt), overdue: t.status === "open" && !!t.dueAt && t.dueAt.getTime() < now })),
    stakeholders: stakeholders.map((c) => ({ ...c, lastContactedAt: iso(c.lastContactedAt), isPrimary: c.contactId === deal.primaryContactId })),
    coverageGaps: coverageGaps(stakeholders.map((c) => c.role)),
    accountContacts: accountContacts as ContactLite[],
    documents: documents.map((d) => ({
      id: d.id,
      type: d.type,
      name: d.name,
      url: d.url,
      status: d.status,
      version: d.version,
      signedAt: iso(d.signedAt),
      expiresAt: iso(d.expiresAt),
      createdAt: iso(d.createdAt)!,
      expiringSoon: !!d.expiresAt && d.expiresAt.getTime() - now < 30 * DAY,
    })),
    comments: comments.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
    muuHistory: muuHistory.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    invoices: invoices.map((i) => ({ id: i.id, amountCents: i.amountCents, dueAt: i.dueAt.toISOString(), status: i.status, paidAt: iso(i.paidAt) })),
    migration,
    pendingApproval: approval ? { id: approval.id, createdAt: approval.createdAt.toISOString(), payload: approval.payload } : null,
    picklists: { lost_reason: lostReasons, hold_reason: holdReasons },
    users,
    assignable,
    perms: {
      canEdit,
      canAssign: perms.canAssign && canEdit,
      canCreateTask: canTask && canEdit,
      canLog: canLog,
      canUseAi,
      canCreateContact: canCreateContact && canEdit,
      canComment: true,
      isApprover: user.role === "executive" || user.role === "super_admin",
    },
    hiddenFields: [...hidden],
    currentUserId: user.id,
  };
}

/** "Can create a deal somewhere?" — pipelines where the user has create scope. */
export async function creatablePipelines(user: AppUser) {
  const visible = await listVisiblePipelines(user);
  const stagesBy = await getStagesByPipeline();
  return visible
    .filter((p) => p.perms.canCreate)
    .map((p) => ({ ...p, stages: (stagesBy[p.id] ?? []).filter((st) => st.category === "open") }));
}
export type CreatablePipeline = Awaited<ReturnType<typeof creatablePipelines>>[number];

/** Props for <CreateDealButton>: creatable pipelines (open stages only) + assignable owners per pipeline. */
export async function createDealProps(user: AppUser) {
  const pipelines = await creatablePipelines(user);
  const assignable: Record<string, UserLite[]> = {};
  for (const p of pipelines) assignable[p.key] = await assignableUsers(user, p.key);
  return { pipelines: pipelines.map((p) => ({ id: p.id, key: p.key, name: p.name, type: p.type, unit: p.unit, color: p.color, usdPerMuu: p.usdPerMuu, defaultRevSharePct: p.defaultRevSharePct, description: p.description, stages: p.stages })), assignable, currentUserId: user.id };
}

/** Distinct account categories among the user's visible deals in a pipeline (board filter options). */
export async function boardCategories(user: AppUser, pipelineId: string): Promise<string[]> {
  const where = await dealAccessWhere(user, "view");
  const rows = await db
    .selectDistinct({ c: s.accounts.category })
    .from(s.deals)
    .innerJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .where(and(where, eq(s.deals.pipelineId, pipelineId)))
    .orderBy(asc(s.accounts.category));
  return rows.map((r) => r.c).filter((c): c is string => !!c);
}
