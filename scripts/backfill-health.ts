/**
 * One-time (re-runnable) deal health backfill: recompute health for every non-deleted deal with the same pure logic
 * the app uses (src/lib/deals/health.ts computeHealth) and persist only changed rows.
 * Usage: npx tsx scripts/backfill-health.ts [--dry-run]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { scriptDb } from "./_db";
import * as s from "../src/db/schema";
import { computeHealth } from "../src/lib/deals/health";

async function main() {
  const dry = process.argv.includes("--dry-run");
  const { db, close } = scriptDb();
  const now = new Date();
  try {
    const rows = await db
      .select({ deal: s.deals, category: s.stages.category, slaDays: s.stages.slaDays })
      .from(s.deals)
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
      .where(isNull(s.deals.deletedAt));
    const roleRows = await db.select({ dealId: s.dealContacts.dealId, role: s.dealContacts.role }).from(s.dealContacts);
    const roles = new Map<string, (string | null)[]>();
    for (const r of roleRows) roles.set(r.dealId, [...(roles.get(r.dealId) ?? []), r.role]);
    const overdueRows = await db
      .select({ dealId: s.tasks.dealId, n: sql<number>`count(*)::int` })
      .from(s.tasks)
      .where(and(eq(s.tasks.status, "open"), lt(s.tasks.dueAt, now), sql`${s.tasks.dealId} is not null`))
      .groupBy(s.tasks.dealId);
    const overdue = new Map(overdueRows.map((r) => [r.dealId!, r.n]));

    const changes: { id: string; score: number | null; explanation: string }[] = [];
    const byBand = { healthy: 0, watch: 0, atRisk: 0, critical: 0, unscored: 0 };
    for (const { deal, category, slaDays } of rows) {
      const h = computeHealth({
        now,
        category,
        createdAt: deal.createdAt,
        stageEnteredAt: deal.stageEnteredAt,
        slaDays,
        lastActivityAt: deal.lastActivityAt,
        nextStep: deal.nextStep,
        nextStepDueAt: deal.nextStepDueAt,
        nextStepWaitingReason: deal.nextStepWaitingReason,
        stakeholderRoles: roles.get(deal.id) ?? [],
        overdueTaskCount: overdue.get(deal.id) ?? 0,
        imported: deal.tags?.includes("imported") ?? false,
      });
      if (h.score == null) byBand.unscored++;
      else if (h.score >= 70) byBand.healthy++;
      else if (h.score >= 50) byBand.watch++;
      else if (h.score >= 30) byBand.atRisk++;
      else byBand.critical++;
      if (h.score !== deal.healthScore || h.explanation !== deal.healthExplanation) changes.push({ id: deal.id, score: h.score, explanation: h.explanation });
    }

    let written = 0;
    if (!dry) {
      for (let i = 0; i < changes.length; i += 3) {
        await Promise.all(
          changes.slice(i, i + 3).map((c) => db.update(s.deals).set({ healthScore: c.score, healthExplanation: c.explanation }).where(eq(s.deals.id, c.id))),
        );
        written += Math.min(3, changes.length - i);
        if (written % 300 === 0) console.log(`  … ${written}/${changes.length}`);
      }
    }
    console.log(
      JSON.stringify({ deals: rows.length, open: rows.filter((r) => r.category === "open").length, changed: changes.length, written, dryRun: dry, bands: byBand }, null, 2),
    );
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
