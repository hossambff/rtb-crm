import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
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
const POOL_MAX = Math.max(1, Number(process.env.DB_POOL_MAX ?? 5));
const globalForDb = globalThis as unknown as { __rsoSql?: ReturnType<typeof postgres>; __rsoLimited?: ReturnType<typeof postgres> };
const client =
  globalForDb.__rsoSql ??
  postgres(url, {
    // `max_pipeline` is supported at runtime (postgres/src/index.js) but missing from the type definitions.
    // NOTE: 1 does NOT stop pipelining on its own (the active query isn't counted, so a 2nd query can be written behind
    // it), and 0 breaks transactions (postgres-js then never reserves the connection → UNSAFE_TRANSACTION and a
    // stray BEGIN left open on a pooled backend). Keep 1 and rely on `limitInFlight` below.
    ...({ max_pipeline: 1 } as object),
    prepare: false,
    max: POOL_MAX,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    connect_timeout: 15,
    ssl: "require",
  });
if (process.env.NODE_ENV !== "production") globalForDb.__rsoSql = client;

type Sql = ReturnType<typeof postgres>;
type Waiter = () => void;

/**
 * QA-01: never pipeline through the Supavisor transaction pooler. postgres-js dispatches a query to an idle
 * connection, else opens a new one, and only when all `max` connections are busy does it write the query BEHIND a
 * running one (pipelining) — which interleaves statements/params across pooled backends and leaves backends stuck
 * in ClientRead: requests hang ~30 s, then ECONNRESET / "Failed query". Keeping at most `max` top-level queries +
 * open transactions in flight guarantees a free connection for every query, so nothing is ever pipelined; excess
 * work waits here (FIFO) instead of on the wire. A transaction holds its slot until COMMIT/ROLLBACK; queries inside
 * it run on its reserved connection and are not limited (so code inside a transaction must use `tx`, never `db`).
 * If code inside a transaction does reach for the global `db`, waiting for a slot could deadlock (every slot held by
 * a transaction waiting on itself), so such a query bypasses the limiter and a warning names the bug (H-03 class).
 */
const inTransaction = new AsyncLocalStorage<true>();
let warnedNested = 0;
function limitInFlight(sqlClient: Sql, max: number): Sql {
  let active = 0;
  const waiters: Waiter[] = [];
  const acquire = () => (active < max ? (active++, Promise.resolve()) : new Promise<void>((r) => waiters.push(r)));
  const release = () => {
    const next = waiters.shift();
    if (next) next(); // hand the slot over
    else active--;
  };
  const run = async <T>(work: () => PromiseLike<T>): Promise<T> => {
    if (inTransaction.getStore()) {
      if (warnedNested++ < 20) console.warn("[db] global db used inside a transaction — pass the tx instead (pool starvation risk)", new Error().stack?.split("\n").slice(3, 6).join(" <- "));
      return await work();
    }
    await acquire();
    try {
      return await work();
    } finally {
      release();
    }
  };
  // drizzle's postgres-js session only calls `await client.unsafe(q, p)`, `await client.unsafe(q, p).values()` and
  // `client.begin(fn)`; everything else (options, parsers, end, …) passes through to the real client.
  return new Proxy(sqlClient, {
    get(target, prop, receiver) {
      if (prop === "unsafe")
        return (query: string, params?: unknown[], opts?: unknown) => {
          const make = () => (target.unsafe as (...a: unknown[]) => ReturnType<Sql["unsafe"]>)(query, params, opts);
          return {
            values: () => run(() => make().values()),
            then: <R1, R2>(ok?: ((v: unknown) => R1 | PromiseLike<R1>) | null, bad?: ((e: unknown) => R2 | PromiseLike<R2>) | null) => run(() => make()).then(ok, bad),
          };
        };
      if (prop === "begin")
        return (...args: unknown[]) => run(() => inTransaction.run(true, () => (target.begin as (...a: unknown[]) => Promise<unknown>)(...args)));
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * CR L1: run `fn` outside the "in transaction" async context. `after()` callbacks and fire-and-forget work scheduled
 * from code that runs inside a transaction inherit that AsyncLocalStorage flag, so their global-`db` queries would skip
 * the limiter (and log the nested-transaction warning) long after the transaction committed. Wrap them with this.
 */
export function outsideTransaction<T>(fn: () => T): T {
  return inTransaction.exit(fn);
}

// ONE limiter per client, process-wide: the bundler can instantiate this module more than once (separate route bundles /
// server layers, and every HMR re-evaluation in dev) while the client itself is shared via globalThis. Separate limiter
// instances would each admit POOL_MAX queries onto the same POOL_MAX connections → pipelining → stuck backends.
const limited = globalForDb.__rsoLimited ?? limitInFlight(client, POOL_MAX);
if (process.env.NODE_ENV !== "production") globalForDb.__rsoLimited = limited;
export const db = drizzle(limited, { schema, casing: "snake_case" });
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
