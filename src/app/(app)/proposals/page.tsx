import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { can, requireUser } from "@/lib/rbac/server";
import { listProposals } from "@/lib/proposals/queries";
import { fmtDate } from "@/lib/format";
import { PIPELINE_COLORS } from "@/lib/palette";
import { ColorTick } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { ProposalStatusBadge } from "@/components/proposals/proposal-controls";
import { TermSheetStatusBadge } from "@/components/proposals/term-sheet-controls";
import { usdK } from "@/lib/proposals/calc";

export const metadata = { title: "Proposals" };

export default async function ProposalsPage() {
  const user = await requireUser();
  if (!(await can(user, "proposals", "view"))) return <EmptyState title="No access" description="Your role can't view proposals and pro formas." />;
  const [rows, canCreate] = await Promise.all([listProposals(user), can(user, "proposals", "create")]);
  return (
    <div>
      <PageHeader
        title="Proposals"
        description="Enterprise pro formas and Network Development coalition term sheets: versions, approvals and exports."
        actions={
          canCreate ? (
            <>
              <Button asChild>
                <Link href="/proposals/term-sheets/new">
                  <FileText /> New term sheet
                </Link>
              </Button>
              <Button variant="primary" asChild>
                <Link href="/proposals/new">
                  <Plus /> New pro forma
                </Link>
              </Button>
            </>
          ) : null
        }
      />
      {rows.length === 0 ? (
        <EmptyState title="No proposals yet" description="Start a pro forma from an Enterprise deal, or a coalition term sheet from a Network Development deal." />
      ) : (
        <>
        {/* Phones: stacked cards with the key figure and status (QA MIN-29); the wide table from sm up. */}
        <ul className="divide-y divide-border rounded-lg border border-border sm:hidden">
          {rows.map((r) => {
            const ts = r.kind === "coalition_term_sheet";
            return (
              <li key={r.id} className="px-3 py-3">
                <Link href={ts ? `/proposals/term-sheets/${r.id}` : `/proposals/${r.id}`} className="flex items-center gap-2 font-medium text-fg hover:underline">
                  <ColorTick color={PIPELINE_COLORS[r.pipelineKey] ?? "#828282"} />
                  <span className="min-w-0 truncate">{r.dealName}</span>
                </Link>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary">
                  {ts ? <TermSheetStatusBadge status={r.status} /> : <ProposalStatusBadge status={r.status} />}
                  <span>
                    {ts ? "Term sheet" : "Pro forma"} · v{r.version}
                  </span>
                  <span className="tabular">
                    {ts ? (r.tierLabel ? `Tier ${r.tierLabel}${r.partnerPct !== null ? ` · partner ${r.partnerPct}%` : ""}` : "No tier") : `+${usdK(r.uplift)} uplift`}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted tabular">
                  {fmtDate(r.createdAt)} · {r.createdByName ?? "—"}
                </p>
              </li>
            );
          })}
        </ul>
        <div className="hidden overflow-x-auto rounded-lg border border-border sm:block">
          <table className="table-cards w-full min-w-[860px] text-sm">
            <thead className="bg-surface-1 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Deal</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Latest</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">EBITDA uplift</th>
                <th className="px-3 py-2 text-right font-medium">RTB share / yr</th>
                <th className="px-3 py-2 text-right font-medium">Client net</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ts = r.kind === "coalition_term_sheet";
                return (
                <tr key={r.id} className="border-t border-border hover:bg-surface-1">
                  <td data-label="Deal" data-primary className="px-3 py-2">
                    <div className="min-w-0">
                      <Link href={ts ? `/proposals/term-sheets/${r.id}` : `/proposals/${r.id}`} className="flex items-center gap-2 font-medium text-fg hover:underline">
                        <ColorTick color={PIPELINE_COLORS[r.pipelineKey] ?? "#828282"} />
                        {r.dealName}
                      </Link>
                      {r.accountName ? <p className="pl-3 text-[11px] text-muted">{r.accountName}</p> : null}
                    </div>
                  </td>
                  <td data-label="Type" className="px-3 py-2 text-secondary">{ts ? "Term sheet" : "Pro forma"}</td>
                  <td data-label="Latest" className="px-3 py-2 tabular text-secondary">
                    v{r.version}
                    {r.versions > 1 ? <span className="text-muted"> of {r.versions}</span> : null}
                  </td>
                  <td data-label="Status" className="px-3 py-2">{ts ? <TermSheetStatusBadge status={r.status} /> : <ProposalStatusBadge status={r.status} />}</td>
                  {ts ? (
                    <td data-label="Terms" colSpan={3} className="px-3 py-2 text-right text-secondary tabular">
                      {r.tierLabel ? `Tier ${r.tierLabel}${r.partnerPct !== null ? ` · partner ${r.partnerPct}%` : ""}` : "No tier"}
                    </td>
                  ) : (
                    <>
                      <td data-label="EBITDA uplift" className="px-3 py-2 text-right tabular">+{usdK(r.uplift)}</td>
                      <td data-label="RTB share / yr" className="px-3 py-2 text-right tabular">{usdK(r.rtbShare)}</td>
                      <td data-label="Client net" className="px-3 py-2 text-right tabular text-fg">{usdK(r.clientNetAfterShare)}</td>
                    </>
                  )}
                  <td data-label="Updated" className="px-3 py-2 tabular text-secondary">
                    {fmtDate(r.createdAt)} · {r.createdByName ?? "—"}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}
