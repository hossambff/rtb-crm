"use client";
import * as React from "react";
import {
  Area,
  AreaChart as RAreaChart,
  CartesianGrid,
  Line,
  LineChart as RLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard } from "./chart-card";
import { formatTick, formatValue, type Series, type TableSpec, type ValueFormat } from "./format";
import { AXIS_TICK, ChartTooltip, GRID_STROKE, SURFACE, seriesColor, useMounted } from "./theme";

type Datum = Record<string, string | number | null>;

export type LineChartProps = {
  title: string;
  description?: React.ReactNode;
  footnote?: React.ReactNode;
  data: Datum[];
  xKey: string;
  xLabel?: string;
  series: Series[];
  format?: ValueFormat;
  height?: number;
  /** Area variant: soft 10% wash under each 2px line. */
  area?: boolean;
  stacked?: boolean;
  emptyText?: string;
  className?: string;
};

/** Line / area chart: 2px lines, crosshair that snaps to the nearest X, one tooltip listing every series. */
export function LineChart({
  title,
  description,
  footnote,
  data,
  xKey,
  xLabel = "Date",
  series,
  format = "number",
  height = 240,
  area = false,
  stacked = false,
  emptyText,
  className,
}: LineChartProps) {
  const mounted = useMounted();
  const colors = series.map((s, i) => seriesColor(s, i));
  const empty = data.length === 0;
  const table: TableSpec = {
    columns: [{ label: xLabel }, ...series.map((s) => ({ label: s.label, numeric: true }))],
    rows: data.map((d) => [String(d[xKey] ?? ""), ...series.map((s) => formatValue(Number(d[s.key] ?? 0), format))]),
  };
  const common = (
    <>
      <CartesianGrid stroke={GRID_STROKE} vertical={false} />
      <XAxis dataKey={xKey} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} minTickGap={24} />
      <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => formatTick(v, format)} />
      <Tooltip
        cursor={{ stroke: "#3C3C3C", strokeWidth: 1 }}
        content={(p) => <ChartTooltip active={p.active} payload={p.payload as never} label={p.label as string} format={format} />}
        isAnimationActive={false}
      />
    </>
  );
  const activeDot = { r: 4, strokeWidth: 2, stroke: SURFACE };
  return (
    <ChartCard
      title={title}
      description={description}
      footnote={footnote}
      legend={series.length > 1 ? series.map((s, i) => ({ label: s.label, color: colors[i]!, shape: area ? ("rect" as const) : ("line" as const) })) : undefined}
      table={table}
      empty={empty}
      emptyText={emptyText}
      className={className}
    >
      <div style={{ height }} className="w-full">
        {mounted ? (
          <ResponsiveContainer width="100%" height="100%">
            {area ? (
              <RAreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} accessibilityLayer>
                {common}
                {series.map((s, i) => (
                  <Area
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stroke={colors[i]}
                    strokeWidth={2}
                    fill={colors[i]}
                    fillOpacity={0.1}
                    stackId={stacked ? "a" : undefined}
                    dot={false}
                    activeDot={activeDot}
                    isAnimationActive={false}
                  />
                ))}
              </RAreaChart>
            ) : (
              <RLineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} accessibilityLayer>
                {common}
                {series.map((s, i) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stroke={colors[i]}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    dot={false}
                    activeDot={activeDot}
                    isAnimationActive={false}
                  />
                ))}
              </RLineChart>
            )}
          </ResponsiveContainer>
        ) : null}
      </div>
    </ChartCard>
  );
}

export function AreaChart(props: Omit<LineChartProps, "area">) {
  return <LineChart {...props} area />;
}
