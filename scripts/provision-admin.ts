/**
 * Pre-provision a real admin (no password — signs in with Google; the account links by email on first sign-in).
 * Usage: npx tsx scripts/provision-admin.ts <email> "<name>" [role=super_admin]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { eq } from "drizzle-orm";
import { scriptDb } from "./_db";
import * as s from "../src/db/schema";

async function main() {
  const [email, name = "Admin", role = "super_admin"] = process.argv.slice(2);
  if (!email || !/@(roundtable\.io|blockchainff\.com)$/i.test(email)) throw new Error("email must be on an allowed domain");
  const { db, close } = scriptDb();
  try {
    const [existing] = await db.select().from(s.user).where(eq(s.user.email, email.toLowerCase()));
    if (existing) {
      await db.update(s.user).set({ role, banned: false }).where(eq(s.user.id, existing.id));
      console.log(`updated ${email} → ${role}`);
    } else {
      await db.insert(s.user).values({ id: crypto.randomUUID(), email: email.toLowerCase(), name, role, emailVerified: true, employmentType: "staff" });
      console.log(`created ${email} as ${role}`);
    }
    await db.insert(s.auditLog).values({ actorKind: "system", action: "user.provision_admin", entity: "user", entityId: email.toLowerCase(), after: { role } as never });
  } finally {
    await close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
