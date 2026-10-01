"use client";
import * as React from "react";
import {
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
} from "recharts";
import { ChartCard } from "./chart-card";
import { formatTick, formatValue, type Series, type TableSpec, type ValueFormat } from "./format";
import { AXIS_TICK, BAR_MAX, ChartTooltip, GRID_STROKE, seriesColor, useMounted } from "./theme";

type Datum = Record<string, string | number | null>;

const GAP = 2;
const RADIUS = 4;

/**
 * Bar path with a 4px rounded *data end* and a square baseline. In a stack, every segment after the first gives up
 * 2px at its start side (the surface gap), and only the outermost non-zero segment is rounded.
 */
function barPath(x: number, y: number, w: number, h: number, r: number, horizontal: boolean): string {
  if (r <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  if (horizontal) {
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function makeShape(keys: string[], idx: number, stacked: boolean, horizontal: boolean) {
  function Shape(props: BarShapeProps) {
    let { x, y, width: w, height: h } = props;
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    let isStart = true;
    let isEnd = true;
    if (stacked) {
      const payload = (props.payload ?? {}) as Datum;
      const nz = keys.map((k, i) => (Number(payload[k] ?? 0) > 0 ? i : -1)).filter((i) => i >= 0);
      isStart = nz[0] === idx;
      isEnd = nz[nz.length - 1] === idx;
    }
    if (!isStart) {
      if (horizontal) {
        x += GAP;
        w -= GAP;
      } else {
        h -= GAP;
      }
    }
    if (!(w > 0.5) || !(h > 0.5)) return <g />;
    const r = isEnd ? Math.min(RADIUS, horizontal ? w : h, (horizontal ? h : w) / 2) : 0;
    return (
      <path
        d={barPath(x, y, w, h, r, horizontal)}
        fill={props.fill}
        style={{ filter: props.isActive ? "brightness(1.18)" : undefined, transition: "filter 150ms" }}
      />
    );
  }
  return Shape;
}

export type BarChartProps = {
  title: string;
  description?: React.ReactNode;
  footnote?: React.ReactNode;
  data: Datum[];
  categoryKey: string;
  categoryLabel?: string;
  series: Series[];
  /** vertical = columns growing up; horizontal = bars growing right (default for ranked categories). */
  orientation?: "vertical" | "horizontal";
  stacked?: boolean;
  format?: ValueFormat;
  height?: number;
  /** Direct value labels at bar tips (single-series only; sparing by design). */
  valueLabels?: boolean;
  emptyText?: string;
  className?: string;
  actions?: React.ReactNode;
  /** Include a row total column in the table view (stacked charts). */
  totalColumn?: boolean;
  /** Single-series only: per-category identity colors (e.g. pipeline motion colors). */
  categoryColors?: Record<string, string>;
  /** Replace the auto-generated table view (e.g. to add counts next to rates). */
  table?: TableSpec;
};

export function BarChart({
  title,
  description,
  footnote,
  data,
  categoryKey,
  categoryLabel = "Category",
  series,
  orientation = "horizontal",
  stacked = false,
  format = "number",
  height,
  valueLabels,
  emptyText,
  className,
  actions,
  totalColumn,
  categoryColors,
  table: tableOverride,
}: BarChartProps) {
  const mounted = useMounted();
  const horizontal = orientation === "horizontal";
  const keys = series.map((s) => s.key);
  const colors = series.map((s, i) => seriesColor(s, i));
  const empty = data.length === 0 || data.every((d) => keys.every((k) => !Number(d[k] ?? 0)));
  const showLabels = (valueLabels ?? (horizontal && series.length === 1)) && series.length === 1;
  const h = height ?? (horizontal ? Math.max(120, data.length * (stacked || series.length === 1 ? 30 : 22 * series.length) + 36) : 260);
  const longest = Math.max(4, ...data.map((d) => String(d[categoryKey] ?? "").length));
  const yWidth = Math.min(170, Math.max(56, longest * 6.6 + 8));

  const table: TableSpec = tableOverride ?? {
    columns: [
      { label: categoryLabel },
      ...series.map((s) => ({ label: s.label, numeric: true })),
      ...(totalColumn && series.length > 1 ? [{ label: "Total", numeric: true }] : []),
    ],
    rows: data.map((d) => [
      String(d[categoryKey] ?? ""),
      ...keys.map((k) => formatValue(Number(d[k] ?? 0), format)),
      ...(totalColumn && series.length > 1 ? [formatValue(keys.reduce((a, k) => a + Number(d[k] ?? 0), 0), format)] : []),
    ]),
  };

  const catAxisProps = {
    dataKey: categoryKey,
    tick: AXIS_TICK,
    tickLine: false,
    axisLine: { stroke: GRID_STROKE },
    interval: 0 as const,
    tickFormatter: (v: string) => (String(v).length > 24 ? `${String(v).slice(0, 23)}…` : String(v)),
  };
  const valAxisProps = {
    tick: AXIS_TICK,
    tickLine: false,
    axisLine: false,
    tickFormatter: (v: number) => formatTick(v, format),
    allowDecimals: false,
    minTickGap: 8,
  };

  return (
    <ChartCard
      title={title}
      description={description}
      footnote={footnote}
      legend={series.length > 1 ? series.map((s, i) => ({ label: s.label, color: colors[i]!, shape: "rect" as const })) : undefined}
      table={table}
      empty={empty}
      emptyText={emptyText}
      className={className}
      actions={actions}
    >
      <div style={{ height: h }} className="w-full">
        {mounted ? (
          <ResponsiveContainer width="100%" height="100%">
            <RBarChart
              data={data}
              layout={horizontal ? "vertical" : "horizontal"}
              margin={{ top: 8, right: showLabels ? 56 : 12, bottom: 0, left: 0 }}
              barGap={GAP}
              barCategoryGap={horizontal ? "22%" : "28%"}
              accessibilityLayer
            >
              <CartesianGrid stroke={GRID_STROKE} vertical={horizontal} horizontal={!horizontal} />
              {horizontal ? (
                <>
                  <XAxis type="number" {...valAxisProps} />
                  <YAxis type="category" width={yWidth} {...catAxisProps} />
                </>
              ) : (
                <>
                  {/* QA-25: many categories → angled labels so none are dropped or overlap */}
                  <XAxis type="category" {...catAxisProps} {...(data.length > 6 ? { angle: -35, textAnchor: "end" as const, height: 64 } : {})} />
                  <YAxis type="number" width={52} {...valAxisProps} />
                </>
              )}
              <Tooltip
                cursor={{ fill: "rgba(255,255,255,0.035)" }}
                content={(p) => (
                  <ChartTooltip active={p.active} payload={p.payload as never} label={p.label as string} format={format} hideZero={stacked} />
                )}
                isAnimationActive={false}
              />
              {series.map((s, i) => {
                const Shape = makeShape(keys, i, stacked, horizontal);
                return (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    fill={colors[i]}
                    stackId={stacked ? "stack" : undefined}
                    maxBarSize={BAR_MAX}
                    shape={Shape}
                    activeBar={Shape}
                    isAnimationActive={false}
                  >
                    {categoryColors && series.length === 1
                      ? data.map((d, j) => <Cell key={j} fill={categoryColors[String(d[categoryKey])] ?? colors[0]} />)
                      : null}
                    {showLabels ? (
                      <LabelList
                        dataKey={s.key}
                        position={horizontal ? "right" : "top"}
                        offset={6}
                        fill="#B4B4B4"
                        fontSize={11}
                        formatter={(v: unknown) => (Number(v) ? formatValue(Number(v), format) : "")}
                      />
                    ) : null}
                  </Bar>
                );
              })}
            </RBarChart>
          </ResponsiveContainer>
        ) : null}
      </div>
    </ChartCard>
  );
}
