import { fmtDate, fmtNumber, fmtPct } from "@/lib/format";
import { dealHref, pageContext } from "@/lib/analytics/page";
import { dataQuality } from "@/lib/analytics/quality";
import { BarChart, KpiTile } from "@/components/charts";
import { DataTable } from "@/components/charts/chart-card";
import { ChartGrid, DealLines, KpiGrid, Panel } from "@/components/analytics/bits";

export const metadata = { title: "Data quality · Analytics" };

export default async function DataQualityPage({ searchParams }: PageProps<"/analytics/quality">) {
  const { ctx } = await pageContext(searchParams);
  if (!ctx) return null;
  const d = await dataQuality(ctx);
  const issues = [
    { issue: "Duplicate domains", n: d.domainDupes.length },
    { issue: "Duplicate account names", n: d.nameDupes.reduce((a, r) => a + r.n, 0) },
    { issue: "Duplicate contact emails", n: d.emailDupes.reduce((a, r) => a + r.n, 0) },
    { issue: "Missing MUU (engaged)", n: d.missingMuu.length },
    { issue: "Missing primary contact", n: d.missingContact },
    { issue: "Invalid emails", n: d.invalidEmails.count },
    { issue: "Unmapped import statuses", n: d.unmapped.count },
    { issue: "Accounts without domain", n: d.missingDomain },
  ];

  return (
    <div className="space-y-6">
      <KpiGrid>
        <KpiTile label="Missing MUU on engaged deals" value={fmtNumber(d.missingMuu.length)} basis={`MUU pipelines · stage ≥ ${fmtPct(d.threshold)}`} />
        <KpiTile label="Open deals without primary contact" value={fmtNumber(d.missingContact)} basis="Required before Contract" />
        <KpiTile label="Invalid emails" value={fmtNumber(d.invalidEmails.count)} basis="Malformed or verified invalid" />
        <KpiTile label="Unmapped import statuses" value={fmtNumber(d.unmapped.count)} basis={`${d.unmapped.batches.length} import batches in range`} />
      </KpiGrid>
      <ChartGrid>
        <BarChart
          title="Issues by type"
          description="Records needing attention in your scope"
          data={issues}
          categoryKey="issue"
          categoryLabel="Issue"
          series={[{ key: "n", label: "Records" }]}
          emptyText="No data-quality issues found."
        />
        <Panel title="Engaged deals missing MUU" description="Weighted value is understated until MUU is set">
          <DealLines
            items={d.missingMuu.slice(0, 12).map((r) => ({ id: r.id, name: r.name, pipeline: r.pipeline, primary: r.stage, value: Number.NaN }))}
            format="compact"
            href={dealHref}
            empty="Every engaged MUU deal has an audience figure."
          />
        </Panel>
      </ChartGrid>
      <ChartGrid>
        <Panel title="Possible duplicate accounts" description="Same name, or a domain listed as another account's alternate domain">
          {d.nameDupes.length || d.domainDupes.length ? (
            <DataTable
              caption="Possible duplicate accounts"
              table={{
                columns: [{ label: "Account" }, { label: "Records", numeric: true }, { label: "Domains" }],
                rows: [
                  ...d.nameDupes.map((r) => [r.sample, fmtNumber(r.n), r.domains]),
                  ...d.domainDupes.map((r) => [r.name, "alt-domain", r.domain ?? "—"]),
                ],
              }}
            />
          ) : (
            <p className="py-6 text-center text-xs text-muted">No duplicates found.</p>
          )}
        </Panel>
        <Panel title="Contacts" description="Duplicate and invalid emails">
          {d.emailDupes.length || d.invalidEmails.sample.length ? (
            <DataTable
              caption="Contact email issues"
              table={{
                columns: [{ label: "Email" }, { label: "Issue" }, { label: "Contact" }],
                rows: [
                  ...d.emailDupes.map((r) => [r.email, `${r.n} contacts share it`, "—"]),
                  ...d.invalidEmails.sample.map((c) => [c.email ?? "—", c.status === "invalid" ? "Verified invalid" : "Malformed", c.name]),
                ],
              }}
            />
          ) : (
            <p className="py-6 text-center text-xs text-muted">No contact email issues.</p>
          )}
        </Panel>
      </ChartGrid>
      <Panel title="Imports with unmapped statuses" description="Status values that didn't map to a stage (Admin → Pipelines → import aliases)">
        {d.unmapped.batches.length ? (
          <DataTable
            caption="Imports with unmapped statuses"
            table={{
              columns: [{ label: "File" }, { label: "Sheet" }, { label: "Target" }, { label: "Unmapped", numeric: true }, { label: "Imported" }],
              rows: d.unmapped.batches.map((b) => [b.fileName, b.sheet ?? "—", b.target, fmtNumber(b.unmapped), fmtDate(b.createdAt)]),
            }}
          />
        ) : (
          <p className="py-6 text-center text-xs text-muted">No unmapped statuses in imports from this range.</p>
        )}
      </Panel>
    </div>
  );
}
