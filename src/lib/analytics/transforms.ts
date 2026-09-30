/**
 * Pure analytics transforms (unit-tested). SQL does the heavy group-bys (src/lib/analytics/queries.ts); these
 * functions shape, rank and derive the numbers the dashboards show.
 */

export type Money = { gross: number; net: number };

export function pick(m: Money, basis: "gross" | "net"): number {
  return basis === "net" ? m.net : m.gross;
}

export function safeDiv(a: number, b: number): number | null {
  return b ? a / b : null;
}

/** Share of the total held by the top `n` values (PRD §14.2 concentration = top-5 share of engaged weighted). */
export function concentration(values: number[], n = 5): { top: number; total: number; share: number | null } {
  const sorted = values.filter((v) => v > 0).sort((a, b) => b - a);
  const total = sorted.reduce((a, v) => a + v, 0);
  const top = sorted.slice(0, n).reduce((a, v) => a + v, 0);
  return { top, total, share: total ? top / total : null };
}

export type StageRef = { sortOrder: number; category: "open" | "won" | "lost" | "hold"; nurture?: boolean };

/** Nurture/cold/lapsed stages sit after the funnel in sort order but are not progress. */
export function isNurtureStageKey(key: string | null | undefined): boolean {
  return Boolean(key && /cold|nurture|lapsed/i.test(key));
}

/** Classify a stage move as advanced / slipped / lateral (for "new vs advanced vs slipped this week"). */
export function classifyMove(from: StageRef | null, to: StageRef): "advanced" | "slipped" | "lateral" {
  if (to.category === "won") return "advanced";
  if (to.category === "lost" || to.category === "hold" || to.nurture) return from?.nurture && to.nurture ? "lateral" : "slipped";
  if (!from) return "lateral";
  if (from.category !== "open" || from.nurture) return "advanced"; // revived from hold/lost/cold back into the funnel
  if (to.sortOrder > from.sortOrder) return "advanced";
  if (to.sortOrder < from.sortOrder) return "slipped";
  return "lateral";
}

/** Hygiene = share of open deals that have a next step whose due date is set and not overdue. */
export function hygieneScore(openDeals: { nextStep: string | null; nextStepDueAt: Date | string | null }[], now: Date): number | null {
  if (!openDeals.length) return null;
  const ok = openDeals.filter((d) => {
    if (!d.nextStep || !d.nextStep.trim() || !d.nextStepDueAt) return false;
    return new Date(d.nextStepDueAt).getTime() >= startOfDay(now).getTime();
  }).length;
  return ok / openDeals.length;
}

/**
 * Commitments kept % = our commitments (tasks owedBy "us") that came due and were completed by the end of their due
 * day. Cancelled commitments are excluded; open ones past due count as missed.
 */
export function commitmentsKept(
  tasks: { status: "open" | "done" | "cancelled"; dueAt: Date | string | null; completedAt: Date | string | null }[],
  now: Date,
): { kept: number; due: number; rate: number | null } {
  let kept = 0;
  let due = 0;
  for (const t of tasks) {
    if (!t.dueAt || t.status === "cancelled") continue;
    const dueEnd = endOfDay(new Date(t.dueAt));
    if (dueEnd.getTime() > now.getTime() && t.status !== "done") continue; // not yet due
    due++;
    if (t.status === "done" && t.completedAt && new Date(t.completedAt).getTime() <= dueEnd.getTime()) kept++;
  }
  return { kept, due, rate: due ? kept / due : null };
}

export function winRate(won: number, lost: number): number | null {
  return won + lost ? won / (won + lost) : null;
}

/**
 * Historical stage conversion for ordered open stages. For each deal we know the furthest open stage it reached
 * (by sortOrder) and whether it was won (won implies it passed every open stage). A stage's `reached` count is the
 * number of deals that got at least that far; conversion is reached(next) / reached(this), and the last open stage
 * converts to Won.
 */
export function stageConversion(
  openStages: { id: string; name: string; sortOrder: number }[],
  deals: { maxOpenOrder: number | null; won: boolean }[],
): { id: string; name: string; reached: number; nextLabel: string; conversion: number | null }[] {
  const ordered = [...openStages].sort((a, b) => a.sortOrder - b.sortOrder);
  const reached = ordered.map((s) => deals.filter((d) => d.won || (d.maxOpenOrder != null && d.maxOpenOrder >= s.sortOrder)).length);
  const wonCount = deals.filter((d) => d.won).length;
  return ordered.map((s, i) => {
    const next = i + 1 < ordered.length ? reached[i + 1]! : wonCount;
    return {
      id: s.id,
      name: s.name,
      reached: reached[i]!,
      nextLabel: i + 1 < ordered.length ? ordered[i + 1]!.name : "Won",
      conversion: reached[i] ? next / reached[i]! : null,
    };
  });
}

