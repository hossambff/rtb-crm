import "server-only";
import { eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { aggregateSnapshot, type SnapshotDeal } from "./snapshot-core";

/**
 * Nightly pipeline snapshot (cron /api/cron/snapshot, 23:55 UTC): per pipeline × stage counts, MUU, gross,
 * weighted and override-weighted cents → rso.pipeline_snapshots, upserted by (takenOn, pipeline, stage).
 * Restricted deals are included: snapshots are org aggregates, never exposed per record.
 */
export async function takePipelineSnapshot(now = new Date()): Promise<{ takenOn: string; rows: number }> {
  const takenOn = now.toISOString().slice(0, 10);
  const [deals, stages] = await Promise.all([
    db
      .select({
        pipelineKey: s.pipelines.key,
        stageKey: s.stages.key,
        unit: s.pipelines.unit,
        muu: s.deals.muu,
        usdPerMuu: s.deals.usdPerMuu,
        pipelineUsdPerMuu: s.pipelines.usdPerMuu,
        revSharePct: s.deals.revSharePct,
        pipelineRevSharePct: s.pipelines.defaultRevSharePct,
        contractValueCents: s.deals.contractValueCents,
        annualizedValueCents: s.deals.annualizedValueCents,
        stageProbability: s.stages.probability,
        probabilityOverride: s.deals.probabilityOverride,
        overrideStatus: s.deals.overrideStatus,
      })
      .from(s.deals)
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .where(isNull(s.deals.deletedAt)),
    db
      .select({ pipelineKey: s.pipelines.key, stageKey: s.stages.key })
      .from(s.stages)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.stages.pipelineId))
      .where(eq(s.pipelines.active, true)),
  ]);
  const rows = aggregateSnapshot(deals as SnapshotDeal[], stages);
  if (rows.length) {
    await db
      .insert(s.pipelineSnapshots)
      .values(rows.map((r) => ({ takenOn, ...r })))
      .onConflictDoUpdate({
        target: [s.pipelineSnapshots.takenOn, s.pipelineSnapshots.pipelineKey, s.pipelineSnapshots.stageKey],
        set: {
          dealCount: sql`excluded.deal_count`,
          muu: sql`excluded.muu`,
          grossCents: sql`excluded.gross_cents`,
          weightedCents: sql`excluded.weighted_cents`,
          overrideWeightedCents: sql`excluded.override_weighted_cents`,
        },
      });
  }
  return { takenOn, rows: rows.length };
}
