import { cache } from "react";

/**
 * Dashboard query fan-out (M-21).
 *
 * History: this used to be a PROCESS-WIDE semaphore (2 slots) shared by every request, because postgres-js pipelined
 * statements on one connection and the Supabase transaction pooler stalled them. The DB client now sets
 * `max_pipeline: 1` (src/db/index.ts), so postgres-js queues excess queries per connection instead of pipelining —
 * the global queue only added head-of-line blocking (user B's dashboard waited behind user A's).
 *
 * Now the limit is PER REQUEST (React `cache()` scopes the semaphore to one server render): one dashboard keeps at
 * most 3 queries in flight, leaving pool connections (DB_POOL_MAX=5) for other requests on the instance. Outside a
 * request (cron, scripts) every call gets its own semaphore, i.e. no cross-caller queue. Drizzle queries are lazy
 * thenables, so a wrapped query starts only when it gets a slot. Don't nest: never wrap work that itself awaits
 * `limited` (it would hold a slot while waiting for another).
 */
const PER_REQUEST = 3;

type Semaphore = { active: number; waiters: (() => void)[] };
const requestSemaphore = cache((): Semaphore => ({ active: 0, waiters: [] }));

export async function limited<T>(work: PromiseLike<T>): Promise<T> {
  const sem = requestSemaphore();
  if (sem.active < PER_REQUEST) sem.active++;
  else await new Promise<void>((resolve) => sem.waiters.push(resolve)); // the releasing holder hands its slot over
  try {
    return await work;
  } finally {
    const next = sem.waiters.shift();
    if (next) next();
    else sem.active--;
  }
}

/** Promise.all over lazy queries with the per-request bound, preserving order. */
export function limitedAll<T extends readonly unknown[] | []>(works: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  return Promise.all(works.map((w) => limited(w as PromiseLike<unknown>))) as never;
}
