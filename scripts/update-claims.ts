/**
 * QA-02: idempotently update the seeded banned-claim patterns in rso.claims to the paraphrase-tolerant versions in
 * src/lib/claims-patterns.ts. Rows are matched by claim text; admin-created claims are never touched; rows already
 * on the current pattern are skipped. Usage: npx tsx scripts/update-claims.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { eq } from "drizzle-orm";
import { scriptDb } from "./_db";
import * as s from "../src/db/schema";
import { CLAIM_PATTERN_UPDATES } from "../src/lib/claims-patterns";

async function main() {
  const { db, close } = scriptDb();
  try {
    for (const u of CLAIM_PATTERN_UPDATES) {
      new RegExp(u.pattern, "i"); // fail fast on a bad pattern
      const rows = await db.select({ id: s.claims.id, pattern: s.claims.pattern }).from(s.claims).where(eq(s.claims.text, u.text));
      if (!rows.length) {
        console.log(`skip (not in library): ${u.text}`);
        continue;
      }
      for (const r of rows) {
        if (r.pattern === u.pattern) {
          console.log(`up to date: ${u.text}`);
          continue;
        }
        await db.update(s.claims).set({ pattern: u.pattern }).where(eq(s.claims.id, r.id));
        await db.insert(s.auditLog).values({
          actorId: null,
          actorKind: "system",
          action: "claim.pattern_update",
          entity: "claim",
          entityId: r.id,
          before: { pattern: r.pattern } as never,
          after: { pattern: u.pattern, source: "scripts/update-claims.ts (QA-02)" } as never,
        });
        console.log(`updated: ${u.text}`);
      }
    }
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
