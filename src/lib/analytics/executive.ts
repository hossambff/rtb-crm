import "server-only";
import { limited, limitedAll } from "./limit";
import { and, asc, desc, eq, gte, isNotNull, lte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { accountVisibleWhere, dealScopeWhere, type AnalyticsContext } from "./scope";
import { classifyMove, concentration, cumulative, isNurtureStageKey, ytdMonths } from "./transforms";
import { countInt, grossUsd, money, muu, netUsd, overridden, prob, stageProb, sumF, ts } from "./value-sql";

export type MotionRow = {
  sortOrder: number;
  key: string;
  name: string;
  unit: "muu" | "usd" | "activation";
  color: string;
  deals: number;
  muu: number;
  weightedMuu: number;
  gross: number;
  net: number;
  weightedGross: number;
  weightedNet: number;
  /** weighted(with overrides) − weighted(stage probability) — the manual-override exposure. */
  overrideDeltaGross: number;
  overrideDeltaNet: number;
  overriddenDeals: number;
  estimatedMuu: number;
};

const OPEN = eq(s.stages.category, "open");

/** Open pipeline by motion (MUU, gross, net, weighted) — one GROUP BY. */
export async function pipelineByMotion(ctx: AnalyticsContext): Promise<MotionRow[]> {
  const where = await dealScopeWhere(ctx);
  const wIncl = prob(true);
  const wStage = stageProb;
  const w = prob(ctx.filters.overrides);
  const rows = await limited(db
    .select({
      key: s.pipelines.key,
      name: s.pipelines.name,
      unit: s.pipelines.unit,
      color: s.pipelines.color,
      sortOrder: s.pipelines.sortOrder,
      deals: countInt,
      muu: sumF(muu),
      weightedMuu: sumF(sql`${muu} * ${w}`),
      gross: sumF(grossUsd),
      net: sumF(netUsd),
      weightedGross: sumF(sql`${grossUsd} * ${w}`),
      weightedNet: sumF(sql`${netUsd} * ${w}`),
      overrideDeltaGross: sumF(sql`${grossUsd} * (${wIncl} - ${wStage})`),
      overrideDeltaNet: sumF(sql`${netUsd} * (${wIncl} - ${wStage})`),
      overriddenDeals: sql<number>`count(*) filter (where ${overridden})::int`,
      estimatedMuu: sumF(sql`case when ${s.accounts.muuConfidence} is distinct from 'verified' then ${muu} else 0 end`),
    })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
    .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
    .leftJoin(s.accounts, eq(s.deals.accountId, s.accounts.id))
    .where(and(where, OPEN))
    .groupBy(s.pipelines.key, s.pipelines.name, s.pipelines.unit, s.pipelines.color, s.pipelines.sortOrder)
    .orderBy(asc(s.pipelines.sortOrder)));
  return rows;
}

const TIERS = [
  { label: "100%", min: 0.95 },
  { label: "90%", min: 0.75 },
  { label: "50%", min: 0.3 },
  { label: "10%", min: 0.0001 },
  { label: "0%", min: -1 },
];
export const TIER_LABELS = TIERS.map((t) => t.label);

/** Tier distribution across motions (probability tiers are common to every pipeline). */
export async function tierDistribution(ctx: AnalyticsContext) {
  const where = await dealScopeWhere(ctx);
  const p = prob(ctx.filters.overrides);
  const tier = sql<string>`(case ${sql.join(
    // constants inlined (not bound) so the SELECT and GROUP BY expressions are textually identical
    TIERS.slice(0, -1).map((t) => sql`when ${p} >= ${sql.raw(String(Number(t.min)))} then ${sql.raw(`'${t.label}'`)}`),
    sql` `,
  )} else '0%' end)`;
  const m = money(ctx.filters.basis);
  return limited(db
    .select({ tier, motion: s.pipelines.key, deals: countInt, value: sumF(m), weighted: sumF(sql`${m} * ${p}`), muu: sumF(muu) })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
    .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
    .where(and(where, OPEN))
    .groupBy(tier, s.pipelines.key));
}

/** Stage distribution for one pipeline (when the pipeline filter is set). */
export async function stageDistribution(ctx: AnalyticsContext) {
  const where = await dealScopeWhere(ctx);
  const p = prob(ctx.filters.overrides);
  const m = money(ctx.filters.basis);
  return limited(db
    .select({
      stage: s.stages.name,
      sortOrder: s.stages.sortOrder,
      category: s.stages.category,
      deals: countInt,
      muu: sumF(muu),
      value: sumF(m),
      weighted: sumF(sql`${m} * ${p}`),
    })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
    .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
    .where(and(where, ne(s.stages.category, "lost")))
    .groupBy(s.stages.name, s.stages.sortOrder, s.stages.category)
    .orderBy(asc(s.stages.sortOrder)));
}

/** Top brands by weighted open value (restricted accounts hidden unless on the access list). */
export async function topBrands(ctx: AnalyticsContext, limit = 25) {
  const where = await dealScopeWhere(ctx);
  const p = prob(ctx.filters.overrides);
  const m = money(ctx.filters.basis);
  return limited(db
    .select({
      accountId: s.accounts.id,
      name: s.accounts.name,
      category: s.accounts.category,
      motions: sql<string>`string_agg(distinct ${s.pipelines.key}, ' · ')`,
      deals: countInt,
      muu: sumF(muu),
      value: sumF(m),
      weighted: sumF(sql`${m} * ${p}`),
      maxProb: sql<number>`max(${p})::float8`,
    })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
    .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
    .innerJoin(s.accounts, eq(s.deals.accountId, s.accounts.id))
    .where(and(where, OPEN, accountVisibleWhere(ctx.user)))
    .groupBy(s.accounts.id, s.accounts.name, s.accounts.category)
    .orderBy(desc(sumF(sql`${m} * ${p}`)))
    .limit(limit));
}

/** Concentration = top-5 accounts' share of engaged weighted value (engaged = stage probability ≥ threshold). */
export async function engagedConcentration(ctx: AnalyticsContext) {
  const threshold = await getSetting<number>("pipeline.engaged_threshold", 0.5);
  const where = await dealScopeWhere(ctx);
  const p = prob(ctx.filters.overrides);
  const m = money(ctx.filters.basis);
  const rows = await limited(db
    .select({ accountId: s.deals.accountId, weighted: sumF(sql`${m} * ${p}`) })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
    .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
    .where(and(where, OPEN, gte(s.stages.probability, threshold)))
    .groupBy(s.deals.accountId));
  return { ...concentration(rows.map((r) => r.weighted)), accounts: rows.length, threshold };
}

const fromStage = alias(s.stages, "from_stage");

/** New vs advanced vs slipped over the last 7 days (deal_stage_history + created_at). */
export async function weeklyMovement(ctx: AnalyticsContext, now: Date) {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const where = await dealScopeWhere(ctx);
  const m = money(ctx.filters.basis);
  const [created, moves] = await limitedAll([
    db
      .select({ id: s.deals.id, name: s.deals.name, pipeline: s.pipelines.key, value: m })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
      .where(and(where, gte(s.deals.createdAt, since)))
      .orderBy(desc(m))
      .limit(500),
    db
      .select({
        dealId: s.deals.id,
        name: s.deals.name,
        pipeline: s.pipelines.key,
        value: m,
        changedAt: s.dealStageHistory.changedAt,
        reason: s.dealStageHistory.reason,
        fromName: fromStage.name,
        fromOrder: fromStage.sortOrder,
        fromCategory: fromStage.category,
        fromKey: fromStage.key,
        toName: s.stages.name,
        toOrder: s.stages.sortOrder,
        toCategory: s.stages.category,
        toKey: s.stages.key,
      })
      .from(s.dealStageHistory)
      .innerJoin(s.deals, eq(s.dealStageHistory.dealId, s.deals.id))
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .innerJoin(s.stages, eq(s.dealStageHistory.toStageId, s.stages.id))
      .leftJoin(fromStage, eq(s.dealStageHistory.fromStageId, fromStage.id))
      .where(and(where, gte(s.dealStageHistory.changedAt, since)))
      .orderBy(desc(s.dealStageHistory.changedAt))
      .limit(2000),
  ]);
  // Net effect per deal over the week: first "from" → last "to".
  const perDeal = new Map<string, (typeof moves)[number] & { firstFrom: { sortOrder: number; category: "open" | "won" | "lost" | "hold"; name: string; nurture: boolean } | null }>();
  for (const mv of [...moves].reverse()) {
    const prev = perDeal.get(mv.dealId);
    const firstFrom = prev ? prev.firstFrom : mv.fromOrder != null && mv.fromCategory ? { sortOrder: mv.fromOrder, category: mv.fromCategory, name: mv.fromName ?? "", nurture: isNurtureStageKey(mv.fromKey) } : null;
    perDeal.set(mv.dealId, { ...mv, firstFrom });
  }
  const advanced: { id: string; name: string; pipeline: string; value: number; from: string | null; to: string; reason: string | null }[] = [];
  const slipped: typeof advanced = [];
  for (const d of perDeal.values()) {
    const kind = classifyMove(d.firstFrom, { sortOrder: d.toOrder, category: d.toCategory, nurture: isNurtureStageKey(d.toKey) });
    const row = { id: d.dealId, name: d.name, pipeline: d.pipeline, value: d.value, from: d.firstFrom?.name ?? null, to: d.toName, reason: d.reason };
    if (kind === "advanced") advanced.push(row);
    else if (kind === "slipped") slipped.push(row);
  }
  advanced.sort((a, b) => b.value - a.value);
  slipped.sort((a, b) => b.value - a.value);
  return {
    created: { count: created.length, value: created.reduce((a, r) => a + r.value, 0), top: created.slice(0, 6) },
    advanced: { count: advanced.length, value: advanced.reduce((a, r) => a + r.value, 0), top: advanced.slice(0, 6) },
    slipped: { count: slipped.length, value: slipped.reduce((a, r) => a + r.value, 0), top: slipped.slice(0, 6) },
  };
}

/** Won MUU & revenue YTD with monthly buckets for the sparkline. */
export async function wonYtd(ctx: AnalyticsContext, now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const where = await dealScopeWhere(ctx);
  const month = sql<string>`to_char(${s.deals.wonAt} at time zone 'UTC', 'YYYY-MM')`;
  const rows = await limited(db
    .select({ month, deals: countInt, muu: sumF(muu), gross: sumF(grossUsd), net: sumF(netUsd) })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
    .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
    .where(and(where, eq(s.deals.status, "won"), gte(s.deals.wonAt, start)))
    .groupBy(month));
  const months = ytdMonths(now);
  const pickVal = (r: (typeof rows)[number]) => (ctx.filters.basis === "net" ? r.net : r.gross);
  return {
    deals: rows.reduce((a, r) => a + r.deals, 0),
    muu: rows.reduce((a, r) => a + r.muu, 0),
    value: rows.reduce((a, r) => a + pickVal(r), 0),
    valueTrend: cumulative(months, rows.map((r) => ({ bucket: r.month, value: pickVal(r) }))),
    muuTrend: cumulative(months, rows.map((r) => ({ bucket: r.month, value: r.muu }))),
  };
}

/** Pending probability-override requests (not yet counted in weighted values). */
export async function pendingOverrides(ctx: AnalyticsContext) {
  const where = await dealScopeWhere(ctx);
  const [r] = await limited(db
    .select({ n: countInt })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
    .where(and(where, isNotNull(s.deals.probabilityOverride), eq(s.deals.overrideStatus, "pending"))));
  return r?.n ?? 0;
}

/** Roundtable 100: live accounts (won-category R100 stages) vs the goal, with a YTD burn-up. */
export async function r100Live(ctx: AnalyticsContext, now: Date) {
  const goal = await getSetting<number>("r100.goal_live", 100);
  const where = await dealScopeWhere(ctx, { ignorePipelineFilter: true });
  const month = sql<string>`to_char(coalesce(${s.deals.wonAt}, ${s.deals.stageEnteredAt}) at time zone 'UTC', 'YYYY-MM')`;
  const rows = await limited(db
    .select({ month, n: countInt })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
    .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
    .where(and(where, eq(s.pipelines.key, "R100"), eq(s.stages.category, "won")))
    .groupBy(month));
  const live = rows.reduce((a, r) => a + r.n, 0);
  const months = ytdMonths(now);
  const startYear = `${now.getUTCFullYear()}-01`;
  const before = rows.filter((r) => r.month < startYear).reduce((a, r) => a + r.n, 0);
  return { live, goal, trend: cumulative(months, rows.map((r) => ({ bucket: r.month, value: r.n })), before) };
}

/** TheStreet (ADS): annualized value of current clients, bookings in range, collections and overdue AR. */
export async function adsRevenue(ctx: AnalyticsContext, now: Date) {
  const where = await dealScopeWhere(ctx, { ignorePipelineFilter: true });
  const ads = and(where, eq(s.pipelines.key, "ADS"));
  const [[annual], [bookings], collections] = await limitedAll([
    db
      .select({ value: sumF(grossUsd), deals: countInt })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
      .where(and(ads, eq(s.stages.category, "won"))),
    db
      .select({ value: sumF(sql`coalesce(${s.deals.contractValueCents}, ${s.deals.annualizedValueCents}, 0)::float8 / 100`), deals: countInt })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .where(and(ads, eq(s.deals.status, "won"), gte(s.deals.wonAt, ctx.filters.from), lte(s.deals.wonAt, ctx.filters.to))),
    ctx.revenueAllowed
      ? db
          .select({
            collected: sumF(sql`case when ${s.invoices.status} = 'paid' and ${s.invoices.paidAt} >= ${ts(ctx.filters.from)} then ${s.invoices.amountCents} else 0 end`),
            overdue: sumF(
              sql`case when ${s.invoices.status} = 'overdue' or (${s.invoices.status} in ('scheduled','sent') and ${s.invoices.dueAt} < ${ts(now)}) then ${s.invoices.amountCents} else 0 end`,
            ),
            scheduled: sumF(sql`case when ${s.invoices.status} in ('scheduled','sent') and ${s.invoices.dueAt} >= ${ts(now)} then ${s.invoices.amountCents} else 0 end`),
          })
          .from(s.invoices)
          .innerJoin(s.deals, eq(s.invoices.dealId, s.deals.id))
          .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
          .where(ads)
      : Promise.resolve(null),
  ]);
  const c = collections?.[0];
  return {
    annualized: annual?.value ?? 0,
    clients: annual?.deals ?? 0,
    bookings: bookings?.value ?? 0,
    bookingsDeals: bookings?.deals ?? 0,
    collected: c ? c.collected / 100 : null,
    overdue: c ? c.overdue / 100 : null,
    scheduled: c ? c.scheduled / 100 : null,
  };
}

/**
 * Weighted pipeline trend from nightly snapshots — org-level aggregates, so only shown when the viewer can see
 * everything and no owner/pipeline filter is applied (snapshots aren't owner-scoped).
 */
export async function snapshotTrend(ctx: AnalyticsContext, now: Date) {
  if (!ctx.orgWide) return null;
  const since = new Date(now.getTime() - 12 * 7 * 86_400_000).toISOString().slice(0, 10);
  const weighted = snapshotWeightedSql(ctx.filters.overrides);
  const rows = await limited(db
    .select({ day: s.pipelineSnapshots.takenOn, pipeline: s.pipelineSnapshots.pipelineKey, weighted: sumF(sql`${weighted}::float8 / 100`) })
    .from(s.pipelineSnapshots)
    .where(and(gte(s.pipelineSnapshots.takenOn, since), SNAPSHOT_OPEN))
    .groupBy(s.pipelineSnapshots.takenOn, s.pipelineSnapshots.pipelineKey)
    .orderBy(asc(s.pipelineSnapshots.takenOn)));
  return rows;
}

/** Weighted gross value 7 days ago per the closest snapshot on/before that day (org-wide only). */
export async function weekAgoWeighted(ctx: AnalyticsContext, now: Date): Promise<number | null> {
  if (!ctx.orgWide) return null;
  const day = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const [latest] = await limited(db
    .select({ d: sql<string>`max(${s.pipelineSnapshots.takenOn})` })
    .from(s.pipelineSnapshots)
    .where(lte(s.pipelineSnapshots.takenOn, day)));
  if (!latest?.d) return null;
  const weighted = snapshotWeightedSql(ctx.filters.overrides);
  const [r] = await limited(db
    .select({ v: sumF(sql`${weighted}::float8 / 100`) })
    .from(s.pipelineSnapshots)
    .where(and(eq(s.pipelineSnapshots.takenOn, latest.d), SNAPSHOT_OPEN)));
  return r?.v ?? null;
}

/**
 * Snapshot column for the weighted value (H-01): `override_weighted_cents` = with approved overrides,
 * `weighted_cents` = stage probability only (see snapshot-core `snapshotWeightedCents`).
 */
function snapshotWeightedSql(includeOverrides: boolean) {
  return includeOverrides ? s.pipelineSnapshots.overrideWeightedCents : s.pipelineSnapshots.weightedCents;
}

/** Only open-stage snapshot rows are pipeline (legacy rows written before H-01 may include won/lost stages). */
const SNAPSHOT_OPEN = sql`exists (select 1 from ${s.stages} st join ${s.pipelines} sp on sp.id = st.pipeline_id
  where sp.key = ${s.pipelineSnapshots.pipelineKey} and st.key = ${s.pipelineSnapshots.stageKey} and st.category = 'open')`;
