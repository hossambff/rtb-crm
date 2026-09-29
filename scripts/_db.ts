/** DB client for CLI scripts (no "server-only" import). Uses the session pooler. */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";

export function scriptDb() {
  const url = process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_SESSION / DATABASE_URL not set (.env.local)");
  const client = postgres(url, { max: 3, ssl: "require", prepare: false, onnotice: () => {} });
  return { db: drizzle(client, { schema }), close: () => client.end(), client };
}
