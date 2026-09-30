import { fmtNumber, fmtPct, fmtUsd } from "@/lib/format";
import { pageContext } from "@/lib/analytics/page";
import { ACTIVITY_LABELS, ACTIVITY_TYPES, repScorecard } from "@/lib/analytics/reps";
import { BarChart, KpiTile } from "@/components/charts";
import { DataTable } from "@/components/charts/chart-card";
import { ChartGrid, KpiGrid, Panel } from "@/components/analytics/bits";

export const metadata = { title: "Rep scorecard · Analytics" };

export default async function RepScorecardPage({ searchParams }: PageProps<"/analytics/reps">) {
  const { ctx, now } = await pageContext(searchParams);
  if (!ctx) return null;
  const rows = await repScorecard(ctx, now);
  const moneyLabel = ctx.filters.basis === "net" ? "RTB net" : "Gross";
  const total = (k: "totalActivities" | "meetingsHeld" | "dealsAdvanced" | "won" | "wonValue" | "createdValue") => rows.reduce((a, r) => a + r[k], 0);
  const openDeals = rows.reduce((a, r) => a + r.openDeals, 0);
  const hygieneAvg = openDeals ? rows.reduce((a, r) => a + (r.hygiene ?? 0) * r.openDeals, 0) / openDeals : null;
  const due = rows.reduce((a, r) => a + r.commitmentsDue, 0);
  const kept = rows.reduce((a, r) => a + r.commitmentsKept, 0);
  const chartRows = rows.filter((r) => r.totalActivities > 0).slice(0, 20);

  return (
    <div className="space-y-6">
      <KpiGrid>
        <KpiTile label="Activities" value={fmtNumber(total("totalActivities"))} basis={`${fmtNumber(total("meetingsHeld"))} meetings held`} />
        <KpiTile label="Deals advanced" value={fmtNumber(total("dealsAdvanced"))} basis={`${fmtNumber(total("won"))} won · ${fmtUsd(total("wonValue"), { compact: true })} ${moneyLabel.toLowerCase()}`} />
        <KpiTile label="Pipeline hygiene" value={hygieneAvg == null ? "—" : fmtPct(hygieneAvg)} basis="Open deals with a next step that isn't overdue" />
        <KpiTile label="Commitments kept" value={due ? fmtPct(kept / due) : "—"} basis={`${kept} of ${due} due · our commitments completed on time`} />
      </KpiGrid>

      <ChartGrid>
        <BarChart
          title="Activities by type"
          description="Logged by each rep in the date range"
          data={chartRows.map((r) => ({ rep: r.name, ...r.activities }))}
          categoryKey="rep"
          categoryLabel="Rep"
          series={ACTIVITY_TYPES.map((t) => ({ key: t, label: ACTIVITY_LABELS[t] }))}
          stacked
          totalColumn
          emptyText="No activities logged in this range."
        />
        <BarChart
          title="Pipeline created"
          description="Gross value of deals created in the date range, by owner"
          data={rows.filter((r) => r.createdValue > 0).map((r) => ({ rep: r.name, value: r.createdValue }))}
          categoryKey="rep"
          categoryLabel="Rep"
          series={[{ key: "value", label: "Pipeline created (gross)" }]}
          format="usdCompact"
          footnote="Gross basis · unweighted"
          emptyText="No deals created in this range."
        />
      </ChartGrid>

      <Panel
        title="Scorecard"
        description="Per rep, date range applies to activities, meetings, moves, wins, creation and commitments"
        footnote={`Won value in ${moneyLabel.toLowerCase()}. Response time needs Gmail sync reply timestamps — shown once the inbox module reports it.`}
      >
        {rows.length ? (
          <DataTable
            caption="Rep scorecard"
            table={{
              columns: [
                { label: "Rep" },
                { label: "Activities", numeric: true },
                { label: "Meetings held", numeric: true },
                { label: "Deals advanced", numeric: true },
                { label: "Won", numeric: true },
                { label: `Won ${moneyLabel.toLowerCase()}`, numeric: true },
                { label: "Created", numeric: true },
                { label: "Open deals", numeric: true },
                { label: "Hygiene", numeric: true },
                { label: "Commitments kept", numeric: true },
                { label: "Response time", numeric: true },
              ],
              rows: rows.map((r) => [
                r.name,
                fmtNumber(r.totalActivities),
                fmtNumber(r.meetingsHeld),
                fmtNumber(r.dealsAdvanced),
                fmtNumber(r.won),
                fmtUsd(r.wonValue, { compact: true }),
                fmtNumber(r.created),
                fmtNumber(r.openDeals),
                r.hygiene == null ? "—" : fmtPct(r.hygiene),
                r.commitmentsRate == null ? "—" : `${fmtPct(r.commitmentsRate)} (${r.commitmentsKept}/${r.commitmentsDue})`,
                "—",
              ]),
            }}
          />
        ) : (
          <p className="py-6 text-center text-xs text-muted">No rep activity in this selection.</p>
        )}
      </Panel>
    </div>
  );
}
