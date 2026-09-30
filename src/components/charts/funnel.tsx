"use client";
import * as React from "react";
import { VIZ } from "@/lib/palette";
import { Tooltip } from "@/components/ui/misc";
import { ChartCard } from "./chart-card";
import { formatValue, type TableSpec, type ValueFormat } from "./format";

export type FunnelStep = { label: string; value: number };

/**
 * Funnel as horizontal bars (one series → one hue). Each step shows its value and the conversion from the
 * previous step. Bars are ≤24px thick with a 4px rounded data end; each bar is its own hover/focus target.
 */
export function Funnel({
  title,
  description,
  footnote,
  steps,
  format = "number",
  color = VIZ[0],
  className,
  emptyText,
}: {
  title: string;
  description?: React.ReactNode;
  footnote?: React.ReactNode;
  steps: FunnelStep[];
  format?: ValueFormat;
  color?: string;
  className?: string;
  emptyText?: string;
}) {
  const max = Math.max(0, ...steps.map((s) => s.value));
  const conv = (i: number) => (i === 0 || !steps[i - 1]!.value ? null : steps[i]!.value / steps[i - 1]!.value);
  const table: TableSpec = {
    columns: [{ label: "Step" }, { label: "Count", numeric: true }, { label: "From previous", numeric: true }, { label: "From first", numeric: true }],
    rows: steps.map((s, i) => [
      s.label,
      formatValue(s.value, format),
      conv(i) == null ? "—" : formatValue(conv(i), "pct"),
      steps[0]?.value ? formatValue(s.value / steps[0].value, "pct") : "—",
    ]),
  };
  return (
    <ChartCard title={title} description={description} footnote={footnote} table={table} empty={max === 0} emptyText={emptyText} className={className}>
      <ol className="space-y-2.5 px-1 py-2">
        {steps.map((s, i) => {
          const pct = max ? (s.value / max) * 100 : 0;
          const c = conv(i);
          return (
            <li key={s.label} className="grid grid-cols-[minmax(84px,120px)_1fr_auto] items-center gap-3 text-xs">
              <span className="truncate text-secondary">{s.label}</span>
              <Tooltip
                content={
                  <span>
                    <span className="font-semibold text-fg">{formatValue(s.value, format)}</span> {s.label}
                    {c != null ? <span className="text-muted"> · {formatValue(c, "pct")} of previous</span> : null}
                  </span>
                }
              >
                <span tabIndex={0} className="group block h-6 w-full rounded-sm outline-none" aria-label={`${s.label}: ${formatValue(s.value, format)}`}>
                  <span
                    className="block h-full rounded-r transition-[filter] duration-150 group-hover:brightness-125 group-focus-visible:brightness-125"
                    style={{ width: `${Math.max(pct, s.value > 0 ? 1 : 0)}%`, background: color }}
                  />
                </span>
              </Tooltip>
              <span className="w-24 text-right tabular">
                <span className="font-semibold text-fg">{formatValue(s.value, format)}</span>
                <span className="ml-1.5 text-muted">{c == null ? "" : formatValue(c, "pct")}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </ChartCard>
  );
}
