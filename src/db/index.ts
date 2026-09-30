import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

/**
 * Supabase transaction pooler (port 6543) → prepared statements must be disabled.
 * A single client is reused across requests on the same Fluid Compute instance.
 */
const globalForDb = globalThis as unknown as { __rsoSql?: ReturnType<typeof postgres> };
const client =
  globalForDb.__rsoSql ??
  postgres(url, {
    // `max_pipeline` is supported at runtime (postgres/src/index.js) but missing from the type definitions.
    ...({ max_pipeline: 1 } as object),
    prepare: false,
    // Supabase transaction pooler (Supavisor) must not receive pipelined queries on one client connection:
    // pipelining can interleave statements/params across pooled backends. One in-flight query per connection.
    max: Number(process.env.DB_POOL_MAX ?? 5),
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    connect_timeout: 15,
    ssl: "require",
  });
if (process.env.NODE_ENV !== "production") globalForDb.__rsoSql = client;

export const db = drizzle(client, { schema, casing: "snake_case" });
export type DB = typeof db;
export { schema };