/**
 * Funnel from per-record step flags. A later step implies the earlier ones (a qualified deal was, by definition,
 * reached out to), so flags are propagated backwards before counting — the funnel is always monotonic.
 */
export function funnelFromFlags(records: boolean[][], stepCount: number): number[] {
  const counts = new Array<number>(stepCount).fill(0);
  for (const flags of records) {
    let reached = -1;
    for (let i = stepCount - 1; i >= 0; i--) {
      if (flags[i]) {
        reached = i;
        break;
      }
    }
    for (let i = 0; i <= reached; i++) counts[i]!++;
  }
  return counts;
}

/** Health score → status band (matches palette.healthStatus thresholds). */
export const HEALTH_BANDS = [
  { key: "good", label: "Healthy (70+)", min: 70 },
  { key: "warning", label: "Watch (50–69)", min: 50 },
  { key: "serious", label: "At risk (30–49)", min: 30 },
  { key: "critical", label: "Critical (<30)", min: 0 },
] as const;

export function healthBand(score: number | null | undefined): (typeof HEALTH_BANDS)[number]["key"] | "unscored" {
  if (score == null) return "unscored";
  for (const b of HEALTH_BANDS) if (score >= b.min) return b.key;
  return "critical";
}

/** Pivot long rows (category, series, value) into wide rows for stacked charts. Unknown series fold into "Other". */
export function pivot<T extends Record<string, unknown>>(
  rows: T[],
  categoryKey: keyof T,
  seriesKey: keyof T,
  valueKey: keyof T,
  seriesKeys: string[],
  otherKey = "Other",
): Record<string, string | number>[] {
  const out = new Map<string, Record<string, string | number>>();
  for (const r of rows) {
    const cat = String(r[categoryKey] ?? "—");
    const ser = String(r[seriesKey] ?? "");
    const key = seriesKeys.includes(ser) ? ser : otherKey;
    const row = out.get(cat) ?? { [String(categoryKey)]: cat };
    row[key] = Number(row[key] ?? 0) + Number(r[valueKey] ?? 0);
    out.set(cat, row);
  }
  return [...out.values()].map((row) => {
    for (const k of seriesKeys) row[k] ??= 0;
    return row;
  });
}

/** Keep the top n rows by `valueKey`; fold the rest into one "Other" row. */
export function topNWithOther<T extends Record<string, unknown>>(rows: T[], n: number, labelKey: keyof T, valueKey: keyof T, otherLabel = "Other"): T[] {
  const sorted = [...rows].sort((a, b) => Number(b[valueKey] ?? 0) - Number(a[valueKey] ?? 0));
  if (sorted.length <= n) return sorted;
  const rest = sorted.slice(n);
  const other = { ...rest[0]!, [labelKey]: otherLabel, [valueKey]: rest.reduce((a, r) => a + Number(r[valueKey] ?? 0), 0) } as T;
  return [...sorted.slice(0, n), other];
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

export function pctChange(current: number, previous: number | null | undefined): number | null {
  if (previous == null || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

/** Same rule as isPlausibleEmail, as a Postgres case-insensitive regex (used with `!~*`). */
export const EMAIL_PATTERN_SQL = "^[^[:space:]@<>(),;:\"]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\\.[a-z]{2,}$";

/** Pragmatic email validity check for data-quality reporting (not RFC-complete by design). */
export function isPlausibleEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return /^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i.test(email.trim());
}

/** Month buckets (YYYY-MM) from Jan of `now`'s year to now — for YTD sparklines. */
export function ytdMonths(now: Date): string[] {
  const out: string[] = [];
  for (let m = 0; m <= now.getUTCMonth(); m++) out.push(`${now.getUTCFullYear()}-${String(m + 1).padStart(2, "0")}`);
  return out;
}

/** Cumulative series aligned to buckets (missing buckets carry the running total). */
export function cumulative(buckets: string[], points: { bucket: string; value: number }[], start = 0): number[] {
  const map = new Map(points.map((p) => [p.bucket, p.value]));
  let run = start;
  return buckets.map((b) => (run += map.get(b) ?? 0));
}

export function daysBetween(a: Date | string, b: Date | string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/** Sum unmapped-status counts from an import batch's stats (supports the key spellings importers use). */
export function unmappedFromStats(stats: Record<string, unknown> | null | undefined): number {
  if (!stats) return 0;
  for (const k of ["unmappedStatuses", "unmapped_statuses", "unmappedStatus", "unmapped"]) {
    const v = stats[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}
