import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local" });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  schemaFilter: ["rso"],
  dbCredentials: { url: process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL! },
  migrations: { schema: "rso", table: "__drizzle_migrations" },
  strict: true,
  verbose: true,
});
