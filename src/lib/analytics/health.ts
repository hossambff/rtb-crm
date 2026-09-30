import "server-only";
import { limited, limitedAll } from "./limit";
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealScopeWhere, type AnalyticsContext } from "./scope";
import { healthBand, HEALTH_BANDS, stageConversion, winRate } from "./transforms";
import { countInt, money, prob, sumF, ts } from "./value-sql";

const OPEN = eq(s.stages.category, "open");
const ageDays = sql<number>`extract(epoch from (now() - ${s.deals.stageEnteredAt})) / 86400.0`;

/** Stage aging vs SLA for open deals (per pipeline · stage). */
export async function stageAging(ctx: AnalyticsContext) {
  const where = await dealScopeWhere(ctx);
  return limited(db
    .select({
      pipeline: s.pipelines.key,
      pipelineOrder: s.pipelines.sortOrder,
      stage: s.stages.name,
      sortOrder: s.stages.sortOrder,
      slaDays: s.stages.slaDays,
      deals: countInt,
      avgAge: sql<number>`coalesce(avg(${ageDays}), 0)::float8`,
      overSla: sql<number>`count(*) filter (where ${s.stages.slaDays} is not null and ${ageDays} > ${s.stages.slaDays})::int`,
    })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
    .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
    .where(and(where, OPEN))
    .groupBy(s.pipelines.key, s.pipelines.sortOrder, s.stages.name, s.stages.sortOrder, s.stages.slaDays)
    .orderBy(asc(s.pipelines.sortOrder), asc(s.stages.sortOrder)));
}

export type AttentionDeal = {
  id: string;
  name: string;
  pipeline: string;
  stage: string;
  owner: string | null;
  value: number;
  nextStep: string | null;
  nextStepDueAt: Date | null;
  lastActivityAt: Date | null;
  ageDays: number;
};

/** Open deals missing a next step / with an overdue next step, and stalled deals (no activity in 14+ days). */
export async function attention(ctx: AnalyticsContext, now: Date) {
  const where = await dealScopeWhere(ctx);
  const m = money(ctx.filters.basis);
  const p = prob(ctx.filters.overrides);
  const stalledCutoff = new Date(now.getTime() - 14 * 86_400_000);
  const noNext = or(isNull(s.deals.nextStep), sql`btrim(${s.deals.nextStep}) = ''`)!;
  const overdue = and(isNotNull(s.deals.nextStepDueAt), lt(s.deals.nextStepDueAt, sql`date_trunc('day', now())`))!;
  // Date bound as an explicit timestamptz: this fragment is also used inside SELECT aggregates.
  const cutoff = ts(stalledCutoff);
  const stalled = sql`(${s.deals.lastActivityAt} < ${cutoff} or (${s.deals.lastActivityAt} is null and ${s.deals.createdAt} < ${cutoff}))`;

  const [[counts], noNextList, stalledList] = await limitedAll([
    db
      .select({
        open: countInt,
        noNext: sql<number>`count(*) filter (where ${noNext})::int`,
        overdue: sql<number>`count(*) filter (where ${overdue})::int`,
        stalled: sql<number>`count(*) filter (where ${stalled})::int`,
        noNextValue: sumF(sql`case when ${noNext} then ${m} * ${p} else 0 end`),
      })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
      .where(and(where, OPEN)),
    listDeals(and(where, OPEN, or(noNext, overdue))!, m, p),
    listDeals(and(where, OPEN, stalled)!, m, p),
  ]);
  return { counts: counts ?? { open: 0, noNext: 0, overdue: 0, stalled: 0, noNextValue: 0 }, noNextList, stalledList };
}

async function listDeals(where: ReturnType<typeof and>, m: ReturnType<typeof money>, p: ReturnType<typeof prob>): Promise<AttentionDeal[]> {
  return limited(db
    .select({
      id: s.deals.id,
      name: s.deals.name,
      pipeline: s.pipelines.key,
      stage: s.stages.name,
      owner: s.user.name,
      value: sql<number>`(${m} * ${p})::float8`,
      nextStep: s.deals.nextStep,
      nextStepDueAt: s.deals.nextStepDueAt,
      lastActivityAt: s.deals.lastActivityAt,
      ageDays,
    })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
    .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
    .leftJoin(s.user, eq(s.deals.ownerId, s.user.id))
    .where(where)
    .orderBy(desc(sql`${m} * ${p}`))
    .limit(12));
}

/** Health score distribution (AI/heuristic health on open deals) in status bands. */
export async function healthDistribution(ctx: AnalyticsContext) {
  const where = await dealScopeWhere(ctx);
  const m = money(ctx.filters.basis);
  const p = prob(ctx.filters.overrides);
  const rows = await limited(db
    .select({ score: s.deals.healthScore, deals: countInt, weighted: sumF(sql`${m} * ${p}`) })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
    .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
    .where(and(where, OPEN))
    .groupBy(s.deals.healthScore));
  const bands = [...HEALTH_BANDS.map((b) => ({ key: b.key as string, label: b.label })), { key: "unscored", label: "Unscored" }];
  const acc = new Map(bands.map((b) => [b.key, { ...b, deals: 0, weighted: 0 }]));
  for (const r of rows) {
    const b = acc.get(healthBand(r.score))!;
    b.deals += r.deals;
    b.weighted += r.weighted;
  }
  return [...acc.values()];
}

/**
 * Velocity: average days deals spent in each stage, from deal_stage_history (time until the next move; the current
 * stage counts up to now). Moves entering the stage inside the date range.
 */
