"use client";
import * as React from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { VIZ, VIZ_OTHER } from "@/lib/palette";
import { ChartCard } from "./chart-card";
import { formatValue, type TableSpec, type ValueFormat } from "./format";
import { ChartTooltip, SURFACE, useMounted } from "./theme";

export type DonutSlice = { label: string; value: number; color?: string };

/**
 * Part-to-whole at a glance only. Use sparingly: more than 4 slices fold into "Other" (prefer a bar chart then).
 * Slices are separated by a 2px surface gap; the center carries the total.
 */
export function Donut({
  title,
  description,
  footnote,
  slices,
  format = "number",
  centerLabel = "Total",
  height = 200,
  className,
  emptyText,
}: {
  title: string;
  description?: React.ReactNode;
  footnote?: React.ReactNode;
  slices: DonutSlice[];
  format?: ValueFormat;
  centerLabel?: string;
  height?: number;
  className?: string;
  emptyText?: string;
}) {
  const mounted = useMounted();
  const positive = slices.filter((s) => s.value > 0);
  const folded: DonutSlice[] =
    positive.length > 4
      ? [...positive.slice(0, 3), { label: "Other", value: positive.slice(3).reduce((a, s) => a + s.value, 0), color: VIZ_OTHER }]
      : positive;
  const colored = folded.map((s, i) => ({ ...s, color: s.color ?? VIZ[i] ?? VIZ_OTHER }));
  const total = colored.reduce((a, s) => a + s.value, 0);
  const table: TableSpec = {
    columns: [{ label: "Segment" }, { label: "Value", numeric: true }, { label: "Share", numeric: true }],
    rows: positive.map((s) => [s.label, formatValue(s.value, format), formatValue(total ? s.value / total : 0, "pct")]),
  };
  return (
    <ChartCard
      title={title}
      description={description}
      footnote={footnote}
      legend={colored.map((s) => ({ label: s.label, color: s.color, shape: "rect" as const }))}
      table={table}
      empty={total === 0}
      emptyText={emptyText}
      className={className}
    >
      <div style={{ height }} className="relative w-full">
        {mounted ? (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={colored}
                dataKey="value"
                nameKey="label"
                innerRadius="62%"
                outerRadius="92%"
                stroke={SURFACE}
                strokeWidth={2}
                startAngle={90}
                endAngle={-270}
                isAnimationActive={false}
              >
                {colored.map((s) => (
                  <Cell key={s.label} fill={s.color} />
                ))}
              </Pie>
              <Tooltip
                content={(p) => <ChartTooltip active={p.active} payload={(p.payload ?? []).map((r) => ({ ...r, color: (r.payload as { color?: string })?.color })) as never} format={format} />}
                isAnimationActive={false}
              />
            </PieChart>
          </ResponsiveContainer>
        ) : null}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-xl text-fg">{formatValue(total, format)}</span>
          <span className="text-[11px] text-muted">{centerLabel}</span>
        </div>
      </div>
    </ChartCard>
  );
}
