import "server-only";
import { limitedAll } from "./limit";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { ownerFilter, type AnalyticsContext } from "./scope";
import { funnelFromFlags } from "./transforms";
import { countInt, sumF } from "./value-sql";

export const SCOUT_STEPS = ["Found", "Accepted", "Contacted", "Won"] as const;
export const FIT_BANDS = ["80–100", "60–79", "40–59", "0–39", "Unscored"] as const;

/**
 * Lead Scout funnel for candidates found in the date range: found → accepted → contacted (outbound touch on the
 * matched account) → won (the matched account has a won deal). Cost from enrichment_runs in the same range.
 * Scoped by search owner (own/team) — org budget is only shown to org-wide viewers.
 */
export async function leadScout(ctx: AnalyticsContext, now: Date) {
  const { from, to } = ctx.filters;
  const accountId = sql`nullif(${s.scoutCandidates.crmMatch}->>'accountId', '')::uuid`;
  const contacted = sql<boolean>`exists (select 1 from ${s.activities} a where a.account_id = ${accountId} and a.direction = 'outbound' and a.occurred_at >= ${s.scoutCandidates.createdAt})`;
  const won = sql<boolean>`exists (select 1 from ${s.deals} d where d.account_id = ${accountId} and d.status = 'won' and d.deleted_at is null)`;
  const band = sql<string>`(case when ${s.scoutCandidates.fitScore} is null then 'Unscored' when ${s.scoutCandidates.fitScore} >= 80 then '80–100' when ${s.scoutCandidates.fitScore} >= 60 then '60–79' when ${s.scoutCandidates.fitScore} >= 40 then '40–59' else '0–39' end)`;
  const accepted = sql<boolean>`${s.scoutCandidates.state} = 'accepted'`;
  const searchScope = ownerFilter(ctx, s.scoutSearches.ownerId);
  const inRange = and(gte(s.scoutCandidates.createdAt, from), lte(s.scoutCandidates.createdAt, to));

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [cands, bySearch, byBand, [cost], budget, [monthSpend]] = await limitedAll([
    db
      .select({ accepted, contacted: sql<boolean>`(${accepted} and ${contacted})`, won: sql<boolean>`(${accepted} and ${won})` })
      .from(s.scoutCandidates)
      .innerJoin(s.scoutSearches, eq(s.scoutCandidates.searchId, s.scoutSearches.id))
      .where(and(searchScope, inRange))
      .limit(50000),
    db
      .select({
        id: s.scoutSearches.id,
        name: s.scoutSearches.name,
        found: countInt,
        accepted: sql<number>`count(*) filter (where ${accepted})::int`,
        rejected: sql<number>`count(*) filter (where ${s.scoutCandidates.state} = 'rejected')::int`,
        avgFit: sql<number | null>`avg(${s.scoutCandidates.fitScore})::float8`,
      })
      .from(s.scoutCandidates)
      .innerJoin(s.scoutSearches, eq(s.scoutCandidates.searchId, s.scoutSearches.id))
      .where(and(searchScope, inRange))
      .groupBy(s.scoutSearches.id, s.scoutSearches.name),
    db
      .select({ band, found: countInt, accepted: sql<number>`count(*) filter (where ${accepted})::int`, won: sql<number>`count(*) filter (where ${accepted} and ${won})::int` })
      .from(s.scoutCandidates)
      .innerJoin(s.scoutSearches, eq(s.scoutCandidates.searchId, s.scoutSearches.id))
      .where(and(searchScope, inRange))
      .groupBy(band),
    db
      .select({
        scoutCents: sumF(sql`case when ${s.enrichmentRuns.kind} = 'scout' then ${s.enrichmentRuns.costCents} else 0 end`),
        enrichCents: sumF(sql`case when ${s.enrichmentRuns.kind} = 'enrich' then ${s.enrichmentRuns.costCents} else 0 end`),
        runs: countInt,
        verified: sumF(s.enrichmentRuns.verifiedCount),
        results: sumF(s.enrichmentRuns.resultsCount),
      })
      .from(s.enrichmentRuns)
      .where(and(ownerFilter(ctx, s.enrichmentRuns.requestedBy), gte(s.enrichmentRuns.createdAt, from), lte(s.enrichmentRuns.createdAt, to))),
    getSetting<{ orgMonthlyCents?: number }>("scout.budget", {}),
    ctx.orgWide
      ? db.select({ cents: sumF(s.enrichmentRuns.costCents) }).from(s.enrichmentRuns).where(gte(s.enrichmentRuns.createdAt, monthStart))
      : Promise.resolve([null]),
  ]);

  const counts = funnelFromFlags(
    cands.map((c) => [true, Boolean(c.accepted), Boolean(c.contacted), Boolean(c.won)]),
    SCOUT_STEPS.length,
  );
  const totalCostUsd = ((cost?.scoutCents ?? 0) + (cost?.enrichCents ?? 0)) / 100;
  return {
    counts,
    bySearch: bySearch.sort((a, b) => b.found - a.found),
    byBand: FIT_BANDS.map((b) => byBand.find((r) => r.band === b) ?? { band: b, found: 0, accepted: 0, won: 0 }),
    cost: {
      scoutUsd: (cost?.scoutCents ?? 0) / 100,
      enrichUsd: (cost?.enrichCents ?? 0) / 100,
      totalUsd: totalCostUsd,
      runs: cost?.runs ?? 0,
      verifiedRate: cost?.results ? (cost.verified ?? 0) / cost.results : null,
      perAccepted: counts[1] ? totalCostUsd / counts[1] : null,
    },
    budget: monthSpend ? { usedUsd: monthSpend.cents / 100, capUsd: (budget.orgMonthlyCents ?? 1000) / 100 } : null,
  };
}
