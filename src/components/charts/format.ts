/**
 * Chart value formats. Server components pass a format *name* (functions are not serialisable across the RSC
 * boundary); the client chart resolves it here. Pure — safe on both sides.
 */
import { fmtNumber, fmtPct, fmtUsd } from "@/lib/format";

export type ValueFormat = "number" | "compact" | "usd" | "usdCompact" | "pct" | "pct1" | "days" | "muu";

export function formatValue(v: number | null | undefined, f: ValueFormat = "number"): string {
  if (v == null || Number.isNaN(v)) return "—";
  switch (f) {
    case "compact":
      return fmtNumber(v, { compact: true });
    case "usd":
      return fmtUsd(v);
    case "usdCompact":
      return fmtUsd(v, { compact: true });
    case "pct":
      return fmtPct(v);
    case "pct1":
      return fmtPct(v, 1);
    case "days":
      return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}d`;
    case "muu":
      return `${fmtNumber(v, { compact: true })} MUU`;
    default:
      return fmtNumber(v);
  }
}

/** Axis ticks stay short: compact numbers, compact dollars, whole percents. */
export function formatTick(v: number, f: ValueFormat = "number"): string {
  if (f === "usd" || f === "usdCompact") return fmtUsd(v, { compact: true });
  if (f === "pct" || f === "pct1") return fmtPct(v);
  if (f === "days") return `${Math.round(v)}d`;
  return fmtNumber(v, { compact: true });
}

export type Series = { key: string; label: string; color?: string };

export type TableSpec = { columns: { label: string; numeric?: boolean }[]; rows: string[][] };
