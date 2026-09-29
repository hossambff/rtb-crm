import { formatDistanceToNowStrict, format } from "date-fns";

export function fmtNumber(n: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (opts.compact) {
    const abs = Math.abs(n);
    if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 2)}B`;
    if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`;
    if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  }
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

export function fmtUsd(n: number | null | undefined, opts: { compact?: boolean; cents?: boolean } = {}): string {
  if (n == null || Number.isNaN(n)) return "—";
  const dollars = opts.cents ? n / 100 : n;
  if (opts.compact) return `$${fmtNumber(dollars, { compact: true })}`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(dollars);
}

export function fmtPct(p: number | null | undefined, digits = 0): string {
  if (p == null || Number.isNaN(p)) return "—";
  return `${(p * 100).toFixed(digits)}%`;
}

export function fmtDate(d: Date | string | null | undefined, pattern = "d MMM yyyy"): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? "—" : format(date, pattern);
}

export function fmtRelative(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? "—" : formatDistanceToNowStrict(date, { addSuffix: true });
}

export function initials(name: string | null | undefined): string {
  return (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}
