import { fmtNumber, fmtPct } from "@/lib/format";
import { pageContext } from "@/lib/analytics/page";
import { FUNNEL_STEPS, sdrFunnel, type FunnelGroup } from "@/lib/analytics/funnel";
import { BarChart, Funnel } from "@/components/charts";
import { DataTable } from "@/components/charts/chart-card";
import { ChartGrid, Panel } from "@/components/analytics/bits";

export const metadata = { title: "SDR / intern funnel · Analytics" };

function groupTable(groups: FunnelGroup[], label: string) {
  return {
    columns: [
      { label },
      { label: "Deals", numeric: true },
      ...FUNNEL_STEPS.map((s) => ({ label: s, numeric: true })),
      { label: "Outreach → qualified", numeric: true },
    ],
    rows: groups.map((g) => [
      g.label,
      fmtNumber(g.counts[0]),
      ...FUNNEL_STEPS.map((_, i) => fmtNumber(g.counts[i + 1])),
      g.counts[1] ? fmtPct(g.counts[4]! / g.counts[1]!) : "—",
    ]),
  };
}

export default async function SdrFunnelPage({ searchParams }: PageProps<"/analytics/funnel">) {
  const { ctx } = await pageContext(searchParams);
  if (!ctx) return null;
  const data = await sdrFunnel(ctx);
  const definitions = `Cohort: deals created in the date range. Outreach = outbound touch or moved past first stage · Reply = inbound email/LinkedIn · Meeting = meeting logged · Qualified = reached a stage ≥ ${fmtPct(data.threshold)} probability or won (handoff).`;
  const repRows = data.byRep.slice(0, 15).map((g) => ({ rep: g.label, qualified: g.counts[1] ? g.counts[4]! / g.counts[1]! : 0 }));

  return (
    <div className="space-y-6">
      <ChartGrid>
        <Funnel
          title="Outreach funnel"
          description={`${fmtNumber(data.cohort)} deals created in range`}
          steps={FUNNEL_STEPS.map((label, i) => ({ label, value: data.overall[i] ?? 0 }))}
          footnote={definitions}
          emptyText="No deals created in this range."
        />
        <BarChart
          title="Outreach → qualified, by rep"
          description="Share of reached-out deals that qualified"
          data={repRows}
          categoryKey="rep"
          categoryLabel="Rep"
          series={[{ key: "qualified", label: "Qualified rate" }]}
          format="pct"
          table={groupTable(data.byRep, "Rep")}
          emptyText="No outreach in this range."
        />
      </ChartGrid>
      <ChartGrid>
        <Panel title="By rep" description="Deal cohort per owner">
          {data.byRep.length ? <DataTable caption="Funnel by rep" table={groupTable(data.byRep, "Rep")} /> : <p className="py-6 text-center text-xs text-muted">No deals in this range.</p>}
        </Panel>
        <Panel title="By source list" description="e.g. automated outreach vs manual lists vs Lead Scout">
          {data.bySource.length ? <DataTable caption="Funnel by source" table={groupTable(data.bySource, "Source")} /> : <p className="py-6 text-center text-xs text-muted">No deals in this range.</p>}
        </Panel>
      </ChartGrid>
    </div>
  );
}
