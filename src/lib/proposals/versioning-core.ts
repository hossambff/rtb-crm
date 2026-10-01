import { isUniqueViolation } from "@/lib/admin/config-schemas";

/** Pure helpers for proposal version numbering (client-safe, unit tested). */
export const VERSION_UNIQUE_INDEX = "proposals_deal_kind_version_uq";

/** Is `e` the unique violation on (deal_id, kind, version)? (drizzle wraps the driver error in `cause`). */
export function isVersionConflict(e: unknown): boolean {
  if (!isUniqueViolation(e)) return false;
  const name = (x: unknown): unknown => {
    if (typeof x !== "object" || x === null) return undefined;
    const r = x as { constraint_name?: unknown; constraint?: unknown };
    return r.constraint_name ?? r.constraint;
  };
  const c = name(e) ?? name((e as { cause?: unknown } | null)?.cause);
  // No constraint name (other drivers): a unique violation on a version insert is the version race.
  return c === undefined || c === VERSION_UNIQUE_INDEX;
}

/**
 * Run `create` (which must recompute the next version itself); on a version conflict run it once more, and if that
 * conflicts too throw `exhausted()`. Any other error propagates unchanged.
 */
export async function retryOnVersionConflict<T>(create: () => Promise<T>, exhausted: () => Error): Promise<T> {
  try {
    return await create();
  } catch (e) {
    if (!isVersionConflict(e)) throw e;
  }
  try {
    return await create();
  } catch (e) {
    if (isVersionConflict(e)) throw exhausted();
    throw e;
  }
}