export async function velocityByStage(ctx: AnalyticsContext) {
  const where = await dealScopeWhere(ctx);
  const h = db
    .select({
      dealId: s.dealStageHistory.dealId,
      stageId: s.dealStageHistory.toStageId,
      enteredAt: s.dealStageHistory.changedAt,
      leftAt: sql<Date | null>`lead(${s.dealStageHistory.changedAt}) over (partition by ${s.dealStageHistory.dealId} order by ${s.dealStageHistory.changedAt})`.as("left_at"),
    })
    .from(s.dealStageHistory)
    .as("h");
  const dur = sql<number>`extract(epoch from (coalesce(${h.leftAt}, now()) - ${h.enteredAt})) / 86400.0`;
  return limited(db
    .select({
      pipeline: s.pipelines.key,
      pipelineOrder: s.pipelines.sortOrder,
      stage: s.stages.name,
      sortOrder: s.stages.sortOrder,
      moves: countInt,
      avgDays: sql<number>`avg(${dur})::float8`,
      medianDays: sql<number>`percentile_cont(0.5) within group (order by ${dur})::float8`,
    })
    .from(h)
    .innerJoin(s.deals, eq(h.dealId, s.deals.id))
    .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
    .innerJoin(s.stages, eq(h.stageId, s.stages.id))
    .where(and(where, eq(s.stages.category, "open"), gte(h.enteredAt, ctx.filters.from), lte(h.enteredAt, ctx.filters.to)))
    .groupBy(s.pipelines.key, s.pipelines.sortOrder, s.stages.name, s.stages.sortOrder)
    .orderBy(asc(s.pipelines.sortOrder), asc(s.stages.sortOrder)));
}

/**
 * Historical conversion by stage for one pipeline (default: the selected pipeline, else NET). Uses every stage a deal
 * has ever entered (history ∪ current stage), so it covers all time — not just the date range.
 */
export async function conversionByStage(ctx: AnalyticsContext, pipelineKey: string) {
  const scoped = { ...ctx, filters: { ...ctx.filters, pipeline: pipelineKey } };
  const where = await dealScopeWhere(scoped);
  const [pipe] = await db.select().from(s.pipelines).where(eq(s.pipelines.key, pipelineKey));
  if (!pipe) return null;
  const openStages = await limited(db
    .select({ id: s.stages.id, name: s.stages.name, sortOrder: s.stages.sortOrder, key: s.stages.key })
    .from(s.stages)
    .where(and(eq(s.stages.pipelineId, pipe.id), eq(s.stages.category, "open")))
    .orderBy(asc(s.stages.sortOrder)));
  // Nurture/cold stages sit after the funnel in sort order; they aren't progress.
  const funnelStages = openStages.filter((st) => !/cold|nurture|lapsed/i.test(st.key));
  const entered = unionAll(
    db.select({ dealId: s.dealStageHistory.dealId, stageId: s.dealStageHistory.toStageId }).from(s.dealStageHistory),
    db.select({ dealId: s.deals.id, stageId: s.deals.stageId }).from(s.deals),
  ).as("entered");
  const funnelIds = funnelStages.map((st) => st.id);
  const reachedStage = sql`${s.stages.id} in (${funnelIds.length ? sql.join(funnelIds.map((id) => sql`${id}::uuid`), sql`, `) : sql`null`})`;
  const rows = await limited(db
    .select({
      dealId: s.deals.id,
      maxOpenOrder: sql<number | null>`max(${s.stages.sortOrder}) filter (where ${reachedStage})`,
      won: sql<boolean>`bool_or(${s.stages.category} = 'won')`,
    })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
    .innerJoin(entered, eq(entered.dealId, s.deals.id))
    .innerJoin(s.stages, eq(entered.stageId, s.stages.id))
    .where(where)
    .groupBy(s.deals.id));
  return { pipeline: pipe.name, key: pipe.key, deals: rows.length, stages: stageConversion(funnelStages, rows.map((r) => ({ maxOpenOrder: r.maxOpenOrder, won: Boolean(r.won) }))) };
}

/** Win rate by motion and by source for deals closed (won or lost) in the date range. */
export async function winRates(ctx: AnalyticsContext) {
  const where = await dealScopeWhere(ctx);
  const closedAt = sql`coalesce(${s.deals.wonAt}, ${s.deals.lostAt})`;
  const inRange = and(sql`${closedAt} >= ${ts(ctx.filters.from)}`, sql`${closedAt} <= ${ts(ctx.filters.to)}`, or(eq(s.deals.status, "won"), eq(s.deals.status, "lost")));
  const won = sql<number>`count(*) filter (where ${s.deals.status} = 'won')::int`;
  const lost = sql<number>`count(*) filter (where ${s.deals.status} = 'lost')::int`;
  const source = sql<string>`coalesce(nullif(btrim(${s.deals.source}), ''), 'Unknown')`;
  const [byMotion, bySource] = await limitedAll([
    db
      .select({ key: s.pipelines.key, name: s.pipelines.name, won, lost })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .where(and(where, inRange))
      .groupBy(s.pipelines.key, s.pipelines.name, s.pipelines.sortOrder)
      .orderBy(asc(s.pipelines.sortOrder)),
    db
      .select({ source, won, lost })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .where(and(where, inRange))
      .groupBy(source),
  ]);
  const withRate = <T extends { won: number; lost: number }>(r: T) => ({ ...r, rate: winRate(r.won, r.lost) });
  return {
    byMotion: byMotion.map(withRate),
    bySource: bySource.map(withRate).sort((a, b) => b.won + b.lost - (a.won + a.lost)),
  };
}
