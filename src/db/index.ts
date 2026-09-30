import "server-only";
import { sql } from "drizzle-orm";
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
/** A transaction handle (the `tx` passed to `db.transaction(async (tx) => …)`). */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/**
 * Anything that can run a query: the pool or an open transaction. Helpers that may be called inside a transaction take
 * `q: Executor = db` and must use `q` for EVERY query — a helper that reaches for the global `db` while its caller holds
 * a transaction needs a second pooled connection (pool starvation / deadlock with DB_POOL_MAX=5 behind the pooler).
 */
export type Executor = DB | Tx;

/**
 * Run `fn` in a transaction that first takes a transaction-scoped advisory lock on `key` (released at COMMIT/ROLLBACK).
 * Session-level `pg_advisory_lock` is invalid behind the Supavisor transaction pooler; the xact variant is safe.
 * `mode: "try"` returns `{ locked: false }` immediately instead of queueing behind a running holder.
 */
export async function withXactLock<T>(key: string, fn: (tx: Tx) => Promise<T>, mode: "wait" | "try" = "wait"): Promise<{ locked: true; value: T } | { locked: false }> {
  return db.transaction(async (tx) => {
    if (mode === "try") {
      const rows = (await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${key})) as ok`)) as unknown as { ok: boolean }[];
      if (!rows[0]?.ok) return { locked: false as const };
    } else {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    }
    return { locked: true as const, value: await fn(tx) };
  });
}
export { schema };
