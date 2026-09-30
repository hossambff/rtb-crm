import "server-only";
import { limitedAll } from "./limit";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import * as s from "@/db/schema";
import { dealScopeWhere, type AnalyticsContext } from "./scope";
import { countInt, muu, prob, sumF } from "./value-sql";

export const NETDEV_KEYS = ["NET", "SPT"] as const;

/** NetDev & Sports (PRD §14.2): MUU pipeline by category / league / region, migrating & live, guarantee exposure. */
export async function netdevSports(ctx: AnalyticsContext) {
  const keys = ctx.filters.pipeline && (NETDEV_KEYS as readonly string[]).includes(ctx.filters.pipeline) ? [ctx.filters.pipeline] : [...NETDEV_KEYS];
  const where = and(await dealScopeWhere(ctx, { ignorePipelineFilter: true }), inArray(s.pipelines.key, keys));
  const p = prob(ctx.filters.overrides);
  const open = eq(s.stages.category, "open");
  const dim = (col: AnyPgColumn) => sql<string>`coalesce(nullif(btrim(${col}), ''), 'Uncategorised')`;
  const region = sql<string>`coalesce(nullif(btrim(${s.accounts.region}), ''), nullif(btrim(${s.accounts.country}), ''), 'Unknown')`;

  const base = () =>
    db
      .select({ muu: sumF(muu), weightedMuu: sumF(sql`${muu} * ${p}`), deals: countInt })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
      .leftJoin(s.accounts, eq(s.deals.accountId, s.accounts.id));

  const byDim = (d: ReturnType<typeof dim> | typeof region, extra?: ReturnType<typeof eq>) =>
    db
      .select({ label: d, pipeline: s.pipelines.key, muu: sumF(muu), weightedMuu: sumF(sql`${muu} * ${p}`), deals: countInt })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
      .leftJoin(s.accounts, eq(s.deals.accountId, s.accounts.id))
      .where(and(where, open, extra))
      .groupBy(d, s.pipelines.key);

  const [byCategory, byLeague, byRegion, [totals], [estimated], wonStages, guarantee] = await limitedAll([
    byDim(dim(s.accounts.category)),
    byDim(dim(s.accounts.league), eq(s.pipelines.key, "SPT")),
    byDim(region),
    base().where(and(where, open)),
    db
      .select({ muu: sumF(muu) })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
      .leftJoin(s.accounts, eq(s.deals.accountId, s.accounts.id))
      .where(and(where, open, sql`${s.accounts.muuConfidence} is distinct from 'verified'`)),
    db
      .select({ pipeline: s.pipelines.key, stage: s.stages.name, key: s.stages.key, sortOrder: s.stages.sortOrder, deals: countInt, muu: sumF(muu) })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
      .where(and(where, eq(s.stages.category, "won")))
      .groupBy(s.pipelines.key, s.stages.name, s.stages.key, s.stages.sortOrder),
    ctx.guaranteeAllowed
      ? db
          .select({
            committed: sumF(sql`case when ${s.deals.status} = 'won' then coalesce(${s.deals.guaranteeMonthlyCents}, 0) else 0 end`),
            committedDeals: sql<number>`count(*) filter (where ${s.deals.status} = 'won' and coalesce(${s.deals.guaranteeMonthlyCents}, 0) > 0)::int`,
            proposed: sumF(sql`case when ${s.stages.category} = 'open' then coalesce(${s.deals.guaranteeMonthlyCents}, 0) * ${p} else 0 end`),
            proposedDeals: sql<number>`count(*) filter (where ${s.stages.category} = 'open' and coalesce(${s.deals.guaranteeMonthlyCents}, 0) > 0)::int`,
          })
          .from(s.deals)
          .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
          .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
          .where(where)
      : Promise.resolve(null),
  ]);

  const migrating = wonStages.filter((r) => /migrat|onboard/i.test(r.key)).reduce((a, r) => a + r.deals, 0);
  const live = wonStages.filter((r) => !/migrat|onboard/i.test(r.key)).reduce((a, r) => a + r.deals, 0);
  const g = guarantee?.[0];
  return {
    keys,
    byCategory,
    byLeague,
    byRegion,
    totals: totals ?? { muu: 0, weightedMuu: 0, deals: 0 },
    estimatedMuu: estimated?.muu ?? 0,
    wonStages,
    migrating,
    live,
    guarantee: g ? { committed: g.committed / 100, committedDeals: g.committedDeals, proposed: g.proposed / 100, proposedDeals: g.proposedDeals } : null,
  };
}
