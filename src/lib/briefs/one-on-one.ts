import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { aiAvailable, aiObject, modelFor, RTB_SYSTEM, untrusted } from "@/lib/ai";
import { stripCitations } from "@/lib/team/story-core";
import { classifyMove, isNurtureStageKey } from "@/lib/analytics/transforms";
import { hiddenDealFields } from "@/lib/deals/service";
import { logServerError } from "@/lib/errors";
import { dealValue } from "@/lib/pipeline-math";
import { can, dealAccessWhere, scopeFor, type AppUser } from "@/lib/rbac/server";
import { isoWeekKey } from "@/lib/team/week";
import { activeUserWhere } from "@/lib/users";
import {
  activityDeltas,
  briefDealIds,
  briefWindows,
  canPrepFor,
  heuristicCoaching,
  heuristicHeadline,
  mergeCoaching,
  PREP_ALL_ROLES,
  refilterBrief,
  type BriefDeal,
  type OneOnOneContent,
  type OneOnOneMetrics,
} from "./one-on-one-core";

export const ONE_ON_ONE_KIND = "one_on_one";
/** Roles that carry a book worth a 1:1 brief when an executive browses "everyone". */
const SELLING_ROLES = ["sales_leader", "ae", "sdr", "intern", "commission_rep", "onboarding"];

export type PrepTarget = { id: string; name: string; image: string | null; title: string | null; role: string; direct: boolean };

/** People the viewer may prep a 1:1 for (C8 access rules), direct reports first. */
export async function prepTargets(viewer: AppUser): Promise<PrepTarget[]> {
  const [me] = await db.select({ teamId: s.user.teamId }).from(s.user).where(eq(s.user.id, viewer.id));
  const all = (PREP_ALL_ROLES as readonly string[]).includes(viewer.role);
  const where: SQL = all
    ? and(activeUserWhere, or(inArray(s.user.role, SELLING_ROLES), eq(s.user.managerId, viewer.id))!)!
    : and(activeUserWhere, or(eq(s.user.managerId, viewer.id), viewer.role === "sales_leader" && me?.teamId ? eq(s.user.teamId, me.teamId) : sql`false`)!)!;
  const rows = await db
    .select({ id: s.user.id, name: s.user.name, image: s.user.image, title: s.user.title, role: s.user.role, managerId: s.user.managerId, teamId: s.user.teamId })
    .from(s.user)
    .where(where)
    .orderBy(asc(s.user.name))
    .limit(300);
  return rows
    .filter((r) => canPrepFor({ id: viewer.id, role: viewer.role, teamId: me?.teamId ?? null }, r))
    .map((r) => ({ id: r.id, name: r.name, image: r.image, title: r.title, role: r.role, direct: r.managerId === viewer.id }))
    .sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));
}

/** The rep, if the viewer may prep for them; else null (→ 404, no existence leak). */
export async function prepTarget(viewer: AppUser, repId: string) {
  const [[me], [rep]] = await Promise.all([
    db.select({ teamId: s.user.teamId }).from(s.user).where(eq(s.user.id, viewer.id)),
    db
      .select({ id: s.user.id, name: s.user.name, image: s.user.image, title: s.user.title, role: s.user.role, managerId: s.user.managerId, teamId: s.user.teamId, timezone: s.user.timezone })
      .from(s.user)
      .where(eq(s.user.id, repId)),
  ]);
  if (!rep || !canPrepFor({ id: viewer.id, role: viewer.role, teamId: me?.teamId ?? null }, rep)) return null;
  return rep;
}

const DAY = 86_400_000;

