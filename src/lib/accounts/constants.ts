/** Account enums + labels (pure; safe for client components). */

export const ACCOUNT_TYPES = [
  { key: "publisher", label: "Publisher" },
  { key: "media_group", label: "Media group" },
  { key: "public_company", label: "Public company" },
  { key: "token_project", label: "Token project" },
  { key: "advertiser", label: "Advertiser" },
  { key: "agency", label: "Agency" },
  { key: "partner", label: "Partner" },
  { key: "other", label: "Other" },
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number]["key"];

export const LIFECYCLES = [
  { key: "target", label: "Target" },
  { key: "prospect", label: "Prospect" },
  { key: "customer", label: "Customer" },
  { key: "churned", label: "Churned" },
  { key: "disqualified", label: "Disqualified" },
] as const;
export type Lifecycle = (typeof LIFECYCLES)[number]["key"];

export const PRIORITIES = [
  { key: "top10", label: "Top 10" },
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
] as const;
export type Priority = (typeof PRIORITIES)[number]["key"];

export const METRIC_TYPES = [
  { key: "muu", label: "MUU (monthly unique users)" },
  { key: "visits", label: "Monthly visits" },
  { key: "pageviews", label: "Pageviews" },
] as const;

export const METRIC_CONFIDENCE = [
  { key: "verified", label: "Verified" },
  { key: "reported", label: "Reported" },
  { key: "estimate", label: "Estimate" },
] as const;

export const METRIC_SOURCES = ["Similarweb", "Google Analytics", "Comscore", "Self-reported", "BFF estimate", "Manual"] as const;

/** Company-program types that get ticker / token / B2C / market cap fields. */
export const R100_TYPES: readonly string[] = ["public_company", "token_project"];

export function labelOf<T extends { key: string; label: string }>(list: readonly T[], key: string | null | undefined): string {
  return list.find((x) => x.key === key)?.label ?? "—";
}

export const ACCOUNT_SORTS = ["name", "muu", "updated", "lifecycle", "priority", "created"] as const;
export type AccountSort = (typeof ACCOUNT_SORTS)[number];

/** MUU range filter buckets for the accounts table. */
export const MUU_RANGES = [
  { key: "lt100k", label: "< 100K", min: 0, max: 100_000 },
  { key: "100k-1m", label: "100K – 1M", min: 100_000, max: 1_000_000 },
  { key: "1m-10m", label: "1M – 10M", min: 1_000_000, max: 10_000_000 },
  { key: "gte10m", label: "≥ 10M", min: 10_000_000, max: null },
] as const;
