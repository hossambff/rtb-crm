import Link from "next/link";
import { Plus } from "lucide-react";
import { can, requireUser } from "@/lib/rbac/server";
import { listProposals } from "@/lib/proposals/queries";
import { fmtDate } from "@/lib/format";
import { PIPELINE_COLORS } from "@/lib/palette";
import { ColorTick } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { ProposalStatusBadge } from "@/components/proposals/proposal-controls";
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
        description="Enterprise pro formas: cost RTB takes on, EBITDA before and after, revenue share and guarantee exposure."
        actions={
          canCreate ? (
            <Button variant="primary" asChild>
              <Link href="/proposals/new">
                <Plus /> New pro forma
              </Link>
            </Button>
          ) : null
        }
      />
      {rows.length === 0 ? (
        <EmptyState title="No proposals yet" description="Start a pro forma from an Enterprise deal. Versions, approvals and the one-pager export live here." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-surface-1 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Deal</th>
                <th className="px-3 py-2 font-medium">Latest</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">EBITDA uplift</th>
                <th className="px-3 py-2 text-right font-medium">RTB share / yr</th>
                <th className="px-3 py-2 text-right font-medium">Client net</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border hover:bg-surface-1">
                  <td className="px-3 py-2">
                    <Link href={`/proposals/${r.id}`} className="flex items-center gap-2 font-medium text-fg hover:underline">
                      <ColorTick color={PIPELINE_COLORS[r.pipelineKey] ?? "#828282"} />
                      {r.dealName}
                    </Link>
                    {r.accountName ? <p className="pl-3 text-[11px] text-muted">{r.accountName}</p> : null}
                  </td>
                  <td className="px-3 py-2 tabular text-secondary">
                    v{r.version}
                    {r.versions > 1 ? <span className="text-muted"> of {r.versions}</span> : null}
                  </td>
                  <td className="px-3 py-2">
                    <ProposalStatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-right tabular">+{usdK(r.uplift)}</td>
                  <td className="px-3 py-2 text-right tabular">{usdK(r.rtbShare)}</td>
                  <td className="px-3 py-2 text-right tabular text-fg">{usdK(r.clientNetAfterShare)}</td>
                  <td className="px-3 py-2 tabular text-secondary">
                    {fmtDate(r.createdAt)} · {r.createdByName ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
