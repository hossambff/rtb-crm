/**
 * Install the default stage playbooks (V2 §A7) for NET / SPT / ENT / R100 / ADS from src/lib/playbooks/defaults.ts.
 * Idempotent and non-destructive: a stage that already has a playbook (edited by an admin or not) is left untouched;
 * stages that don't exist are skipped. Every insert is audit-logged as a system action.
 * Usage: npx tsx scripts/seed-playbooks.ts [--dry-run]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { eq, inArray } from "drizzle-orm";
import { scriptDb } from "./_db";
import * as s from "../src/db/schema";
import { DEFAULT_PLAYBOOKS } from "../src/lib/playbooks/defaults";
import { playbookInputSchema } from "../src/lib/playbooks/core";

async function main() {
  const dry = process.argv.includes("--dry-run");
  const { db, close } = scriptDb();
  let created = 0;
  let kept = 0;
  let missing = 0;
  try {
    const pipelines = await db.select({ id: s.pipelines.id, key: s.pipelines.key }).from(s.pipelines).where(inArray(s.pipelines.key, Object.keys(DEFAULT_PLAYBOOKS)));
    for (const p of pipelines) {
      const stages = await db.select({ id: s.stages.id, key: s.stages.key, name: s.stages.name }).from(s.stages).where(eq(s.stages.pipelineId, p.id));
      const existing = new Set(
        (await db.select({ stageId: s.stagePlaybooks.stageId }).from(s.stagePlaybooks).where(inArray(s.stagePlaybooks.stageId, stages.map((st) => st.id).concat("00000000-0000-0000-0000-000000000000")))).map((r) => r.stageId),
      );
      for (const [stageKey, pb] of Object.entries(DEFAULT_PLAYBOOKS[p.key] ?? {})) {
        const st = stages.find((x) => x.key === stageKey);
        if (!st) {
          missing++;
          console.log(`  skip ${p.key}/${stageKey}: no such stage`);
          continue;
        }
        if (existing.has(st.id)) {
          kept++;
          continue;
        }
        const input = playbookInputSchema.parse({ stageId: st.id, name: pb.name, guidance: pb.guidance, tasks: pb.tasks, emailTemplates: pb.emailTemplates ?? [], active: true });
        console.log(`  ${dry ? "would create" : "create"} ${p.key}/${st.name}: ${input.tasks.length} tasks, ${input.emailTemplates.length} templates`);
        if (dry) {
          created++;
          continue;
        }
        const rows = await db
          .insert(s.stagePlaybooks)
          .values({ stageId: st.id, name: input.name, guidance: input.guidance || null, tasks: input.tasks, emailTemplates: input.emailTemplates, active: true, updatedBy: null })
          .onConflictDoNothing({ target: s.stagePlaybooks.stageId })
          .returning({ id: s.stagePlaybooks.id });
        if (rows[0]) {
          created++;
          await db.insert(s.auditLog).values({ actorId: null, actorKind: "system", action: "admin.playbook.seed", entity: "stage_playbook", entityId: rows[0].id, after: { pipeline: p.key, stage: st.key } as never });
        } else kept++;
      }
    }
    console.log(`playbooks ${dry ? "(dry run) " : ""}— created ${created}, kept ${kept} existing, ${missing} stage keys not found`);
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