/** Build the metrics for `rep` as seen by `viewer` (only deals the viewer can see; restricted ones flagged). */
async function buildMetrics(viewer: AppUser, repId: string, now: Date): Promise<OneOnOneMetrics> {
  const w = briefWindows(now);
  const start = w.current.start;
  const access = await dealAccessWhere(viewer, "view");
  const hidden = await hiddenDealFields(viewer.role);
  const valueHidden = ["muu", "usdPerMuu", "contractValueCents", "annualizedValueCents", "*"].some((k) => hidden.has(k));
  const repDeals = and(access, eq(s.deals.ownerId, repId))!;
  const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

  const base = {
    id: s.deals.id,
    name: s.deals.name,
    // restricted deal OR restricted account (N-2): never named to the AI or in the brief
    restricted: sql<boolean>`(${s.deals.restricted} or coalesce((select a.restricted from rso.accounts a where a.id = ${s.deals.accountId}), false))`,
    pipeline: s.pipelines.key,
    unit: s.pipelines.unit,
    pipelineUsdPerMuu: s.pipelines.usdPerMuu,
    muu: s.deals.muu,
    usdPerMuu: s.deals.usdPerMuu,
    contractValueCents: s.deals.contractValueCents,
    annualizedValueCents: s.deals.annualizedValueCents,
    stageProbability: s.stages.probability,
  };
  type BaseRow = { id: string; name: string; restricted: boolean; pipeline: string; unit: "muu" | "usd" | "activation"; pipelineUsdPerMuu: number; muu: number | null; usdPerMuu: number | null; contractValueCents: number | null; annualizedValueCents: number | null; stageProbability: number };
  const toDeal = (r: BaseRow, detail?: string | null): BriefDeal => ({
    id: r.id,
    name: r.name,
    pipeline: r.pipeline,
    valueUsd: valueHidden ? 0 : dealValue({ ...r, stageProbability: r.stageProbability }).grossUsd,
    detail: detail ?? null,
    restricted: r.restricted,
  });
  const dealsQ = () =>
    db
      .select({ ...base, status: s.deals.status, wonAt: s.deals.wonAt, lostAt: s.deals.lostAt, lostReason: s.deals.lostReason, createdAt: s.deals.createdAt, healthScore: s.deals.healthScore, nextStep: s.deals.nextStep, nextStepDueAt: s.deals.nextStepDueAt, nextStepWaitingReason: s.deals.nextStepWaitingReason, lastActivityAt: s.deals.lastActivityAt, stageName: s.stages.name, category: s.stages.category })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId));

  const fromStage = alias(s.stages, "from_stage");
  // Task titles only for viewers whose tasks scope covers the rep (team/pipeline/all); others get the count.
  const taskScope = await scopeFor(viewer, "tasks", "view");
  const showTaskTitles = taskScope === "all" || taskScope === "pipeline" || (taskScope === "team" && viewer.teamMemberIds.includes(repId));
  const [closedOrNew, open, moves, audits, actsCur, actsPrior, overdueTasks] = await Promise.all([
    dealsQ()
      .where(and(repDeals, or(gte(s.deals.wonAt, ts(start)), gte(s.deals.lostAt, ts(start)), gte(s.deals.createdAt, ts(start)))))
      .limit(500),
    dealsQ()
      .where(and(repDeals, eq(s.deals.status, "open")))
      .limit(2000),
    db
      .select({
        ...base,
        at: s.dealStageHistory.changedAt,
        fromOrder: fromStage.sortOrder,
        fromCategory: fromStage.category,
        fromKey: fromStage.key,
        fromName: fromStage.name,
        toOrder: s.stages.sortOrder,
        toCategory: s.stages.category,
        toKey: s.stages.key,
        toName: s.stages.name,
      })
      .from(s.dealStageHistory)
      .innerJoin(s.deals, eq(s.deals.id, s.dealStageHistory.dealId))
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .innerJoin(s.stages, eq(s.stages.id, s.dealStageHistory.toStageId))
      .leftJoin(fromStage, eq(fromStage.id, s.dealStageHistory.fromStageId))
      .where(and(repDeals, gte(s.dealStageHistory.changedAt, ts(start))))
      .orderBy(asc(s.dealStageHistory.changedAt))
      .limit(1000),
    db
      .select({ ...base, before: s.auditLog.before, after: s.auditLog.after })
      .from(s.auditLog)
      .innerJoin(s.deals, sql`${s.deals.id}::text = ${s.auditLog.entityId}`)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
      .where(and(eq(s.auditLog.entity, "deal"), gte(s.auditLog.createdAt, ts(start)), sql`${s.auditLog.after} ? 'expectedCloseDate'`, repDeals))
      .limit(500),
    activityCounts(viewer, repId, w.current.start, w.current.end, access),
    activityCounts(viewer, repId, w.prior.start, w.prior.end, access),
    db
      .select({ id: s.tasks.id, title: s.tasks.title, dueAt: s.tasks.dueAt, dealName: s.deals.name, dealRestricted: sql<boolean>`(${s.deals.restricted} or coalesce((select a.restricted from rso.accounts a where a.id = ${s.deals.accountId}), false))` })
      .from(s.tasks)
      .leftJoin(s.deals, eq(s.deals.id, s.tasks.dealId))
      .where(
        and(
          eq(s.tasks.assigneeId, repId),
          eq(s.tasks.status, "open"),
          lt(s.tasks.dueAt, ts(now)),
          or(isNull(s.tasks.dealId), sql`exists (select 1 from ${s.deals} where ${and(eq(s.deals.id, s.tasks.dealId), access)})`),
        ),
      )
      .orderBy(asc(s.tasks.dueAt))
      .limit(200),
  ]);

  const won = closedOrNew.filter((d) => d.status === "won" && d.wonAt && d.wonAt >= start).map((d) => toDeal(d));
  const lost = closedOrNew.filter((d) => d.status === "lost" && d.lostAt && d.lostAt >= start).map((d) => toDeal(d, d.lostReason));
  const created = closedOrNew.filter((d) => d.createdAt >= start).map((d) => toDeal(d, d.stageName));

  // Net stage effect per deal over the window (first "from" → last "to").
  const perDeal = new Map<string, { row: (typeof moves)[number]; first: (typeof moves)[number] }>();
  for (const m of moves) {
    const prev = perDeal.get(m.id);
    perDeal.set(m.id, { row: m, first: prev?.first ?? m });
  }
  const advanced: BriefDeal[] = [];
  const slipped: BriefDeal[] = [];
  for (const { row, first } of perDeal.values()) {
    const from = first.fromOrder != null && first.fromCategory ? { sortOrder: first.fromOrder, category: first.fromCategory, nurture: isNurtureStageKey(first.fromKey) } : null;
    const kind = classifyMove(from, { sortOrder: row.toOrder, category: row.toCategory, nurture: isNurtureStageKey(row.toKey) });
    const detail = `${first.fromName ?? "—"} → ${row.toName}`;
    if (kind === "advanced") advanced.push(toDeal(row, detail));
    else if (kind === "slipped") slipped.push(toDeal(row, detail));
  }

  const pushedIds = new Set<string>();
  const closeDatePushes: BriefDeal[] = [];
  for (const a of audits) {
    const before = (a.before ?? {}) as Record<string, unknown>;
    const after = (a.after ?? {}) as Record<string, unknown>;
    const f = before.expectedCloseDate ? new Date(String(before.expectedCloseDate)) : null;
    const t = after.expectedCloseDate ? new Date(String(after.expectedCloseDate)) : null;
    if (f && t && t > f && !pushedIds.has(a.id)) {
      pushedIds.add(a.id);
      closeDatePushes.push(toDeal(a, `+${Math.round((t.getTime() - f.getTime()) / DAY)} days`));
    }
  }

  const overdueNextSteps = open
    .filter((d) => (!d.nextStep?.trim() || !d.nextStepDueAt) ? !d.nextStepWaitingReason?.trim() : d.nextStepDueAt! < now)
    .map((d) => toDeal(d, d.nextStep?.trim() && d.nextStepDueAt ? `“${d.nextStep.slice(0, 80)}” overdue` : "No next step"));

  const risks = open
    .map((d) => {
      const stale = !d.lastActivityAt || now.getTime() - d.lastActivityAt.getTime() > 14 * DAY;
      const low = d.healthScore != null && d.healthScore < 50;
      const why = [low ? `health ${d.healthScore}` : null, stale ? "no activity in 14+ days" : null].filter(Boolean).join(", ");
      return { d, why, weight: (low ? 100 - (d.healthScore ?? 50) : 0) + (stale ? 20 : 0) };
    })
    .filter((x) => x.why)
    .map((x) => ({ deal: { ...toDeal(x.d, `${x.d.stageName} · ${x.why}`), health: x.d.healthScore }, weight: x.weight }))
    .sort((a, b) => b.weight - a.weight || b.deal.valueUsd - a.deal.valueUsd)
    .slice(0, 5)
    .map((x) => x.deal);

  return {
    won,
    lost,
    advanced: advanced.sort((a, b) => b.valueUsd - a.valueUsd),
    slipped: slipped.sort((a, b) => b.valueUsd - a.valueUsd),
    created,
    closeDatePushes,
    overdueNextSteps: overdueNextSteps.slice(0, 20),
    overdueTasks: {
      count: overdueTasks.length,
      top: (showTaskTitles ? overdueTasks : []).slice(0, 5).map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt?.toISOString() ?? null, dealName: t.dealRestricted ? null : (t.dealName ?? null) })),
    },
    activity: activityDeltas(actsCur, actsPrior),
    openDeals: { count: open.length, valueUsd: open.reduce((a, d) => a + toDeal(d).valueUsd, 0) },
    risks,
  };
}

