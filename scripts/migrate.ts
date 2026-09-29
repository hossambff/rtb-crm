import { config } from "dotenv";
config({ path: ".env.local" });
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_SESSION not set");
  const sql = postgres(url, { max: 1, ssl: "require", onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "drizzle", migrationsSchema: "rso", migrationsTable: "__drizzle_migrations" });
  // Defense in depth (idempotent): RLS on every rso table, incl. ones added by later migrations.
  await sql`DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'rso' AND NOT rowsecurity LOOP EXECUTE format('ALTER TABLE rso.%I ENABLE ROW LEVEL SECURITY', r.tablename); END LOOP; END $$`;
  const [{ n }] = await sql`select count(*)::int as n from pg_tables where schemaname = 'rso'`;
  console.log(`migrations applied; rso tables = ${n}`);
  await sql.end();
}
main().catch((e) => {
  console.error("MIGRATION FAILED:", e);
  process.exit(1);
});
