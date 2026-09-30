import { STATUS_COLORS, VIZ, VIZ_OTHER } from "@/lib/palette";
import { fmtNumber, fmtPct, fmtUsd } from "@/lib/format";
import { basisLabel } from "@/lib/analytics/filters";
import { dealHref, pageContext } from "@/lib/analytics/page";
import { attention, conversionByStage, healthDistribution, stageAging, velocityByStage, winRates } from "@/lib/analytics/health";
import { BarChart, KpiTile } from "@/components/charts";
import { ChartGrid, DealLines, KpiGrid, Panel } from "@/components/analytics/bits";
import { relative } from "@/components/analytics/bits";

export const metadata = { title: "Pipeline health · Analytics" };

export default async function PipelineHealthPage({ searchParams }: PageProps<"/analytics/health">) {
  const { ctx, now } = await pageContext(searchParams);
  if (!ctx) return null;
  const f = ctx.filters;
  const conversionKey = f.pipeline ?? "NET";
  const [aging, att, health, velocity, conversion, wins] = await Promise.all([
    stageAging(ctx),
    attention(ctx, now),
    healthDistribution(ctx),
    velocityByStage(ctx),
    conversionByStage(ctx, conversionKey),
    winRates(ctx),
  ]);
  const moneyLabel = f.basis === "net" ? "RTB net" : "Gross";
  const label = (r: { pipeline: string; stage: string }) => (f.pipeline ? r.stage : `${r.pipeline} · ${r.stage}`);
  const agingRows = aging.map((r) => ({ stage: label(r), within: r.deals - r.overSla, over: r.overSla, avg: r.avgAge, sla: r.slaDays }));
  const totalOver = aging.reduce((a, r) => a + r.overSla, 0);
  const openDeals = att.counts.open;

  return (
    <div className="space-y-6">
      <KpiGrid>
        <KpiTile label="Open deals" value={fmtNumber(openDeals)} basis="In scope, open stages" />
        <KpiTile label="Over stage SLA" value={fmtNumber(totalOver)} basis={openDeals ? `${fmtPct(totalOver / openDeals)} of open deals` : "—"} />
        <KpiTile
          label="Without a next step"
          value={fmtNumber(att.counts.noNext)}
          basis={`${fmtUsd(att.counts.noNextValue, { compact: true })} weighted ${moneyLabel.toLowerCase()} · ${att.counts.overdue} overdue`}
        />
        <KpiTile label="Stalled (14+ days)" value={fmtNumber(att.counts.stalled)} basis="No logged activity in 14 days" />
      </KpiGrid>

      <ChartGrid>
        <BarChart
          title="Stage aging vs SLA"
          description="Open deals per stage, within vs over the stage SLA"
          data={agingRows}
          categoryKey="stage"
          categoryLabel="Stage"
          series={[
            { key: "within", label: "Within SLA", color: STATUS_COLORS.good },
            { key: "over", label: "Over SLA", color: STATUS_COLORS.critical },
          ]}
          stacked
          format="number"
          table={{
            columns: [{ label: "Stage" }, { label: "Deals", numeric: true }, { label: "Over SLA", numeric: true }, { label: "Avg age", numeric: true }, { label: "SLA", numeric: true }],
            rows: agingRows.map((r) => [r.stage, fmtNumber(r.within + r.over), fmtNumber(r.over), `${Math.round(r.avg)}d`, r.sla ? `${r.sla}d` : "—"]),
          }}
          footnote="Age = days since the deal entered its current stage."
          emptyText="No open deals in this selection."
        />
        <BarChart
          title="Health distribution"
          description="Open deals by health score band"
          data={health.map((h) => ({ band: h.label, deals: h.deals }))}
          categoryKey="band"
          categoryLabel="Health band"
          series={[{ key: "deals", label: "Deals" }]}
          categoryColors={Object.fromEntries(
            health.map((h) => [h.label, h.key === "unscored" ? VIZ_OTHER : STATUS_COLORS[h.key as keyof typeof STATUS_COLORS]]),
          )}
          table={{
            columns: [{ label: "Band" }, { label: "Deals", numeric: true }, { label: `Weighted ${moneyLabel.toLowerCase()}`, numeric: true }],
            rows: health.map((h) => [h.label, fmtNumber(h.deals), fmtUsd(h.weighted, { compact: true })]),
          }}
          footnote="Health score from the deal health model (AI or heuristic)."
        />
      </ChartGrid>

      <ChartGrid>
        <BarChart
          title="Velocity by stage"
          description="Average days spent in a stage, for moves into it within the date range"
          data={velocity.map((v) => ({ stage: label(v), avg: v.avgDays, median: v.medianDays, moves: v.moves }))}
          categoryKey="stage"
          categoryLabel="Stage"
          series={[{ key: "avg", label: "Avg days in stage" }]}
          format="days"
          table={{
            columns: [{ label: "Stage" }, { label: "Moves", numeric: true }, { label: "Avg days", numeric: true }, { label: "Median days", numeric: true }],
            rows: velocity.map((v) => [label(v), fmtNumber(v.moves), `${v.avgDays.toFixed(1)}`, `${v.medianDays.toFixed(1)}`]),
          }}
          footnote="From deal stage history; the current stage counts up to today."
          emptyText="No stage moves in this date range."
        />
        <BarChart
          title={`Stage conversion · ${conversion?.pipeline ?? conversionKey}`}
          description={`Share of deals reaching a stage that got to the next one (all time, ${conversion?.deals ?? 0} deals)`}
          data={(conversion?.stages ?? []).map((st) => ({ stage: `${st.name} → ${st.nextLabel}`, conversion: st.conversion ?? 0 }))}
          categoryKey="stage"
          categoryLabel="Step"
          series={[{ key: "conversion", label: "Conversion", color: VIZ[0] }]}
          format="pct"
          table={{
            columns: [{ label: "Stage" }, { label: "Reached", numeric: true }, { label: "Next", numeric: false }, { label: "Conversion", numeric: true }],
            rows: (conversion?.stages ?? []).map((st) => [st.name, fmtNumber(st.reached), st.nextLabel, st.conversion == null ? "—" : fmtPct(st.conversion)]),
          }}
          footnote={f.pipeline ? "Nurture/cold stages excluded from the funnel." : "Select a pipeline to change the funnel (default NetDev). Nurture/cold stages excluded."}
          emptyText="Not enough stage history yet."
        />
      </ChartGrid>

      <ChartGrid>
        <BarChart
          title="Win rate by motion"
          description="Deals closed (won or lost) in the date range"
          data={wins.byMotion.filter((r) => r.rate != null).map((r) => ({ motion: r.key, rate: r.rate }))}
          categoryKey="motion"
          categoryLabel="Motion"
          series={[{ key: "rate", label: "Win rate" }]}
          format="pct"
          table={{
            columns: [{ label: "Motion" }, { label: "Won", numeric: true }, { label: "Lost", numeric: true }, { label: "Win rate", numeric: true }],
            rows: wins.byMotion.map((r) => [r.name, fmtNumber(r.won), fmtNumber(r.lost), r.rate == null ? "—" : fmtPct(r.rate)]),
          }}
          emptyText="No deals closed in this range."
        />
        <BarChart
          title="Win rate by source"
          description="Deals closed (won or lost) in the date range"
          data={wins.bySource.slice(0, 12).map((r) => ({ source: r.source, rate: r.rate }))}
          categoryKey="source"
          categoryLabel="Source"
          series={[{ key: "rate", label: "Win rate" }]}
          format="pct"
          table={{
            columns: [{ label: "Source" }, { label: "Won", numeric: true }, { label: "Lost", numeric: true }, { label: "Win rate", numeric: true }],
            rows: wins.bySource.map((r) => [r.source, fmtNumber(r.won), fmtNumber(r.lost), r.rate == null ? "—" : fmtPct(r.rate)]),
          }}
          emptyText="No deals closed in this range."
        />
      </ChartGrid>

      <ChartGrid>
        <Panel title="Missing or overdue next step" description="Largest open deals first" footnote={`Weighted ${basisLabel(f)}`}>
          <DealLines
            items={att.noNextList.map((d) => ({
              id: d.id,
              name: d.name,
              pipeline: d.pipeline,
              primary: `${d.stage} · ${d.owner ?? "Unassigned"}`,
              secondary: d.nextStep ? `next step overdue ${relative(d.nextStepDueAt)}` : "no next step",
              value: d.value,
            }))}
            format="usdCompact"
            href={dealHref}
            empty="Every open deal has a current next step."
          />
        </Panel>
        <Panel title="Stalled deals" description="No activity logged in 14+ days" footnote={`Weighted ${basisLabel(f)}`}>
          <DealLines
            items={att.stalledList.map((d) => ({
              id: d.id,
              name: d.name,
              pipeline: d.pipeline,
              primary: `${d.stage} · ${d.owner ?? "Unassigned"}`,
              secondary: `last activity ${relative(d.lastActivityAt)}`,
              value: d.value,
            }))}
            format="usdCompact"
            href={dealHref}
            empty="No stalled deals."
          />
        </Panel>
      </ChartGrid>
    </div>
  );
}
