"use client";
import * as React from "react";
import { CHART_AXIS, VIZ, VIZ_OTHER } from "@/lib/palette";
import { formatValue, type Series, type ValueFormat } from "./format";

/** Chart chrome (PRD §16A.4): recessive hairline grid, muted 12px Work Sans axis text, surface-colored gaps. */
export const AXIS_TICK = { fill: CHART_AXIS.tick, fontSize: 12, fontFamily: "var(--font-work-sans), ui-sans-serif, system-ui" } as const;
export const GRID_STROKE = CHART_AXIS.grid;
export const SURFACE = CHART_AXIS.surface;
export const BAR_MAX = 24;

/** Resolve series colors in fixed palette order; >8 series fold to "Other" gray (never cycled). */
export function seriesColor(s: Series, i: number): string {
  return s.color ?? (i < VIZ.length ? VIZ[i]! : VIZ_OTHER);
}

type TooltipRow = { name?: string | number; value?: unknown; color?: string; dataKey?: unknown; payload?: Record<string, unknown> };

/** Tooltip: values lead (strong), series names follow (secondary), keyed with a short line in the series color. */
export function ChartTooltip({
  active,
  payload,
  label,
  format,
  labelFormatter,
  hideZero,
}: {
  active?: boolean;
  payload?: readonly TooltipRow[];
  label?: string | number;
  format: ValueFormat;
  labelFormatter?: (label: string) => string;
  hideZero?: boolean;
}) {
  if (!active || !payload?.length) return null;
  const rows = hideZero ? payload.filter((p) => Number(p.value) !== 0) : payload;
  const title = label != null ? (labelFormatter ? labelFormatter(String(label)) : String(label)) : null;
  return (
    <div className="min-w-36 rounded-md border border-border-strong bg-surface-2 px-2.5 py-2 text-xs">
      {title ? <p className="mb-1 text-muted">{title}</p> : null}
      <ul className="space-y-0.5">
        {rows.map((p, i) => (
          <li key={i} className="flex items-center gap-2">
            <span aria-hidden className="inline-block h-0.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
            <span className="font-semibold text-fg tabular">{formatValue(Number(p.value), format)}</span>
            <span className="truncate text-secondary">{String(p.name ?? "")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Keeps charts from rendering on the server (Recharts measures the DOM). Holds layout height to avoid jumps. */
const noopSubscribe = () => () => {};
export function useMounted() {
  return React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
