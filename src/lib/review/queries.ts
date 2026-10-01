import "server-only";
import { and, asc, desc, eq, exists, gte, inArray, isNull, like, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { getPicklist, listVisiblePipelines } from "@/lib/deals/queries";
import { hiddenDealFields } from "@/lib/deals/service";
import { dealValue } from "@/lib/pipeline-math";
import { PIPELINE_COLORS } from "@/lib/palette";
import { dealAccessWhere, scopeFor, type AppUser } from "@/lib/rbac/server";
import { formatInTz } from "@/lib/time";
import { activeUserWhere, ownerFilterOptions } from "@/lib/users";
import type { ReviewScope } from "./scope";
import { detectExceptions, foldBulkOverrides, LOW_HEALTH, rankForReview, valueBeforeFromAudit, WINDOW_DAYS, type CloseDatePush, type Decision, type DealException } from "./core";

const DAY = 86_400_000;
/** Max open deals scanned for exceptions, and max deals in one walk-through. */
export const SCAN_LIMIT = 3000;
export const SESSION_LIMIT = 100;
const VALUE_KEYS = ["muu", "usdPerMuu", "contractValueCents", "annualizedValueCents"] as const;

export type { ReviewScope };

export type ScopeOptions = {
  analyticsScope: "none" | "own" | "team" | "pipeline" | "all";
  pipelines: { key: string; name: string; color: string }[];
  teams: { id: string; name: string }[];
  owners: { id: string; name: string }[];
};

/** Owner ids the user's analytics scope limits review to (null = no limit beyond deal access). */
function ownerRestriction(user: AppUser, scope: ScopeOptions["analyticsScope"]): string[] | null {
  if (scope === "own") return [user.id];
  if (scope === "team") return user.teamMemberIds.length ? user.teamMemberIds : [user.id];
  return null;
}

export async function reviewScopeOptions(user: AppUser): Promise<ScopeOptions> {
  const analyticsScope = await scopeFor(user, "analytics", "view");
  if (analyticsScope === "none") return { analyticsScope, pipelines: [], teams: [], owners: [] };
  const [pipes, teamRows, people] = await Promise.all([
    listVisiblePipelines(user),
    db.select({ id: s.teams.id, name: s.teams.name }).from(s.teams).orderBy(asc(s.teams.name)),
    ownerFilterOptions(),
  ]);
  const restrict = ownerRestriction(user, analyticsScope);
  return {
    analyticsScope,
    pipelines: pipes.map((p) => ({ key: p.key, name: p.name, color: PIPELINE_COLORS[p.key] ?? p.color })),
    teams: analyticsScope === "all" || analyticsScope === "pipeline" ? teamRows : teamRows.filter((t) => t.id === user.teamId),
    owners: (restrict ? people.filter((p) => restrict.includes(p.id)) : people).map((p) => ({ id: p.id, name: p.name })),
  };
}

/** Sanitize a requested scope against the options (unknown keys/ids are dropped). */
export function sanitizeScope(req: Partial<ReviewScope>, opts: ScopeOptions): ReviewScope {
  const keys = new Set(opts.pipelines.map((p) => p.key));
  const teams = new Set(opts.teams.map((t) => t.id));
  const owners = new Set(opts.owners.map((o) => o.id));
  return {
    pipelineKeys: [...new Set(req.pipelineKeys ?? [])].filter((k) => keys.has(k)).slice(0, 10),
    teamId: req.teamId && teams.has(req.teamId) ? req.teamId : null,
    ownerIds: [...new Set(req.ownerIds ?? [])].filter((id) => owners.has(id)).slice(0, 50),
  };
}

export type ReviewRow = {
  id: string;
  name: string;
  accountName: string | null;
  pipelineKey: string;
  pipelineColor: string;
  stageName: string;
  ownerId: string | null;
  ownerName: string | null;
  valueUsd: number | null;
  healthScore: number | null;
  restricted: boolean;
  exceptions: DealException[];
};

async function scopedDealsWhere(user: AppUser, scope: ReviewScope, analyticsScope: ScopeOptions["analyticsScope"]): Promise<SQL> {
  const conds: SQL[] = [await dealAccessWhere(user, "view"), eq(s.deals.status, "open")];
  if (scope.pipelineKeys.length) conds.push(inArray(s.pipelines.key, scope.pipelineKeys));
  const restrict = ownerRestriction(user, analyticsScope);
  if (restrict) conds.push(inArray(s.deals.ownerId, restrict));
  if (scope.ownerIds.length) conds.push(inArray(s.deals.ownerId, scope.ownerIds));
  if (scope.teamId) {
    const owner = alias(s.user, "team_owner");
    conds.push(
      sql`(${s.deals.teamId} = ${scope.teamId} or ${exists(db.select({ x: sql`1` }).from(owner).where(and(eq(owner.id, s.deals.ownerId), eq(owner.teamId, scope.teamId))))})`,
    );
  }
  return and(...conds)!;
}

type AuditRow = { entityId: string | null; before: unknown; after: unknown; createdAt: Date };

/** Deal audit rows of the last `days` days for these deals (chunked; uses the (entity, entity_id) index). */
async function recentDealAudits(dealIds: string[], since: Date): Promise<Map<string, AuditRow[]>> {
  const out = new Map<string, AuditRow[]>();
  for (let i = 0; i < dealIds.length; i += 500) {
    const chunk = dealIds.slice(i, i + 500);
    const rows = await db
      .select({ entityId: s.auditLog.entityId, before: s.auditLog.before, after: s.auditLog.after, createdAt: s.auditLog.createdAt })
      .from(s.auditLog)
      .where(and(eq(s.auditLog.entity, "deal"), inArray(s.auditLog.entityId, chunk), gte(s.auditLog.createdAt, since), like(s.auditLog.action, "deal.%")))
      .orderBy(asc(s.auditLog.createdAt))
      .limit(5000);
    for (const r of rows) if (r.entityId) (out.get(r.entityId) ?? out.set(r.entityId, []).get(r.entityId)!).push(r);
  }
  return out;
}

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asDate = (v: unknown): Date | null => {
  if (v == null || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Close-date pushes and the earliest "before" of each value field, from a deal's audit rows (oldest first). */
function auditSignals(rows: AuditRow[]): { pushes: CloseDatePush[]; earliestValueBefore: Record<string, unknown> } {
  const pushes: CloseDatePush[] = [];
  const earliestValueBefore: Record<string, unknown> = {};
  for (const r of rows) {
    const before = asObj(r.before);
    const after = asObj(r.after);
    if ("expectedCloseDate" in after) pushes.push({ from: asDate(before.expectedCloseDate), to: asDate(after.expectedCloseDate), at: r.createdAt });
    for (const k of VALUE_KEYS) if (k in after && k in before && !(k in earliestValueBefore)) earliestValueBefore[k] = before[k];
  }
  return { pushes, earliestValueBefore };
}

const dealCols = {
  id: s.deals.id,
  name: s.deals.name,
  status: s.deals.status,
  ownerId: s.deals.ownerId,
  restricted: s.deals.restricted,
  stageEnteredAt: s.deals.stageEnteredAt,
  expectedCloseDate: s.deals.expectedCloseDate,
  nextStep: s.deals.nextStep,
  nextStepDueAt: s.deals.nextStepDueAt,
  nextStepWaitingReason: s.deals.nextStepWaitingReason,
  healthScore: s.deals.healthScore,
  overrideStatus: s.deals.overrideStatus,
  muu: s.deals.muu,
  usdPerMuu: s.deals.usdPerMuu,
  contractValueCents: s.deals.contractValueCents,
  annualizedValueCents: s.deals.annualizedValueCents,
  pipelineKey: s.pipelines.key,
  pipelineColor: s.pipelines.color,
  unit: s.pipelines.unit,
  pipelineUsdPerMuu: s.pipelines.usdPerMuu,
  stageName: s.stages.name,
  stageCategory: s.stages.category,
  slaDays: s.stages.slaDays,
  stageProbability: s.stages.probability,
  accountName: s.accounts.name,
  ownerName: s.user.name,
};

function classify(r: DealRowRaw, audits: AuditRow[] | undefined, now: Date, valueHidden: boolean) {
  const valueInput = {
    unit: r.unit,
    muu: r.muu,
    usdPerMuu: r.usdPerMuu,
    pipelineUsdPerMuu: r.pipelineUsdPerMuu,
    contractValueCents: r.contractValueCents,
    annualizedValueCents: r.annualizedValueCents,
    stageProbability: r.stageProbability,
  };
  const valueUsd = dealValue(valueInput).grossUsd;
  const sig = auditSignals(audits ?? []);
  const exceptions = detectExceptions(
    {
      stageCategory: r.stageCategory,
      stageEnteredAt: r.stageEnteredAt,
      slaDays: r.slaDays,
      expectedCloseDate: r.expectedCloseDate,
      nextStep: r.nextStep,
      nextStepDueAt: r.nextStepDueAt,
      nextStepWaitingReason: r.nextStepWaitingReason,
      healthScore: r.healthScore,
      overrideStatus: r.overrideStatus,
      valueUsd,
      closeDatePushes: sig.pushes,
      valueBeforeUsd: valueHidden ? null : valueBeforeFromAudit(valueInput, sig.earliestValueBefore),
    },
    now,
  );
  return { valueUsd, exceptions, pushes: sig.pushes };
}

function dealQuery() {
  return db
    .select(dealCols)
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .leftJoin(s.user, eq(s.user.id, s.deals.ownerId));
}

type DealRowRaw = Awaited<ReturnType<typeof dealQuery>>[number];

const isValueHidden = (hidden: Set<string>) => VALUE_KEYS.some((k) => hidden.has(k)) || hidden.has("*");

/**
 * SQL pre-filter: open deals that *may* have an exception (the pure detectExceptions has the final word). Keeps the scan
 * small and complete on large books — only these candidates are loaded and classified.
 */
function candidateWhere(now: Date, since: Date): SQL {
  const n = sql`${now.toISOString()}::timestamptz`;
  return sql`(
    (${s.stages.slaDays} > 0 and ${s.deals.stageEnteredAt} < ${n} - make_interval(days => ${s.stages.slaDays}))
    or ${s.deals.expectedCloseDate} < ${n}
    or ((${s.deals.nextStep} is null or btrim(${s.deals.nextStep}) = '' or ${s.deals.nextStepDueAt} is null) and coalesce(btrim(${s.deals.nextStepWaitingReason}), '') = '')
    or ${s.deals.nextStepDueAt} < ${n}
    or ${s.deals.healthScore} < ${LOW_HEALTH}
    or ${s.deals.overrideStatus} = 'pending'
    or exists (select 1 from ${s.auditLog} where ${s.auditLog.entity} = 'deal' and ${s.auditLog.entityId} = ${s.deals.id}::text
               and ${s.auditLog.createdAt} >= ${since.toISOString()}::timestamptz and ${s.auditLog.action} like 'deal.%')
  )`;
}

/**
 * The exception list for a scope: open, visible deals with ≥ 1 exception, ranked for the walk-through.
 * `scanned` = open deals in scope; `truncated` = more than SCAN_LIMIT candidates (only the first were classified).
 */
export async function buildExceptionList(
  user: AppUser,
  scope: ReviewScope,
  now = new Date(),
): Promise<{ rows: ReviewRow[]; scanned: number; truncated: boolean; bulkOverrides: { approvalId: string; deals: number }[] }> {
  const analyticsScope = await scopeFor(user, "analytics", "view");
  if (analyticsScope === "none") return { rows: [], scanned: 0, truncated: false, bulkOverrides: [] };
  const where = await scopedDealsWhere(user, scope, analyticsScope);
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY);
  const [raw, [total]] = await Promise.all([
    dealQuery()
      .where(and(where, candidateWhere(now, since)))
      .orderBy(asc(s.deals.healthScore), asc(s.deals.id))
      .limit(SCAN_LIMIT + 1),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .where(where),
  ]);
  const truncated = raw.length > SCAN_LIMIT;
  const deals = raw.slice(0, SCAN_LIMIT);
  const [audits, hidden] = await Promise.all([recentDealAudits(deals.map((d) => d.id), since), hiddenDealFields(user.role)]);
  const valueHidden = isValueHidden(hidden);
  const rows = deals.map((r) => {
    const c = classify(r, audits.get(r.id), now, valueHidden);
    return {
      id: r.id,
      name: r.name,
      accountName: r.accountName,
      pipelineKey: r.pipelineKey,
      pipelineColor: PIPELINE_COLORS[r.pipelineKey] ?? r.pipelineColor,
      stageName: r.stageName,
      ownerId: r.ownerId,
      ownerName: r.ownerName,
      valueUsd: valueHidden ? null : c.valueUsd,
      healthScore: r.healthScore,
      restricted: r.restricted,
      exceptions: c.exceptions,
      // ranking only (never sent when hidden)
      _rank: c.valueUsd,
    };
  });
  const folded = foldBulkOverrides(rows, await bulkOverrideDeals(rows.filter((r) => r.exceptions.some((e) => e.kind === "pending_override")).map((r) => r.id)));
  const ranked = rankForReview(folded.rows.map((r) => ({ ...r, valueUsd: r._rank })));
  return {
    rows: ranked.map(({ _rank, ...r }) => ({ ...r, valueUsd: valueHidden ? null : _rank })),
    scanned: total?.n ?? deals.length,
    truncated,
    bulkOverrides: folded.bulk,
  };
}

/** dealId → id of the pending BULK probability_override approval covering it (payload.dealIds). One small query. */
async function bulkOverrideDeals(dealIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!dealIds.length) return out;
  const want = new Set(dealIds);
  const rows = await db
    .select({ id: s.approvals.id, payload: s.approvals.payload })
    .from(s.approvals)
    .where(and(eq(s.approvals.kind, "probability_override"), eq(s.approvals.status, "pending"), sql`jsonb_typeof(${s.approvals.payload}->'dealIds') = 'array'`));
  for (const r of rows) {
    const ids = Array.isArray((r.payload as { dealIds?: unknown } | null)?.dealIds) ? ((r.payload as { dealIds: unknown[] }).dealIds as unknown[]) : [];
    for (const id of ids) if (typeof id === "string" && want.has(id) && !out.has(id)) out.set(id, r.id);
  }
  return out;
}

/* ───────────── Sessions ───────────── */

export type SessionRow = typeof s.reviewSessions.$inferSelect;

export async function listMySessions(user: AppUser, limit = 8) {
  return db
    .select({
      id: s.reviewSessions.id,
      title: s.reviewSessions.title,
      startedAt: s.reviewSessions.startedAt,
      endedAt: s.reviewSessions.endedAt,
      dealCount: sql<number>`cardinality(${s.reviewSessions.dealIds})::int`,
      decisionCount: sql<number>`jsonb_array_length(${s.reviewSessions.decisions})::int`,
    })
    .from(s.reviewSessions)
    .where(eq(s.reviewSessions.facilitatorId, user.id))
    .orderBy(desc(s.reviewSessions.startedAt))
    .limit(limit);
}

/** Only the facilitator (or a super admin) can open a session. */
export async function getSessionForUser(user: AppUser, id: string): Promise<SessionRow | null> {
  const [row] = await db.select().from(s.reviewSessions).where(eq(s.reviewSessions.id, id));
  if (!row) return null;
  if (row.facilitatorId !== user.id && user.role !== "super_admin") return null;
  return row;
}

export type WalkDeal = {
  id: string;
  name: string;
  accountName: string | null;
  pipelineKey: string;
  pipelineName: string;
  pipelineColor: string;
  stageName: string;
  ownerId: string | null;
  ownerName: string | null;
  valueUsd: number | null;
  healthScore: number | null;
  healthExplanation: string | null;
  summary: string | null;
  nextStep: string | null;
  nextStepDueAt: string | null; // YYYY-MM-DD in the viewer's zone
  nextStepDueLabel: string | null;
  expectedCloseDate: string | null; // YYYY-MM-DD
  expectedCloseLabel: string | null;
  daysInStage: number;
  slaDays: number | null;
  lastActivityLabel: string | null;
  openTasks: number;
  overdueTasks: number;
  restricted: boolean;
  exceptions: DealException[];
  changes: { at: string; label: string; text: string }[];
  lostStageId: string | null;
  escalateTo: { id: string; name: string; hint: string }[];
};

export type WalkData = {
  deals: WalkDeal[];
  missing: number; // deals in the snapshot the user can no longer see (deleted / access removed)
  lostReasons: { value: string; label: string }[];
};

/** Everything the walk-through needs for the session's deals, permission-filtered and field-stripped. */
export async function sessionWalkData(user: AppUser, session: SessionRow, now = new Date()): Promise<WalkData> {
  const ids = session.dealIds;
  if (!ids.length) return { deals: [], missing: 0, lostReasons: [] };
  const access = await dealAccessWhere(user, "view");
  const extra = await db
    .select({
      id: s.deals.id,
      aiSummary: s.deals.aiSummary,
      healthExplanation: s.deals.healthExplanation,
      lastActivityAt: s.deals.lastActivityAt,
      pipelineName: s.pipelines.name,
      pipelineId: s.deals.pipelineId,
      ownerManagerId: s.user.managerId,
    })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .leftJoin(s.user, eq(s.user.id, s.deals.ownerId))
    .where(and(inArray(s.deals.id, ids), access));
  const visibleIds = extra.map((e) => e.id);
  if (!visibleIds.length) return { deals: [], missing: ids.length, lostReasons: [] };
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY);
  const fromStage = alias(s.stages, "from_stage");
  const [raw, audits, hidden, history, taskCounts, recentActs, lostStages, lostReasons, execs] = await Promise.all([
    dealQuery().where(and(inArray(s.deals.id, visibleIds), isNull(s.deals.deletedAt))),
    recentDealAudits(visibleIds, since),
    hiddenDealFields(user.role),
    db
      .select({ dealId: s.dealStageHistory.dealId, at: s.dealStageHistory.changedAt, to: s.stages.name, from: fromStage.name, reason: s.dealStageHistory.reason })
      .from(s.dealStageHistory)
      .innerJoin(s.stages, eq(s.stages.id, s.dealStageHistory.toStageId))
      .leftJoin(fromStage, eq(fromStage.id, s.dealStageHistory.fromStageId))
      .where(and(inArray(s.dealStageHistory.dealId, visibleIds), gte(s.dealStageHistory.changedAt, since))),
    db
      .select({
        dealId: s.tasks.dealId,
        open: sql<number>`count(*)::int`,
        overdue: sql<number>`count(*) filter (where ${s.tasks.dueAt} < now())::int`,
      })
      .from(s.tasks)
      .where(and(inArray(s.tasks.dealId, visibleIds), eq(s.tasks.status, "open")))
      .groupBy(s.tasks.dealId),
    db
      .select({ dealId: s.activities.dealId, type: s.activities.type, n: sql<number>`count(*)::int` })
      .from(s.activities)
      .where(and(inArray(s.activities.dealId, visibleIds), gte(s.activities.occurredAt, since)))
      .groupBy(s.activities.dealId, s.activities.type),
    db
      .select({ pipelineId: s.stages.pipelineId, id: s.stages.id, sortOrder: s.stages.sortOrder })
      .from(s.stages)
      .where(eq(s.stages.category, "lost"))
      .orderBy(asc(s.stages.sortOrder)),
    getPicklist("lost_reason"),
    db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(and(activeUserWhere, eq(s.user.role, "executive"))).orderBy(asc(s.user.name)),
  ]);
  const valueHidden = isValueHidden(hidden);
  const tz = user.timezone;
  const byId = new Map(raw.map((r) => [r.id, r]));
  const extraById = new Map(extra.map((e) => [e.id, e]));
  const managerIds = [...new Set(extra.map((e) => e.ownerManagerId).filter((x): x is string => Boolean(x)))];
  const managers = managerIds.length ? await db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(and(inArray(s.user.id, managerIds), activeUserWhere)) : [];
  const managerName = new Map(managers.map((m) => [m.id, m.name]));
  const lostByPipeline = new Map<string, string>();
  for (const st of lostStages) if (!lostByPipeline.has(st.pipelineId)) lostByPipeline.set(st.pipelineId, st.id);
  const fmtDay = (d: Date | null) => (d ? formatInTz(d, tz, "short") : null);
  const ymd = (d: Date | null) => (d ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d) : null);

  const deals: WalkDeal[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    const e = extraById.get(id);
    if (!r || !e) continue;
    const c = classify(r, audits.get(id), now, valueHidden);
    const changes: WalkDeal["changes"] = [];
    for (const h of history.filter((x) => x.dealId === id)) {
      changes.push({ at: h.at.toISOString(), label: "Stage", text: `${h.from ?? "—"} → ${h.to}${h.reason ? ` · ${h.reason}` : ""}` });
    }
    for (const a of audits.get(id) ?? []) {
      const before = asObj(a.before);
      const after = asObj(a.after);
      if ("expectedCloseDate" in after) changes.push({ at: a.createdAt.toISOString(), label: "Close date", text: `${fmtDay(asDate(before.expectedCloseDate)) ?? "none"} → ${fmtDay(asDate(after.expectedCloseDate)) ?? "none"}` });
      if ("nextStep" in after && after.nextStep !== before.nextStep) changes.push({ at: a.createdAt.toISOString(), label: "Next step", text: String(after.nextStep ?? "cleared").slice(0, 160) });
      if (!valueHidden && VALUE_KEYS.some((k) => k in after)) changes.push({ at: a.createdAt.toISOString(), label: "Value", text: "Value fields updated" });
      if ("ownerId" in after) changes.push({ at: a.createdAt.toISOString(), label: "Owner", text: "Owner changed" });
    }
    changes.sort((x, y) => y.at.localeCompare(x.at));
    const acts = recentActs.filter((x) => x.dealId === id && ["email", "call", "meeting", "linkedin", "note"].includes(x.type));
    const actText = acts.map((x) => `${x.n} ${x.type}${x.n === 1 ? "" : "s"}`).join(", ");
    if (actText) changes.push({ at: now.toISOString(), label: "Activity", text: `${actText} in the last 7 days` });
    const tc = taskCounts.find((t) => t.dealId === id);
    const escalateTo: WalkDeal["escalateTo"] = [];
    if (e.ownerManagerId && managerName.has(e.ownerManagerId) && e.ownerManagerId !== r.ownerId) escalateTo.push({ id: e.ownerManagerId, name: managerName.get(e.ownerManagerId)!, hint: "Owner's manager" });
    for (const x of execs) if (!escalateTo.some((y) => y.id === x.id)) escalateTo.push({ id: x.id, name: x.name, hint: "Executive" });
    if (!escalateTo.some((y) => y.id === user.id)) escalateTo.push({ id: user.id, name: user.name, hint: "Me" });
    if (r.ownerId && r.ownerName && !escalateTo.some((y) => y.id === r.ownerId)) escalateTo.push({ id: r.ownerId, name: r.ownerName, hint: "Owner" });
    deals.push({
      id,
      name: r.name,
      accountName: r.accountName,
      pipelineKey: r.pipelineKey,
      pipelineName: e.pipelineName,
      pipelineColor: PIPELINE_COLORS[r.pipelineKey] ?? r.pipelineColor,
      stageName: r.stageName,
      ownerId: r.ownerId,
      ownerName: r.ownerName,
      valueUsd: valueHidden ? null : c.valueUsd,
      healthScore: r.healthScore,
      healthExplanation: e.healthExplanation,
      summary: e.aiSummary,
      nextStep: r.nextStep,
      nextStepDueAt: ymd(r.nextStepDueAt),
      nextStepDueLabel: fmtDay(r.nextStepDueAt),
      expectedCloseDate: ymd(r.expectedCloseDate),
      expectedCloseLabel: r.expectedCloseDate ? formatInTz(r.expectedCloseDate, tz, "date") : null,
      daysInStage: Math.max(0, Math.floor((now.getTime() - r.stageEnteredAt.getTime()) / DAY)),
      slaDays: r.slaDays,
      lastActivityLabel: e.lastActivityAt ? formatInTz(e.lastActivityAt, tz, "short") : null,
      openTasks: tc?.open ?? 0,
      overdueTasks: tc?.overdue ?? 0,
      restricted: r.restricted,
      exceptions: c.exceptions,
      changes: changes.slice(0, 8),
      lostStageId: r.status === "open" ? (lostByPipeline.get(e.pipelineId) ?? null) : null,
      escalateTo: escalateTo.slice(0, 8),
    });
  }
  return { deals, missing: ids.length - deals.length, lostReasons };
}

/** Names of session deals safe to show to the whole team (visible to the facilitator, not restricted, account not restricted). */
export async function publicDealNames(user: AppUser, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const access = await dealAccessWhere(user, "view");
  const rows = await db
    .select({ id: s.deals.id, name: s.deals.name, accountRestricted: s.accounts.restricted })
    .from(s.deals)
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .where(and(inArray(s.deals.id, ids), access, eq(s.deals.restricted, false)));
  return new Map(rows.filter((r) => !r.accountRestricted).map((r) => [r.id, r.name]));
}

export function sessionDecisions(session: SessionRow): Decision[] {
  return (session.decisions ?? []) as Decision[];
}

/** Has the recap of this session been posted already? (idempotency tag "review:<sessionId>") */
export async function recapPostId(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: s.teamPosts.id })
    .from(s.teamPosts)
    .where(and(sql`${s.teamPosts.tags} @> array[${`review:${sessionId}`}]::text[]`, isNull(s.teamPosts.deletedAt)))
    .limit(1);
  return row?.id ?? null;
}

