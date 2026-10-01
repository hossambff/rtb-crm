import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";

export type RevenueQuota = { usd: number; proposed: boolean };

/**
 * Revenue quotas (US dollars) per person for a period — the only metric the $ forecast can be compared with. When a
 * motion is given, only that motion's lines count; otherwise every revenue line (incl. "all motions") is summed.
 * Proposed (not yet confirmed) quotas are included but flagged.
 */
export async function revenueQuotas(userIds: string[], period: string, motion: string | null = null): Promise<Map<string, RevenueQuota>> {
  const out = new Map<string, RevenueQuota>();
  if (!userIds.length) return out;
  const rows = await db
    .select({ userId: s.quotas.userId, pipelineKey: s.quotas.pipelineKey, target: s.quotas.target, status: s.quotas.status })
    .from(s.quotas)
    .where(and(inArray(s.quotas.userId, userIds.slice(0, 500)), eq(s.quotas.period, period), eq(s.quotas.metric, "revenue_usd")));
  for (const r of rows) {
    if (motion && r.pipelineKey !== motion) continue;
    const cur = out.get(r.userId) ?? { usd: 0, proposed: false };
    out.set(r.userId, { usd: cur.usd + r.target / 100, proposed: cur.proposed || r.status === "proposed" });
  }
  return out;
}
