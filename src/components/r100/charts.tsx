"use client";
import * as React from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_AXIS, PIPELINE_COLORS, VIZ_OTHER } from "@/lib/palette";
import { fmtNumber } from "@/lib/format";

const R100 = PIPELINE_COLORS.R100!;
const tick = { fill: CHART_AXIS.tick, fontSize: 12 };

export function TooltipBox({
  active,
  payload,
  label,
  format = (v: number) => fmtNumber(v),
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string; payload?: { fill?: string } }[];
  label?: string;
  format?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded border border-border-strong bg-surface-2 px-2.5 py-1.5 text-xs text-body">
      {label ? <p className="mb-1 text-muted">{label}</p> : null}
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 tabular">
          <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: p.color ?? p.payload?.fill }} />
          <span className="text-secondary">{p.name}</span>
          <span className="ml-auto font-medium text-fg">{format(p.value ?? 0)}</span>
        </p>
      ))}
    </div>
  );
}

function LegendText(value: string) {
  return <span className="text-xs text-secondary">{value}</span>;
}

/** Burn-up of live accounts (butter) vs the dashed goal line. */
export function BurnUpChart({ data, goal }: { data: { label: string; live: number }[]; goal: number }) {
  const rows = data.map((d) => ({ ...d, goal }));
  const max = Math.max(goal, ...data.map((d) => d.live)) * 1.08;
  return (
    <ChartFrame table={<SimpleTable head={["Month", "Live", "Goal"]} rows={data.map((d) => [d.label, fmtNumber(d.live), fmtNumber(goal)])} />}>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid stroke={CHART_AXIS.grid} vertical={false} />
          <XAxis dataKey="label" tick={tick} axisLine={{ stroke: CHART_AXIS.stroke }} tickLine={false} />
          <YAxis tick={tick} axisLine={false} tickLine={false} domain={[0, Math.ceil(max)]} allowDecimals={false} />
          <Tooltip content={<TooltipBox />} cursor={{ stroke: CHART_AXIS.stroke }} />
          <Legend formatter={LegendText} iconType="plainline" wrapperStyle={{ paddingTop: 4 }} />
          <Line name="Goal" dataKey="goal" stroke={VIZ_OTHER} strokeDasharray="4 4" strokeWidth={1.5} dot={false} activeDot={false} isAnimationActive={false} />
          <Line isAnimationActive={false} name="Live accounts" dataKey="live" stroke={R100} strokeWidth={2} dot={{ r: 4, fill: R100, strokeWidth: 0 }} activeDot={{ r: 5 }} type="monotone" />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Funnel by stage — thin horizontal bars, 4px rounded data ends. */
export function FunnelChart({ data }: { data: { name: string; count: number; live: boolean }[] }) {
  return (
    <ChartFrame table={<SimpleTable head={["Stage", "Companies"]} rows={data.map((d) => [d.name, fmtNumber(d.count)])} />}>
      <ResponsiveContainer width="100%" height={Math.max(160, data.length * 26 + 20)}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 24, bottom: 0, left: 8 }} barCategoryGap={2}>
          <CartesianGrid stroke={CHART_AXIS.grid} horizontal={false} />
          <XAxis type="number" tick={tick} axisLine={false} tickLine={false} allowDecimals={false} />
          <YAxis type="category" dataKey="name" tick={tick} axisLine={false} tickLine={false} width={150} />
          <Tooltip content={<TooltipBox />} cursor={{ fill: "#1A1A1A" }} />
          <Bar isAnimationActive={false} name="Companies" dataKey="count" fill={R100} barSize={12} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Chart + "view as table" toggle (PRD §16A.4 accessibility). */
export function ChartFrame({ children, table }: { children: React.ReactNode; table: React.ReactNode }) {
  const [asTable, setAsTable] = React.useState(false);
  return (
    <div>
      <div className="mb-1 flex justify-end">
        <button type="button" onClick={() => setAsTable((v) => !v)} className="text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline">
          {asTable ? "View as chart" : "View as table"}
        </button>
      </div>
      {asTable ? table : children}
    </div>
  );
}

export function SimpleTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="max-h-64 overflow-auto">
      <table className="w-full text-xs tabular">
        <thead>
          <tr className="text-left text-muted">
            {head.map((h) => (
              <th key={h} className="px-2 py-1 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border">
              {r.map((c, j) => (
                <td key={j} className="px-2 py-1 text-body">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