/** Activities by the rep in [start, end), excluding ones on deals the viewer can't see. */
async function activityCounts(viewer: AppUser, repId: string, start: Date, end: Date, access: SQL): Promise<Record<string, number>> {
  void viewer;
  const rows = await db
    .select({ type: s.activities.type, n: sql<number>`count(*)::int` })
    .from(s.activities)
    .where(
      and(
        eq(s.activities.actorId, repId),
        gte(s.activities.occurredAt, sql`${start.toISOString()}::timestamptz`),
        lt(s.activities.occurredAt, sql`${end.toISOString()}::timestamptz`),
        or(isNull(s.activities.dealId), sql`exists (select 1 from ${s.deals} where ${and(eq(s.deals.id, s.activities.dealId), access)})`),
      ),
    )
    .groupBy(s.activities.type);
  return Object.fromEntries(rows.map((r) => [r.type, r.n]));
}

const aiSchema = z.object({
  headline: z.string().describe("One sentence summary of the rep's week for the manager"),
  coachingPrompts: z.array(z.string()).describe("Exactly 3 open coaching questions grounded in the numbers and deals"),
});

/** AI headline + prompts from the (viewer-visible) metrics. Restricted deals are anonymized before leaving the app. */
async function aiCoaching(viewer: AppUser, repName: string, m: OneOnOneMetrics): Promise<{ headline: string; prompts: string[]; engine: string } | null> {
  if (!aiAvailable() || !(await can(viewer, "copilot", "use_ai"))) return null; // SEC M-6
  try {
    const anon = (d: BriefDeal) => ({ deal: d.restricted ? "a restricted deal" : d.name, motion: d.pipeline, detail: d.restricted ? null : (d.detail ?? null) });
    const facts = {
      won: m.won.map(anon),
      lost: m.lost.map(anon),
      advanced: m.advanced.slice(0, 8).map(anon),
      slipped: m.slipped.slice(0, 8).map(anon),
      newDeals: m.created.length,
      closeDatesPushed: m.closeDatePushes.slice(0, 8).map(anon),
      missingOrOverdueNextSteps: m.overdueNextSteps.length,
      overdueTasks: m.overdueTasks.count,
      activityThisWeekVsLast: m.activity.map((a) => ({ kind: a.label, thisWeek: a.current, lastWeek: a.prior })),
      openDeals: m.openDeals.count,
      topRisks: m.risks.map(anon),
    };
    const model = await modelFor("fast");
    const out = await aiObject({
      kind: "one_on_one",
      userId: viewer.id,
      tier: "fast",
      schema: aiSchema,
      maxOutputTokens: 2000,
      system: `${RTB_SYSTEM}\nFor this output: write plain prose for a manager — no source citations, tags or labels in the text.`,
      prompt: [
        `Prepare a sales manager for a weekly 1:1 with ${repName.split(/\s+/)[0]}.`,
        "Write a one-sentence headline and exactly 3 coaching questions. Be specific (name deals from the data), supportive and direct. No emoji. Use only the data below, and never mention data sources, tags or field names. If the week was empty, ask about plans and blockers rather than repeating zeros.",
        untrusted("crm_week", JSON.stringify(facts, null, 1), 12_000),
      ].join("\n\n"),
    });
    return { headline: stripCitations(out.headline.replace(/\s+/g, " ")).slice(0, 300), prompts: out.coachingPrompts.map(stripCitations), engine: `ai:${model}` };
  } catch (e) {
    logServerError("one_on_one.ai", e);
    return null;
  }
}

