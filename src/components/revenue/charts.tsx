"use client";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_AXIS, PIPELINE_COLORS, VIZ_OTHER } from "@/lib/palette";
import { fmtPct, fmtUsd } from "@/lib/format";
import { ChartFrame, SimpleTable, TooltipBox } from "@/components/r100/charts";

const tick = { fill: CHART_AXIS.tick, fontSize: 12 };
const ADS = PIPELINE_COLORS.ADS!;
const usd = (cents: number) => fmtUsd(cents, { cents: true, compact: true });

/** AR aging buckets (0-30 / 31-60 / 61-90 / 90+ days past due). */
export function AgingChart({ data }: { data: { bucket: string; count: number; cents: number }[] }) {
  return (
    <ChartFrame table={<SimpleTable head={["Days past due", "Invoices", "Amount"]} rows={data.map((d) => [d.bucket, d.count, fmtUsd(d.cents, { cents: true })])} />}>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="30%">
          <CartesianGrid stroke={CHART_AXIS.grid} vertical={false} />
          <XAxis dataKey="bucket" tick={tick} axisLine={{ stroke: CHART_AXIS.stroke }} tickLine={false} />
          <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={(v: number) => usd(v)} width={64} />
          <Tooltip content={<TooltipBox format={(v) => fmtUsd(v, { cents: true })} />} cursor={{ fill: "#1A1A1A" }} />
          <Bar isAnimationActive={false} name="Overdue" dataKey="cents" fill={ADS} barSize={18} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Customer concentration: share of client revenue by account (top N + Other in gray). */
export function ConcentrationChart({ data }: { data: { name: string; cents: number; share: number }[] }) {
  const rows = data.map((d) => ({ ...d, fill: d.name === "Other" ? VIZ_OTHER : ADS }));
  return (
    <ChartFrame table={<SimpleTable head={["Account", "Annualized", "Share"]} rows={data.map((d) => [d.name, fmtUsd(d.cents, { cents: true }), fmtPct(d.share, 1)])} />}>
      <ResponsiveContainer width="100%" height={Math.max(140, rows.length * 28 + 16)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid stroke={CHART_AXIS.grid} horizontal={false} />
          <XAxis type="number" tick={tick} axisLine={false} tickLine={false} tickFormatter={(v: number) => usd(v)} />
          <YAxis type="category" dataKey="name" tick={tick} axisLine={false} tickLine={false} width={130} />
          <Tooltip content={<TooltipBox format={(v) => fmtUsd(v, { cents: true })} />} cursor={{ fill: "#1A1A1A" }} />
          <Bar isAnimationActive={false} name="Annualized" dataKey="cents" barSize={12} radius={[0, 4, 4, 0]}>
            {rows.map((r) => (
              <Cell key={r.name} fill={r.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
