import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import * as s from "@/db/schema";

/**
 * SQL mirrors of src/lib/pipeline-math.ts `dealValue` so dashboards can aggregate with GROUP BY instead of loading
 * every deal. Keep these in lock-step with dealValue (same defaults: $/MUU → deal, pipeline, 1; rev share → deal,
 * pipeline, 0.5; override counts only when approved or un-gated). Requires deals ⋈ pipelines ⋈ stages.
 */
export const grossUsd: SQL<number> = sql<number>`(case
  when ${s.pipelines.unit} = 'muu' then greatest(coalesce(${s.deals.muu}, 0), 0)::float8 * coalesce(${s.deals.usdPerMuu}, ${s.pipelines.usdPerMuu}, 1)
  when ${s.pipelines.unit} = 'usd' then coalesce(${s.deals.annualizedValueCents}, ${s.deals.contractValueCents}, 0)::float8 / 100
  else 0 end)`;

const revShare = sql`least(1, greatest(0, coalesce(${s.deals.revSharePct}, ${s.pipelines.defaultRevSharePct}, 0.5)))`;

export const netUsd: SQL<number> = sql<number>`(case
  when ${s.pipelines.unit} = 'muu' then greatest(coalesce(${s.deals.muu}, 0), 0)::float8 * coalesce(${s.deals.usdPerMuu}, ${s.pipelines.usdPerMuu}, 1) * ${revShare}
  when ${s.pipelines.unit} = 'usd' then coalesce(${s.deals.annualizedValueCents}, ${s.deals.contractValueCents}, 0)::float8 / 100
  else 0 end)`;

export const muu: SQL<number> = sql<number>`greatest(coalesce(${s.deals.muu}, 0), 0)::float8`;

export const overridden: SQL<boolean> = sql<boolean>`(${s.deals.probabilityOverride} is not null and (${s.deals.overrideStatus} is null or ${s.deals.overrideStatus} = 'approved'))`;

export const stageProb: SQL<number> = sql<number>`least(1, greatest(0, ${s.stages.probability}))`;

export function prob(includeOverrides: boolean): SQL<number> {
  if (!includeOverrides) return stageProb;
  return sql<number>`(case when ${overridden} then least(1, greatest(0, ${s.deals.probabilityOverride})) else ${stageProb} end)`;
}

export function money(basis: "gross" | "net"): SQL<number> {
  return basis === "net" ? netUsd : grossUsd;
}

/** sum(x)::float8 with 0 for empty groups. */
export function sumF(x: SQL | AnyPgColumn): SQL<number> {
  return sql<number>`coalesce(sum(${x}), 0)::float8`;
}
export const countInt: SQL<number> = sql<number>`count(*)::int`;

/** Timestamp parameter for raw sql templates (postgres-js can't bind a Date without a column type). */
export function ts(d: Date): SQL<Date> {
  return sql<Date>`${d.toISOString()}::timestamptz`;
}