export type OneOnOneBrief = { content: OneOnOneContent; engine: string; periodKey: string; createdAt: Date };

/** A cached brief older than this is rebuilt on open, so "this week" isn't frozen at the first view (QA C8). */
const STALE_AFTER_MS = 6 * 60 * 60_000;
/** Manual refresh is rate-limited (each one can cost an AI call). */
export const REFRESH_COOLDOWN_MS = 2 * 60_000;

/** SEC L-3: re-check every deal a stored brief names against the viewer's CURRENT access + field security. */
async function forViewer(viewer: AppUser, b: OneOnOneBrief): Promise<OneOnOneBrief> {
  const ids = briefDealIds(b.content.metrics);
  const [hidden, visibleRows] = await Promise.all([
    hiddenDealFields(viewer.role),
    ids.length ? db.select({ id: s.deals.id }).from(s.deals).where(and(inArray(s.deals.id, ids), await dealAccessWhere(viewer, "view"))) : Promise.resolve([]),
  ]);
  return { ...b, content: refilterBrief(b.content, new Set(visibleRows.map((r) => r.id)), hidden) };
}

/**
 * This week's 1:1 brief for viewer × rep: cached in `briefs` (kind one_on_one, periodKey = ISO week in the viewer's
 * zone, userId = viewer — content depends on what the viewer may see). `refresh` rebuilds it.
 */
