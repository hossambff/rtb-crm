/**
 * ⌘K command execution / undo rules (CR M2, M4) — pure, unit tested.
 *
 * - Undo is compare-and-set: a record is reverted only while it is still in the state the command left it in (stage,
 *   owner, close date). Anything a human changed since is skipped and reported, never overwritten.
 * - Bulk execution runs in chunks under a time budget; what didn't fit is returned as `remaining` so the client can
 *   continue with the same (still valid) preview token, and an undo token always covers what completed.
 */

export const EXECUTE_CHUNK = 25;
/** Server-action time budget for one execute call (well under the function maxDuration). */
export const EXECUTE_BUDGET_MS = 40_000;

export function chunks<T>(xs: readonly T[], size = EXECUTE_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += Math.max(1, size)) out.push(xs.slice(i, i + Math.max(1, size)));
  return out;
}

/**
 * Split `ids` into those still holding `expected` (revert them) and those whose current value differs (skip: a later
 * edit wins). `expected === undefined` = legacy token without the expectation → everything is eligible. Values are
 * compared as strings (dates as ISO); missing rows (deleted / no longer visible) are reported as changed.
 */
export function partitionForUndo(
  ids: readonly string[],
  current: ReadonlyMap<string, string | null>,
  expected: string | null | undefined,
): { eligible: string[]; changed: string[] } {
  const eligible: string[] = [];
  const changed: string[] = [];
  for (const id of ids) {
    if (!current.has(id)) changed.push(id);
    else if (expected === undefined || (current.get(id) ?? null) === (expected ?? null)) eligible.push(id);
    else changed.push(id);
  }
  return { eligible, changed };
}

/** Same calendar day (close dates are stored at 17:00 local of the chosen day — compare the instant). */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return Date.parse(a) === Date.parse(b);
}

/** Fields a command writes, for field-level security (SEC L-5 / CR M3). */
export const COMMAND_FIELD: Record<string, string | null> = { close: "expectedCloseDate", tag: "tags", move: null, assign: null, enroll: null };

export function commandFieldHidden(verb: string, hidden: ReadonlySet<string>): string | null {
  const f = COMMAND_FIELD[verb];
  if (!f) return null;
  return hidden.has(f) || hidden.has("*") ? f : null;
}
