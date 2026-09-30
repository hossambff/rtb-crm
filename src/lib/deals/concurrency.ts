/**
 * Run async thunks with bounded concurrency, preserving result order (typed tuple).
 *
 * Why: the postgres-js pool is max 5 behind Supabase's transaction pooler. When more queries are in flight than
 * connections, postgres-js pipelines several queries on one connection, which the pooler mishandles (requests hang
 * ~30s then fail with ECONNRESET). Page loaders must therefore keep ≤3 queries in flight (layout uses the rest).
 */
export async function allLimited<T extends readonly unknown[]>(thunks: { [K in keyof T]: () => Promise<T[K]> }, limit = 3): Promise<T> {
  const fns = thunks as unknown as (() => Promise<unknown>)[];
  const out = new Array<unknown>(fns.length);
  let next = 0;
  const worker = async () => {
    while (next < fns.length) {
      const i = next++;
      out[i] = await fns[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, worker));
  return out as unknown as T;
}
