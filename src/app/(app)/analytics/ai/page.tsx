import { STATUS_COLORS } from "@/lib/palette";
import { fmtNumber, fmtPct, fmtUsd } from "@/lib/format";
import { pageContext } from "@/lib/analytics/page";
import { AI_ORIGIN_LABELS, aiAutomation } from "@/lib/analytics/ai";
import { BarChart, KpiTile, LineChart } from "@/components/charts";
import { DataTable } from "@/components/charts/chart-card";
import { ChartGrid, KpiGrid, Panel } from "@/components/analytics/bits";

export const metadata = { title: "AI & automation · Analytics" };

export default async function AiAutomationPage({ searchParams }: PageProps<"/analytics/ai">) {
  const { ctx } = await pageContext(searchParams);
  if (!ctx) return null;
  const d = await aiAutomation(ctx);
  const runs = d.byKind.reduce((a, r) => a + r.runs, 0);
  const errors = d.byKind.reduce((a, r) => a + r.errors, 0);
  const cost = d.byKind.reduce((a, r) => a + r.costUsd, 0);
  const tasksCreated = d.tasks.reduce((a, t) => a + t.created, 0);
  const done = d.tasks.reduce((a, t) => a + t.done, 0);
  const cancelled = d.tasks.reduce((a, t) => a + t.cancelled, 0);
  const avgLatency = runs ? d.byKind.reduce((a, r) => a + (r.avgLatency ?? 0) * r.runs, 0) / runs : null;

  return (
    <div className="space-y-6">
      <KpiGrid>
        <KpiTile label="Agent runs" value={fmtNumber(runs)} basis={`${fmtNumber(errors)} errors · ${runs ? fmtPct(errors / runs, 1) : "—"} error rate`} trend={d.byDay.length > 1 ? d.byDay.map((r) => r.runs) : undefined} />
        <KpiTile label="Avg latency" value={avgLatency == null ? "—" : `${(avgLatency / 1000).toFixed(1)}s`} basis="Across all run kinds" />
        <KpiTile label="AI-created tasks" value={fmtNumber(tasksCreated)} basis={`${done + cancelled ? fmtPct(done / (done + cancelled)) : "—"} accepted (done ÷ done + dismissed)`} />
        <KpiTile label="Alerts fired" value={fmtNumber(d.alerts.fired)} basis={`${fmtNumber(d.alerts.resolved)} resolved · ${fmtNumber(d.alerts.escalated)} escalated · AI cost ${fmtUsd(cost)}`} />
      </KpiGrid>
      <ChartGrid>
        <BarChart
          title="Runs by kind"
          description="Succeeded vs errored agent runs"
          data={d.byKind.map((r) => ({ kind: r.kind, ok: r.runs - r.errors, errors: r.errors }))}
          categoryKey="kind"
          categoryLabel="Kind"
          series={[
            { key: "ok", label: "Succeeded", color: STATUS_COLORS.good },
            { key: "errors", label: "Errored", color: STATUS_COLORS.critical },
          ]}
          stacked
          table={{
            columns: [
              { label: "Kind" },
              { label: "Runs", numeric: true },
              { label: "Errors", numeric: true },
              { label: "Avg latency", numeric: true },
              { label: "p95 latency", numeric: true },
              { label: "Cost", numeric: true },
            ],
            rows: d.byKind.map((r) => [
              r.kind,
              fmtNumber(r.runs),
              fmtNumber(r.errors),
              r.avgLatency == null ? "—" : `${Math.round(r.avgLatency)} ms`,
              r.p95Latency == null ? "—" : `${Math.round(r.p95Latency)} ms`,
              fmtUsd(r.costUsd),
            ]),
          }}
          emptyText="No agent runs in this range."
        />
        <LineChart
          title="Runs per day"
          description="All agent runs, UTC days"
          data={d.byDay.map((r) => ({ day: r.day, runs: r.runs, errors: r.errors }))}
          xKey="day"
          series={[
            { key: "runs", label: "Runs" },
            { key: "errors", label: "Errors", color: STATUS_COLORS.critical },
          ]}
          emptyText="No agent runs in this range."
        />
      </ChartGrid>
      <Panel title="AI-created tasks" description="Tasks created from emails, calls and Copilot in the date range" footnote="Acceptance = completed ÷ (completed + dismissed); open tasks are pending.">
        {d.tasks.length ? (
          <DataTable
            caption="AI-created tasks"
            table={{
              columns: [
                { label: "Origin" },
                { label: "Created", numeric: true },
                { label: "Done", numeric: true },
                { label: "Dismissed", numeric: true },
                { label: "Open", numeric: true },
                { label: "Acceptance", numeric: true },
                { label: "Avg time to done", numeric: true },
              ],
              rows: d.tasks.map((t) => [
                AI_ORIGIN_LABELS[t.origin as keyof typeof AI_ORIGIN_LABELS] ?? t.origin,
                fmtNumber(t.created),
                fmtNumber(t.done),
                fmtNumber(t.cancelled),
                fmtNumber(t.open),
                t.acceptance == null ? "—" : fmtPct(t.acceptance),
                t.avgHoursToDone == null ? "—" : `${t.avgHoursToDone.toFixed(1)} h`,
              ]),
            }}
          />
        ) : (
          <p className="py-6 text-center text-xs text-muted">No AI-created tasks in this range.</p>
        )}
      </Panel>
    </div>
  );
}
