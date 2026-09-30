import { fmtNumber, fmtPct, fmtUsd } from "@/lib/format";
import { pageContext } from "@/lib/analytics/page";
import { leadScout, SCOUT_STEPS } from "@/lib/analytics/scout";
import { NoAccess } from "@/components/admin/admin-nav";
import { BarChart, Funnel, KpiTile } from "@/components/charts";
import { DataTable } from "@/components/charts/chart-card";
import { ChartGrid, KpiGrid, Panel } from "@/components/analytics/bits";

export const metadata = { title: "Lead Scout · Analytics" };

export default async function LeadScoutAnalyticsPage({ searchParams }: PageProps<"/analytics/scout">) {
  const { ctx, now } = await pageContext(searchParams);
  if (!ctx) return null;
  if (!ctx.scoutAllowed) return <NoAccess message="Lead Scout isn't part of your role." />;
  const d = await leadScout(ctx, now);
  const [found, accepted] = d.counts;

  return (
    <div className="space-y-6">
      <KpiGrid>
        <KpiTile label="Candidates found" value={fmtNumber(found)} basis={`${fmtNumber(accepted)} accepted · ${found ? fmtPct((accepted ?? 0) / found) : "—"} acceptance`} />
        <KpiTile label="Apify spend" value={fmtUsd(d.cost.totalUsd)} basis={`Scout ${fmtUsd(d.cost.scoutUsd)} · enrichment ${fmtUsd(d.cost.enrichUsd)} · ${d.cost.runs} runs`} />
        <KpiTile label="Cost per accepted target" value={d.cost.perAccepted == null ? "—" : fmtUsd(d.cost.perAccepted)} basis="Spend in range ÷ candidates accepted" />
        {d.budget ? (
          <KpiTile
            label="Budget this month"
            value={`${fmtUsd(d.budget.usedUsd)} / ${fmtUsd(d.budget.capUsd)}`}
            basis={`${fmtPct(d.budget.capUsd ? d.budget.usedUsd / d.budget.capUsd : 0)} of the org monthly cap`}
          />
        ) : (
          <KpiTile label="Enrichment verified" value={d.cost.verifiedRate == null ? "—" : fmtPct(d.cost.verifiedRate)} basis="Verified emails ÷ results" />
        )}
      </KpiGrid>
      <ChartGrid>
        <Funnel
          title="Scout funnel"
          description="Candidates found in the date range"
          steps={SCOUT_STEPS.map((label, i) => ({ label, value: d.counts[i] ?? 0 }))}
          footnote="Contacted = outbound touch on the matched account after it was found · Won = the account has a won deal."
          emptyText="No candidates found in this range."
        />
        <BarChart
          title="Fit Score calibration"
          description="Acceptance rate by Fit Score band"
          data={d.byBand.map((b) => ({ band: b.band, rate: b.found ? b.accepted / b.found : 0 }))}
          categoryKey="band"
          categoryLabel="Fit band"
          series={[{ key: "rate", label: "Accepted" }]}
          format="pct"
          table={{
            columns: [{ label: "Band" }, { label: "Found", numeric: true }, { label: "Accepted", numeric: true }, { label: "Won", numeric: true }],
            rows: d.byBand.map((b) => [b.band, fmtNumber(b.found), fmtNumber(b.accepted), fmtNumber(b.won)]),
          }}
          emptyText="No candidates found in this range."
        />
      </ChartGrid>
      <Panel title="By search" description="Found, accepted and rejected per scout search" footnote="USD costs from enrichment runs; Apify pilot cap applies org-wide (D8).">
        {d.bySearch.length ? (
          <DataTable
            caption="Scout searches"
            table={{
              columns: [
                { label: "Search" },
                { label: "Found", numeric: true },
                { label: "Accepted", numeric: true },
                { label: "Rejected", numeric: true },
                { label: "Acceptance", numeric: true },
                { label: "Avg fit", numeric: true },
              ],
              rows: d.bySearch.map((r) => [
                r.name,
                fmtNumber(r.found),
                fmtNumber(r.accepted),
                fmtNumber(r.rejected),
                r.found ? fmtPct(r.accepted / r.found) : "—",
                r.avgFit == null ? "—" : fmtNumber(r.avgFit),
              ]),
            }}
          />
        ) : (
          <p className="py-6 text-center text-xs text-muted">No scout searches in this range.</p>
        )}
      </Panel>
    </div>
  );
}
