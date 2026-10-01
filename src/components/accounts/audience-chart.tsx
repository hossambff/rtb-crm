"use client";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_AXIS, VIZ } from "@/lib/palette";
import { fmtNumber } from "@/lib/format";

export type AudiencePoint = {
  period: string;
  muu: number | null;
  muuSource: string | null;
  muuConfidence: string | null;
  visits: number | null;
  visitsSource: string | null;
  derivedMuu: number | null;
};

const SERIES = [
  { key: "muu", name: "MUU (unique users)", color: VIZ[0], dash: undefined },
  { key: "visits", name: "Monthly visits", color: VIZ[1], dash: undefined },
  { key: "derivedMuu", name: "MUU derived from visits (estimate)", color: VIZ[0], dash: "4 4" },
] as const;

/** Audience history: MUU vs monthly visits are always labeled separately (visits ≠ MUU). Single y-axis. */
export function AudienceChart({ data }: { data: AudiencePoint[] }) {
  const present = SERIES.filter((s) => data.some((d) => d[s.key] != null));
  return (
    <div className="h-64 w-full" role="img" aria-label={`Audience history: ${present.map((s) => s.name).join(", ")}`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
          <CartesianGrid stroke={CHART_AXIS.grid} vertical={false} />
          <XAxis dataKey="period" tick={{ fill: CHART_AXIS.tick, fontSize: 12 }} stroke={CHART_AXIS.stroke} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
          <YAxis tick={{ fill: CHART_AXIS.tick, fontSize: 12 }} stroke={CHART_AXIS.stroke} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => fmtNumber(v, { compact: true })} />
          <Tooltip
            cursor={{ stroke: CHART_AXIS.stroke }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0]!.payload as AudiencePoint;
              return (
                <div className="rounded border border-border-strong bg-surface-2 px-2.5 py-2 text-xs text-body">
                  <p className="mb-1 font-medium text-fg">{label}</p>
                  {p.muu != null ? (
                    <p>
                      MUU <span className="tabular text-fg">{fmtNumber(p.muu)}</span> <span className="text-muted">· {p.muuSource ?? "—"} · {p.muuConfidence ?? "reported"}</span>
                    </p>
                  ) : null}
                  {p.visits != null ? (
                    <p>
                      Visits <span className="tabular text-fg">{fmtNumber(p.visits)}</span> <span className="text-muted">· {p.visitsSource ?? "—"}</span>
                    </p>
                  ) : null}
                  {p.derivedMuu != null ? (
                    <p className="italic text-secondary">
                      Derived MUU ~{fmtNumber(p.derivedMuu)} <span className="text-muted">(estimate)</span>
                    </p>
                  ) : null}
                </div>
              );
            }}
          />
          {present.length >= 2 ? <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: CHART_AXIS.tick }} /> : null}
          {present.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.dash}
              dot={{ r: 3, strokeWidth: 0, fill: s.color }}
              activeDot={{ r: 4 }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
