/** Delete seeded dev.* test accounts (run before go-live). Usage: npx tsx scripts/purge-dev.ts */
import { config } from "dotenv";
config({ path: ".env.local" });
import { like, or } from "drizzle-orm";
import { scriptDb } from "./_db";
import * as s from "../src/db/schema";

async function main() {
  const { db, close } = scriptDb();
  try {
    const removed = await db
      .delete(s.user)
      .where(or(like(s.user.email, "dev.%@roundtable.io"), like(s.user.email, "dev.%@blockchainff.com")))
      .returning({ email: s.user.email });
    console.log(`removed ${removed.length} dev accounts`);
  } finally {
    await close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
