/** Pure helpers for the audit viewer (unit-tested): JSON diff, CSV export, filter parsing. */

export type DiffEntry = { path: string; kind: "added" | "removed" | "changed"; before?: unknown; after?: unknown };

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Shallow-recursive diff of two JSON values (objects recurse, arrays/primitives compare by JSON). */
export function jsonDiff(before: unknown, after: unknown, prefix = "", depth = 0): DiffEntry[] {
  if (isObj(before) && isObj(after) && depth < 4) {
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
    const out: DiffEntry[] = [];
    for (const k of keys) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!(k in before)) out.push({ path: p, kind: "added", after: after[k] });
      else if (!(k in after)) out.push({ path: p, kind: "removed", before: before[k] });
      else out.push(...jsonDiff(before[k], after[k], p, depth + 1));
    }
    return out;
  }
  if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return [];
  const path = prefix || "(value)";
  if (before == null) return [{ path, kind: "added", after }];
  if (after == null) return [{ path, kind: "removed", before }];
  return [{ path, kind: "changed", before, after }];
}

/** Keys that are pure bookkeeping — hidden from the diff view by default. */
export const NOISY_KEYS = new Set(["updatedAt", "updated_at"]);

export function visibleDiff(entries: DiffEntry[]): DiffEntry[] {
  return entries.filter((e) => !NOISY_KEYS.has(e.path.split(".").pop() ?? ""));
}

/** CSV cell: quote when needed; neutralise spreadsheet formula injection (=, +, -, @, tab, CR). */
export function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = typeof v === "string" ? v : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n") + "\r\n";
}

export type AuditFilters = { actor: string | null; entity: string | null; action: string | null; from: string | null; to: string | null; page: number };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || null;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseAuditFilters(sp: SP): AuditFilters {
  const page = Number(one(sp.page) ?? "1");
  const from = one(sp.from);
  const to = one(sp.to);
  const clip = (s: string | null, n: number) => (s ? s.slice(0, n) : null);
  return {
    actor: clip(one(sp.actor), 64),
    entity: clip(one(sp.entity), 64),
    action: clip(one(sp.action), 120),
    from: from && DATE_RE.test(from) ? from : null,
    to: to && DATE_RE.test(to) ? to : null,
    page: Number.isInteger(page) && page > 0 && page < 10_000 ? page : 1,
  };
}

export function auditQuery(f: AuditFilters, patch: Partial<Record<keyof AuditFilters, string | number | null>> = {}): string {
  const merged: Record<string, string | number | null> = { ...f, ...patch };
  if (merged.page === 1) merged.page = null;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) if (v != null && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : "";
}
