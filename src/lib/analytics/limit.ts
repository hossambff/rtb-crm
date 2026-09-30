/**
 * Bounded concurrency for dashboard queries. A dashboard fans out 10+ aggregate queries; firing them all at once
 * makes postgres-js pipeline several statements on one pooled connection, which the Supabase transaction pooler
 * doesn't tolerate (statements stall in ClientRead). Drizzle queries are lazy thenables, so wrapping them delays
 * execution until a slot is free. Process-wide limit.
 */
const MAX = 2;
let active = 0;
const waiters: (() => void)[] = [];

async function acquire() {
  if (active < MAX) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function release() {
  active--;
  waiters.shift()?.();
}

export async function limited<T>(work: PromiseLike<T>): Promise<T> {
  await acquire();
  try {
    return await work;
  } finally {
    release();
  }
}

/** Promise.all over lazy queries with bounded concurrency. */
export function limitedAll<T extends readonly unknown[] | []>(works: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  return Promise.all(works.map((w) => limited(w as PromiseLike<unknown>))) as never;
}
