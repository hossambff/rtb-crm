/**
 * Install three INACTIVE, shared starter sequences (NET publisher outreach, Roundtable 100 invite, re-engagement) from
 * src/lib/sequences/starters.ts. Owned by no one (team sequences): an admin reviews the copy, then activates or
 * duplicates them. Idempotent and non-destructive: a sequence with the same name (not deleted) is left untouched.
 * Every template is checked against the live claims library first; a banned/restricted hit aborts that sequence.
 * Usage: npx tsx scripts/seed-sequences.ts [--dry-run]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { and, eq, isNull } from "drizzle-orm";
import { scriptDb } from "./_db";
import * as s from "../src/db/schema";
import { STARTER_SEQUENCES } from "../src/lib/sequences/starters";
import { validateSequence } from "../src/lib/sequences/core";
import { findClaimHits, type ClaimRule } from "../src/lib/claims-core";

async function main() {
  const dry = process.argv.includes("--dry-run");
  const { db, close } = scriptDb();
  let created = 0;
  let kept = 0;
  let refused = 0;
  try {
    const rules = (await db.select({ id: s.claims.id, text: s.claims.text, pattern: s.claims.pattern, status: s.claims.status, approvedAlternative: s.claims.approvedAlternative }).from(s.claims)) as ClaimRule[];
    for (const q of STARTER_SEQUENCES) {
      const problems = validateSequence(q.steps);
      if (problems.length) throw new Error(`${q.name}: ${problems.join("; ")}`);
      const text = q.steps.map((st) => [st.subject, st.body, st.title].filter(Boolean).join("\n")).join("\n\n");
      const hits = findClaimHits(text, rules);
      if (hits.length) {
        refused++;
        console.log(`  REFUSED ${q.name}: claims hits ${hits.map((h) => `${h.status} "${h.match}"`).join(", ")}`);
        continue;
      }
      const [existing] = await db.select({ id: s.sequences.id }).from(s.sequences).where(and(eq(s.sequences.name, q.name), isNull(s.sequences.deletedAt)));
      if (existing) {
        kept++;
        console.log(`  keep ${q.name} (already exists)`);
        continue;
      }
      console.log(`  ${dry ? "would create" : "create"} ${q.name}: ${q.steps.length} steps, inactive, shared`);
      if (dry) {
        created++;
        continue;
      }
      const [row] = await db
        .insert(s.sequences)
        .values({ name: q.name, description: q.description, ownerId: null, shared: true, active: false, steps: q.steps, exitOn: q.exitOn, dailyCap: q.dailyCap, pipelineKeys: q.pipelineKeys })
        .returning({ id: s.sequences.id });
      await db.insert(s.auditLog).values({ actorId: null, actorKind: "system", action: "sequence.create", entity: "sequence", entityId: row!.id, after: { name: q.name, source: "scripts/seed-sequences.ts", active: false } as never });
      created++;
    }
    console.log(`${dry ? "[dry run] " : ""}created ${created}, kept ${kept}, refused ${refused}`);
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
