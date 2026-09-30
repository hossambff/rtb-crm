/**
 * Analytics filter row (URL params) — pure, shared by server pages and the client filter bar.
 * One row above the charts: date range preset · pipeline · owner · basis (gross/net) · overrides (incl/excl).
 */
export const RANGE_PRESETS = ["7d", "30d", "90d", "ytd"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const RANGE_LABELS: Record<RangePreset, string> = { "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", ytd: "Year to date" };

export type Basis = "gross" | "net";

export type AnalyticsFilters = {
  range: RangePreset;
  from: Date;
  to: Date;
  pipeline: string | null;
  owner: string | null;
  basis: Basis;
  /** Include approved manual probability overrides in weighted values (default true). */
  overrides: boolean;
};

type SP = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function rangeStart(range: RangePreset, now: Date): Date {
  if (range === "ytd") return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return new Date(now.getTime() - days * 86_400_000);
}

const PIPELINE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseFilters(sp: SP, now: Date = new Date()): AnalyticsFilters {
  const r = first(sp.range);
  const range: RangePreset = (RANGE_PRESETS as readonly string[]).includes(r ?? "") ? (r as RangePreset) : "30d";
  const pipeline = first(sp.pipeline);
  const owner = first(sp.owner);
  return {
    range,
    from: rangeStart(range, now),
    to: now,
    pipeline: pipeline && PIPELINE_RE.test(pipeline) ? pipeline : null,
    owner: owner && ID_RE.test(owner) ? owner : null,
    basis: first(sp.basis) === "net" ? "net" : "gross",
    overrides: first(sp.overrides) !== "excl",
  };
}

/** Serialize filters back to a query string, omitting defaults. `patch` overrides individual params. */
export function filtersToQuery(
  f: Pick<AnalyticsFilters, "range" | "pipeline" | "owner" | "basis" | "overrides">,
  patch: Partial<Record<"range" | "pipeline" | "owner" | "basis" | "overrides", string | null>> = {},
): string {
  const base: Record<string, string | null> = {
    range: f.range === "30d" ? null : f.range,
    pipeline: f.pipeline,
    owner: f.owner,
    basis: f.basis === "gross" ? null : f.basis,
    overrides: f.overrides ? null : "excl",
  };
  const merged = { ...base, ...patch };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** Human basis label for footnotes, e.g. "Gross basis · incl. manual overrides". */
export function basisLabel(f: Pick<AnalyticsFilters, "basis" | "overrides">): string {
  return `${f.basis === "net" ? "RTB net" : "Gross"} basis · ${f.overrides ? "incl." : "excl."} manual overrides`;
}
