/**
 * Quotas (sales targets) — pure, client-safe, unit tested (src/lib/quotas/__tests__/core.test.ts).
 * Stored in `quotas` (userId, period "2026-Q4", pipelineKey ("" = all motions), metric, target, status proposed|set).
 * `target` is in cents for revenue_usd, otherwise a plain count / audience.
 */
import type { Role } from "@/lib/rbac/model";

export const QUOTA_METRICS = ["revenue_usd", "muu", "activations", "meetings", "deals_won"] as const;
export type QuotaMetric = (typeof QUOTA_METRICS)[number];

export const METRIC_LABELS: Record<QuotaMetric, string> = {
  revenue_usd: "Revenue",
  muu: "MUU",
  activations: "Activations",
  meetings: "Meetings booked",
  deals_won: "Deals won",
};

export function isQuotaMetric(v: unknown): v is QuotaMetric {
  return typeof v === "string" && (QUOTA_METRICS as readonly string[]).includes(v);
}

/** Metrics that make sense per motion (first = default). */
export function metricsForMotion(pipelineKey: string): QuotaMetric[] {
  switch (pipelineKey) {
    case "NET":
    case "ENT":
    case "SPT":
      return ["muu", "revenue_usd", "deals_won"];
    case "ADS":
    case "PAY":
      return ["revenue_usd", "deals_won"];
    case "R100":
      return ["activations", "deals_won"];
    case "":
      return ["meetings", "revenue_usd", "deals_won"];
    default:
      return ["revenue_usd", "deals_won"];
  }
}

/** SDRs and interns are measured on meetings booked (one target across motions); everyone else per motion. */
export function isMeetingsRole(role: Role): boolean {
  return role === "sdr" || role === "intern";
}

/** The default quota lines for a person: one per motion they sell, or a single "meetings" line for SDRs / interns. */
export function defaultQuotaLines(role: Role, motionKeys: readonly string[]): { pipelineKey: string; metric: QuotaMetric }[] {
  if (isMeetingsRole(role)) return [{ pipelineKey: "", metric: "meetings" }];
  return motionKeys.map((k) => ({ pipelineKey: k, metric: metricsForMotion(k)[0]! }));
}

export const PERIOD_RE = /^\d{4}-Q[1-4]$/;

export function isPeriod(v: unknown): v is string {
  return typeof v === "string" && PERIOD_RE.test(v);
}

/** "2026-Q4" for a calendar date (UTC parts of a wall-clock date). */
export function periodOf(d: Date): string {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

export function nextPeriod(p: string): string {
  const y = Number(p.slice(0, 4));
  const q = Number(p.slice(6));
  return q === 4 ? `${y + 1}-Q1` : `${y}-Q${q + 1}`;
}

export function periodLabel(p: string): string {
  return `Q${p.slice(6)} ${p.slice(0, 4)}`;
}

/** Stored value ↔ what a person types: revenue in whole dollars ↔ cents. */
export function toStoredTarget(metric: QuotaMetric, input: number): number {
  return metric === "revenue_usd" ? Math.round(input * 100) : Math.round(input);
}

export function fromStoredTarget(metric: QuotaMetric, stored: number): number {
  return metric === "revenue_usd" ? stored / 100 : stored;
}

/** Compact human label: "$250k", "1.2M MUU", "40 activations". */
export function formatTarget(metric: QuotaMetric, stored: number): string {
  const v = fromStoredTarget(metric, stored);
  const compact = (n: number) =>
    n >= 1_000_000 ? `${trim(n / 1_000_000)}M` : n >= 10_000 ? `${trim(n / 1_000)}k` : new Intl.NumberFormat("en-US").format(Math.round(n));
  switch (metric) {
    case "revenue_usd":
      return `$${compact(v)}`;
    case "muu":
      return `${compact(v)} MUU`;
    case "activations":
      return `${compact(v)} activation${v === 1 ? "" : "s"}`;
    case "meetings":
      return `${compact(v)} meeting${v === 1 ? "" : "s"}`;
    case "deals_won":
      return `${compact(v)} deal${v === 1 ? "" : "s"} won`;
  }
}

function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** Attainment 0..∞ (null when there is no positive target). */
export function attainment(actual: number, target: number): number | null {
  return target > 0 ? actual / target : null;
}

/**
 * A rep may propose a target for a line only when no leader-set quota exists on it. Leaders set (or confirm) quotas;
 * a proposal never overwrites a set one.
 */
export function mayPropose(existing: { status: string } | null | undefined): boolean {
  return !existing || existing.status === "proposed";
}
