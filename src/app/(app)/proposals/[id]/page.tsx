import { cache } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { getProposal, proposalKindOf } from "@/lib/proposals/queries";
import { isLocked } from "@/lib/proposals/calc";
import { fmtDate } from "@/lib/format";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";
import { ProFormaBuilder } from "@/components/proposals/builder";
import { ProposalActions, ProposalStatusBadge, VersionDiff } from "@/components/proposals/proposal-controls";

const loadProposal = cache(async (id: string) => (/^[0-9a-f-]{36}$/i.test(id) ? getProposal(await requireUser(), id) : null));

export async function generateMetadata({ params }: PageProps<"/proposals/[id]">) {
  const d = await loadProposal((await params).id);
  return { title: d ? `${d.deal.name} v${d.proposal.version} · Pro forma` : "Pro forma" };
}

export default async function ProposalPage({ params }: PageProps<"/proposals/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await loadProposal(id);
  if (!d) {
    // Approval notifications link every proposal kind to /proposals/<id>.
    if ((await proposalKindOf(user, id)) === "coalition_term_sheet") redirect(`/proposals/term-sheets/${id}`);
    notFound();
  }
  const locked = isLocked(d.proposal.status);
  const readOnly = locked || !d.perms.canEdit;

  return (
    <div>
      <Link href="/proposals" className="mb-2 inline-block text-sm text-secondary hover:text-fg">
        ← Proposals
      </Link>
      <PageHeader
        title={`${d.deal.name} · v${d.proposal.version}`}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <ProposalStatusBadge status={d.proposal.status} />
            <span>
              {d.deal.pipelineKey} · created {fmtDate(d.proposal.createdAt)}
            </span>
            {locked ? <span>Locked. Create a new version to change inputs.</span> : null}
          </span>
        }
        actions={
          <ProposalActions
            id={d.proposal.id}
            status={d.proposal.status}
            exportable={d.exportable}
            canEdit={d.perms.canEdit}
            canCreate={d.perms.canCreate}
            canApprove={d.perms.canApprove}
          />
        }
      />
      {d.proposal.status === "draft" && d.proposal.approvalReason?.startsWith("Rejected") ? (
        <div className="mb-4">
          <StatusBadge status="critical" label={d.proposal.approvalReason} />
        </div>
      ) : null}

      <ProFormaBuilder key={d.proposal.id} mode="edit" dealId={d.deal.id} proposalId={d.proposal.id} initial={d.inputs} readOnly={readOnly} rules={d.rules} />

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Versions</CardTitle>
          </CardHeader>
          <CardContent>
            <VersionDiff versions={d.versions} currentId={d.proposal.id} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Approval history</CardTitle>
          </CardHeader>
          <CardContent>
            {d.approvals.length === 0 ? (
              <p className="text-sm text-muted">No approvals requested for this deal&apos;s proposals.</p>
            ) : (
              <ul className="space-y-3 text-sm">
                {d.approvals.map((a) => {
                  const v = d.versions.find((x) => x.id === a.entityId);
                  return (
                    <li key={a.id} className="border-b border-border pb-3 last:border-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="text-fg">v{v?.version ?? "?"}</span>
                        {a.status === "approved" ? (
                          <StatusBadge status="good" label="Approved" />
                        ) : a.status === "rejected" ? (
                          <StatusBadge status="critical" label="Rejected" />
                        ) : (
                          <StatusBadge status="warning" label="Pending" />
                        )}
                        <span className="text-xs text-muted">
                          requested by {a.requestedByName ?? "—"} · {fmtDate(a.createdAt)}
                          {a.decidedAt ? ` · decided ${fmtDate(a.decidedAt)}` : ""}
                        </span>
                      </p>
                      {a.reasons.length ? <p className="mt-1 text-xs text-secondary">{a.reasons.join("; ")}</p> : null}
                      {a.note ? <p className="mt-1 text-xs text-muted">“{a.note}”</p> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
