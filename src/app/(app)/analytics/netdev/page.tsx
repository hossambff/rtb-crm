import { PIPELINE_COLORS } from "@/lib/palette";
import { fmtNumber, fmtPct, fmtUsd } from "@/lib/format";
import { pageContext } from "@/lib/analytics/page";
import { netdevSports } from "@/lib/analytics/netdev";
import { pivot, topNWithOther } from "@/lib/analytics/transforms";
import { BarChart, KpiTile } from "@/components/charts";
import { ChartGrid, KpiGrid } from "@/components/analytics/bits";

export const metadata = { title: "NetDev & Sports · Analytics" };

type DimRow = { label: string; pipeline: string; muu: number; weightedMuu: number; deals: number };

function dimRows(rows: DimRow[], keys: string[], n = 12) {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.label, (totals.get(r.label) ?? 0) + r.muu);
  const top = topNWithOther(
    [...totals.entries()].map(([label, muu]) => ({ label, muu })),
    n,
    "label",
    "muu",
  ).map((r) => r.label);
  const folded = rows.map((r) => ({ ...r, label: top.includes(r.label) ? r.label : "Other" }));
  const wide = pivot(folded, "label", "pipeline", "muu", keys);
  return top.map((l) => wide.find((w) => w.label === l)).filter(Boolean) as Record<string, string | number>[];
}

export default async function NetdevSportsPage({ searchParams }: PageProps<"/analytics/netdev">) {
  const { ctx } = await pageContext(searchParams);
  if (!ctx) return null;
  const d = await netdevSports(ctx);
  const series = d.keys.map((k) => ({ key: k, label: k === "NET" ? "NetDev" : "Sports", color: PIPELINE_COLORS[k] }));
  const estShare = d.totals.muu ? d.estimatedMuu / d.totals.muu : 0;
  const muuNote = `Open deals · MUU incl. estimates (${fmtPct(estShare)} not verified) · ${ctx.filters.overrides ? "incl." : "excl."} manual overrides for weighting`;

  return (
    <div className="space-y-6">
      <KpiGrid>
        <KpiTile label="Open MUU pipeline" value={fmtNumber(d.totals.muu, { compact: true })} basis={`${fmtNumber(d.totals.weightedMuu, { compact: true })} weighted · ${fmtNumber(d.totals.deals)} deals`} />
        <KpiTile label="Migrating" value={fmtNumber(d.migrating)} basis="Won, onboarding in progress" />
        <KpiTile label="Live" value={fmtNumber(d.live)} basis="Won and launched" />
        {d.guarantee ? (
          <KpiTile
            label="Guarantee exposure"
            value={`${fmtUsd(d.guarantee.committed, { compact: true })}/mo`}
            basis={`Committed on ${d.guarantee.committedDeals} won deals · ${fmtUsd(d.guarantee.proposed, { compact: true })}/mo weighted in open deals (${d.guarantee.proposedDeals})`}
          />
        ) : (
          <KpiTile label="Guarantee exposure" value="—" basis="Guarantee terms are hidden for your role" />
        )}
      </KpiGrid>

      <ChartGrid>
        <BarChart
          title="MUU pipeline by category"
          description="Open deals, unweighted MUU"
          data={dimRows(d.byCategory, d.keys)}
          categoryKey="label"
          categoryLabel="Category"
          series={series}
          stacked={series.length > 1}
          totalColumn
          format="compact"
          footnote={muuNote}
          emptyText="No open NetDev or Sports deals."
        />
        <BarChart
          title="MUU pipeline by region"
          description="Open deals, unweighted MUU (region, else country)"
          data={dimRows(d.byRegion, d.keys)}
          categoryKey="label"
          categoryLabel="Region"
          series={series}
          stacked={series.length > 1}
          totalColumn
          format="compact"
          footnote={muuNote}
          emptyText="No open NetDev or Sports deals."
        />
      </ChartGrid>
      <ChartGrid>
        <BarChart
          title="Sports MUU by league"
          description="Open Sports deals"
          data={dimRows(
            d.byLeague.filter((r) => r.pipeline === "SPT"),
            ["SPT"],
          )}
          categoryKey="label"
          categoryLabel="League"
          series={[{ key: "SPT", label: "Sports", color: PIPELINE_COLORS.SPT }]}
          format="compact"
          footnote={muuNote}
          emptyText="No open Sports deals."
        />
        <BarChart
          title="Won: migrating & live"
          description="Won deals by current stage"
          data={d.wonStages.map((r) => ({ stage: `${r.pipeline} · ${r.stage}`, deals: r.deals, pipeline: r.pipeline }))}
          categoryKey="stage"
          categoryLabel="Stage"
          series={[{ key: "deals", label: "Deals" }]}
          categoryColors={Object.fromEntries(d.wonStages.map((r) => [`${r.pipeline} · ${r.stage}`, PIPELINE_COLORS[r.pipeline] ?? "#828282"]))}
          table={{
            columns: [{ label: "Stage" }, { label: "Deals", numeric: true }, { label: "MUU", numeric: true }],
            rows: d.wonStages.map((r) => [`${r.pipeline} · ${r.stage}`, fmtNumber(r.deals), fmtNumber(r.muu, { compact: true })]),
          }}
          emptyText="No won NetDev or Sports deals yet."
        />
      </ChartGrid>
    </div>
  );
}
