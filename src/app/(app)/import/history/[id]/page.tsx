import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Stat } from "@/components/ui/misc";
import { BatchStatus } from "@/components/import/batch-table";
import { RollbackButton } from "@/components/import/rollback-button";
import { getBatchDetail } from "@/lib/import/server";
import { fmtDate, fmtNumber } from "@/lib/format";
import { can, requireUser, scopeFor } from "@/lib/rbac/server";

export const metadata = { title: "Import batch" };

const HREF: Record<string, string> = { account: "/accounts/", contact: "/contacts/", deal: "/deals/" };

export default async function ImportBatchPage(props: PageProps<"/import/history/[id]">) {
  const user = await requireUser();
  if (!(await can(user, "import", "import"))) forbidden();
  const { id } = await props.params;
  const detail = await getBatchDetail(id);
  if (!detail) notFound();
  const { batch, summary, rows } = detail;
  const scope = await scopeFor(user, "import", "import");
  const canRollback = scope === "all" || scope === "pipeline" || (scope === "team" && !!batch.createdBy && user.teamMemberIds.includes(batch.createdBy)) || (scope === "own" && batch.createdBy === user.id);
  if (!canRollback && batch.createdBy !== user.id) notFound();
  const stats = (batch.stats ?? {}) as Record<string, number>;

  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 text-xs text-muted">
        <Link href="/import/history" className="hover:text-fg">
          Import history
        </Link>
        <ChevronRight className="size-3" aria-hidden />
        <span className="truncate text-secondary">{batch.fileName}</span>
      </nav>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate font-display text-[26px] font-medium leading-9 text-fg">{batch.fileName}</h1>
          <p className="mt-1 text-sm text-muted">
            {batch.sheetName ? `${batch.sheetName} · ` : ""}
            {batch.target.replace(/_/g, " ")}
            {batch.pipelineKey ? ` · ${batch.pipelineKey}` : ""} · {batch.createdByName ?? "Migration script"} · {fmtDate(batch.createdAt, "d MMM yyyy HH:mm")}
          </p>
          <div className="mt-2 flex gap-2">
            <BatchStatus status={batch.status} />
            {batch.rolledBackAt ? <Badge>Rolled back {fmtDate(batch.rolledBackAt, "d MMM HH:mm")}</Badge> : null}
          </div>
        </div>
        {canRollback && batch.status !== "rolled_back" ? <RollbackButton batchId={batch.id} label={batch.fileName} size="md" /> : null}
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Rows" value={fmtNumber(stats.rows ?? 0)} hint={`${fmtNumber(stats.skipped ?? 0)} skipped`} />
        <Stat label="Accounts" value={fmtNumber(stats.accountsCreated ?? 0)} hint={`${fmtNumber(stats.accountsUpdated ?? 0)} updated · ${fmtNumber(stats.duplicatesMerged ?? 0)} merged`} />
        <Stat label="Deals" value={fmtNumber(stats.dealsCreated ?? 0)} hint={`${fmtNumber(stats.dealsUpdated ?? 0)} updated`} />
        <Stat label="Contacts" value={fmtNumber(stats.contactsCreated ?? 0)} hint={`${fmtNumber(stats.activitiesCreated ?? 0)} notes · ${fmtNumber(stats.metricsCreated ?? 0)} metrics`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Row-level results</CardTitle>
          </CardHeader>
          <CardContent>
            {summary.length ? (
              <table className="w-full text-sm">
                <tbody>
                  {summary
                    .sort((a, b) => a.entity.localeCompare(b.entity))
                    .map((r) => (
                      <tr key={`${r.entity}-${r.action}`} className="border-b border-border last:border-0">
                        <td className="py-1.5 text-secondary">{r.entity.replace(/_/g, " ")}</td>
                        <td className="py-1.5">
                          <Badge>{r.action}</Badge>
                        </td>
                        <td className="py-1.5 text-right tabular text-fg">{fmtNumber(r.n)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted">No row records were written for this batch.</p>
            )}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Records</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {rows.length ? (
              <div className="max-h-[560px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface-1">
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                      <th className="h-9 px-4 font-medium">Record</th>
                      <th className="px-4 font-medium">Type</th>
                      <th className="px-4 font-medium">Action</th>
                      <th className="px-4 font-medium">Fields changed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.entity}-${r.entityId}-${r.action}`} className="border-b border-border last:border-0">
                        <td className="max-w-[260px] px-4 py-2">
                          {r.deleted ? (
                            <span className="truncate text-muted line-through">{r.name ?? r.entityId}</span>
                          ) : (
                            <Link href={`${HREF[r.entity]}${r.entityId}`} className="block truncate text-fg hover:underline">
                              {r.name ?? r.entityId}
                            </Link>
                          )}
                        </td>
                        <td className="px-4 text-secondary">{r.entity}</td>
                        <td className="px-4">
                          <Badge>{r.action}</Badge>
                        </td>
                        <td className="max-w-[260px] truncate px-4 text-xs text-muted">{r.before && typeof r.before === "object" ? Object.keys(r.before as object).join(", ") : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-5">
                <EmptyState title="Nothing recorded" description="This batch didn't create or change accounts, deals or contacts." />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
