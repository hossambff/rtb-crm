import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { aggregateSnapshot, type SnapshotDeal } from "./snapshot-core";

/**
 * Nightly pipeline snapshot (cron /api/cron/snapshot, 23:55 UTC): per pipeline × OPEN stage counts, MUU, gross,
 * weighted (stage probability) and override-weighted (approved overrides) cents → rso.pipeline_snapshots, upserted
 * by (takenOn, pipeline, stage). Won/lost/hold stages are not pipeline and are not snapshotted (H-01/M-10).
 * SEC H-4 / M-7: restricted (MNPI) deals are excluded — snapshots feed the weekly digest and the executive trend,
 * whose audiences are not on the restricted access lists.
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
        stageCategory: s.stages.category,
      })
      .from(s.deals)
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .where(and(isNull(s.deals.deletedAt), eq(s.deals.restricted, false), eq(s.stages.category, "open"))),
    db
      .select({ pipelineKey: s.pipelines.key, stageKey: s.stages.key, category: s.stages.category })
      .from(s.stages)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.stages.pipelineId))
      .where(and(eq(s.pipelines.active, true), eq(s.stages.category, "open"))),
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
