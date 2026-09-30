import "server-only";
import { limited } from "./limit";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { dealScopeWhere, type AnalyticsContext } from "./scope";
import { funnelFromFlags } from "./transforms";

export const FUNNEL_STEPS = ["Outreach", "Reply", "Meeting", "Qualified"] as const;

export type FunnelGroup = { label: string; counts: number[] };

/**
 * SDR / intern funnel (PRD §14.2): outreach → reply → meeting → qualified, for the cohort of deals created in the
 * date range, by rep (owner) and by source list.
 * - Outreach: outbound email / LinkedIn / call on the deal, or the deal moved past its first stage.
 * - Reply: inbound email / LinkedIn on the deal.
 * - Meeting: a meeting logged on the deal (activity or calendar meeting).
 * - Qualified: the deal reached an engaged stage (probability ≥ engaged threshold) or was won — the handoff point.
 * Later steps imply earlier ones (funnelFromFlags), so the funnel is monotonic.
 */
export async function sdrFunnel(ctx: AnalyticsContext) {
  const threshold = await getSetting<number>("pipeline.engaged_threshold", 0.5);
  const where = await dealScopeWhere(ctx);
  const outbound = sql<boolean>`exists (select 1 from ${s.activities} a where a.deal_id = ${s.deals.id} and a.direction = 'outbound' and a.type in ('email','linkedin','call'))`;
  const movedPastFirst = sql<boolean>`exists (select 1 from ${s.dealStageHistory} h join ${s.stages} hs on hs.id = h.to_stage_id where h.deal_id = ${s.deals.id} and hs.sort_order > 0)`;
  const reply = sql<boolean>`exists (select 1 from ${s.activities} a where a.deal_id = ${s.deals.id} and a.direction = 'inbound' and a.type in ('email','linkedin'))`;
  const meeting = sql<boolean>`(exists (select 1 from ${s.activities} a where a.deal_id = ${s.deals.id} and a.type = 'meeting') or exists (select 1 from ${s.meetings} mt where mt.deal_id = ${s.deals.id} and mt.starts_at <= now()))`;
  const qualified = sql<boolean>`(${s.stages.category} = 'won' or ${s.stages.probability} >= ${threshold} or exists (select 1 from ${s.dealStageHistory} h join ${s.stages} hs on hs.id = h.to_stage_id where h.deal_id = ${s.deals.id} and (hs.probability >= ${threshold} or hs.category = 'won')))`;
  const rows = await limited(db
    .select({
      ownerId: s.deals.ownerId,
      owner: s.user.name,
      source: sql<string>`coalesce(nullif(btrim(${s.deals.source}), ''), 'Unknown')`,
      outreach: sql<boolean>`(${outbound} or ${movedPastFirst} or ${s.stages.sortOrder} > 0)`,
      reply,
      meeting,
      qualified,
    })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
    .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
    .leftJoin(s.user, eq(s.deals.ownerId, s.user.id))
    .where(and(where, gte(s.deals.createdAt, ctx.filters.from), lte(s.deals.createdAt, ctx.filters.to)))
    .limit(20000));

  const flags = (r: (typeof rows)[number]) => [Boolean(r.outreach), Boolean(r.reply), Boolean(r.meeting), Boolean(r.qualified)];
  const group = (key: (r: (typeof rows)[number]) => string): FunnelGroup[] => {
    const m = new Map<string, boolean[][]>();
    for (const r of rows) {
      const k = key(r);
      const list = m.get(k) ?? [];
      list.push(flags(r));
      m.set(k, list);
    }
    return [...m.entries()]
      .map(([label, recs]) => ({ label, counts: [recs.length, ...funnelFromFlags(recs, FUNNEL_STEPS.length)] }))
      .sort((a, b) => b.counts[0]! - a.counts[0]!);
  };
  return {
    cohort: rows.length,
    overall: funnelFromFlags(rows.map(flags), FUNNEL_STEPS.length),
    byRep: group((r) => r.owner ?? "Unassigned"),
    bySource: group((r) => r.source),
    threshold,
  };
}