export async function getOneOnOneBrief(viewer: AppUser, repId: string, opts: { refresh?: boolean; now?: Date } = {}): Promise<OneOnOneBrief | null> {
  const rep = await prepTarget(viewer, repId);
  if (!rep) return null;
  const now = opts.now ?? new Date();
  const periodKey = isoWeekKey(now, viewer.timezone);
  const [cached] = await db
    .select()
    .from(s.briefs)
    .where(and(eq(s.briefs.kind, ONE_ON_ONE_KIND), eq(s.briefs.subjectId, repId), eq(s.briefs.userId, viewer.id), eq(s.briefs.periodKey, periodKey)));
  if (cached && (cached.content as { version?: number }).version === 1) {
    const age = now.getTime() - cached.createdAt.getTime();
    // Serve the cache unless a refresh was asked for (and the cooldown passed) or it is stale.
    if ((!opts.refresh && age < STALE_AFTER_MS) || (opts.refresh && age < REFRESH_COOLDOWN_MS)) {
      return forViewer(viewer, { content: cached.content as unknown as OneOnOneContent, engine: cached.engine ?? "heuristic", periodKey, createdAt: cached.createdAt });
    }
  }
  const metrics = await buildMetrics(viewer, repId, now);
  const fallback = heuristicCoaching(metrics);
  const ai = await aiCoaching(viewer, rep.name, metrics);
  const w = briefWindows(now);
  const content: OneOnOneContent = {
    version: 1,
    repId,
    repName: rep.name,
    generatedAt: now.toISOString(),
    window: { start: w.current.start.toISOString(), end: w.current.end.toISOString() },
    metrics,
    headline: ai?.headline || heuristicHeadline(rep.name, metrics),
    coachingPrompts: mergeCoaching(ai?.prompts, fallback),
  };
  const engine = ai?.engine ?? "heuristic";
  await db
    .insert(s.briefs)
    .values({ kind: ONE_ON_ONE_KIND, subjectId: repId, userId: viewer.id, periodKey, content: content as unknown as Record<string, unknown>, engine, createdAt: now })
    .onConflictDoUpdate({
      target: [s.briefs.kind, s.briefs.subjectId, s.briefs.userId, s.briefs.periodKey],
      set: { content: content as unknown as Record<string, unknown>, engine, createdAt: now },
    });
  return forViewer(viewer, { content, engine, periodKey, createdAt: now });
}

/** Earlier weeks' briefs (viewer × rep), newest first. */
export async function pastOneOnOnes(viewer: AppUser, repId: string, limit = 8) {
  return db
    .select({ periodKey: s.briefs.periodKey, createdAt: s.briefs.createdAt, engine: s.briefs.engine })
    .from(s.briefs)
    .where(and(eq(s.briefs.kind, ONE_ON_ONE_KIND), eq(s.briefs.subjectId, repId), eq(s.briefs.userId, viewer.id), isNotNull(s.briefs.periodKey)))
    .orderBy(desc(s.briefs.periodKey))
    .limit(limit);
}

/** A stored brief for a specific past week (read-only; never regenerated). */
export async function storedOneOnOne(viewer: AppUser, repId: string, periodKey: string): Promise<OneOnOneBrief | null> {
  if (!(await prepTarget(viewer, repId))) return null;
  const [row] = await db
    .select()
    .from(s.briefs)
    .where(and(eq(s.briefs.kind, ONE_ON_ONE_KIND), eq(s.briefs.subjectId, repId), eq(s.briefs.userId, viewer.id), eq(s.briefs.periodKey, periodKey)));
  if (!row || (row.content as { version?: number }).version !== 1) return null;
  return forViewer(viewer, { content: row.content as unknown as OneOnOneContent, engine: row.engine ?? "heuristic", periodKey, createdAt: row.createdAt });
}
