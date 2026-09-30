import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";
import { RunProgress } from "@/components/scout/run-progress";
import { StagedContacts } from "@/components/scout/staged-contacts";
import { fmtDate } from "@/lib/format";
import { requireUser, scopeFor } from "@/lib/rbac/server";
import { SCOPE_RANK } from "@/lib/rbac/model";
import { getRunDetail, MANAGER_ROLES } from "@/lib/scout/queries";

export const metadata = { title: "Scout run" };
export const maxDuration = 300;

export default async function RunPage(props: PageProps<"/scout/runs/[id]">) {
  const user = await requireUser();
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await getRunDetail(user, id);
  if (!d) notFound();
  const { run } = d;
  const restricted = d.account?.restricted === true;
  const title = run.kind === "enrich" ? `Find executives — ${restricted ? "Restricted account" : (d.account?.name ?? "Account")}` : `Scout run — ${d.searchName ?? "Search"}`;
  const isOwnerOrManager = run.requestedBy === user.id || MANAGER_ROLES.includes(user.role);
  const canReview = isOwnerOrManager && SCOPE_RANK[await scopeFor(user, "contacts", "create")] > 0;
  const running = run.status === "queued" || run.status === "running";
  return (
    <>
      <PageHeader
        title={title}
        description={`Requested by ${d.requester ?? "system"} · ${fmtDate(run.createdAt, "d MMM yyyy, HH:mm")}${run.kind === "enrich" && run.targetRoles.length ? ` · roles: ${run.targetRoles.join(", ")}` : ""}`}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={run.kind === "enrich" ? "/scout?tab=runs" : "/scout?tab=queue"}>
              <ArrowLeft aria-hidden /> Back
            </Link>
          </Button>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <RunProgress
              runId={run.id}
              canResume={isOwnerOrManager}
              initial={{ status: run.status, costCents: run.costCents, estimatedCostCents: run.estimatedCostCents, resultsCount: run.resultsCount, verifiedCount: run.verifiedCount, error: run.error, steps: d.steps }}
            />
          </CardContent>
        </Card>
        <div>
          {run.kind === "enrich" ? (
            <>
              <h2 className="mb-3 font-display text-lg text-fg">Staged contacts</h2>
              <StagedContacts
                running={running}
                canReview={canReview && !restricted}
                rows={d.staged.map((e) => ({
                  id: e.id,
                  fullName: e.fullName,
                  title: e.title,
                  linkedinUrl: e.linkedinUrl,
                  email: e.email,
                  emailSource: e.emailSource,
                  verification: e.verification,
                  confidence: e.confidence,
                  sourceActor: e.sourceActor,
                  state: e.state,
                  promotedContactId: e.promotedContactId,
                }))}
              />
            </>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Results</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-secondary">
                <p>
                  {running ? "Candidates are added to the review queue when scoring finishes." : `${run.resultsCount} new candidate${run.resultsCount === 1 ? "" : "s"} added to the review queue.`}
                </p>
                {run.searchId ? (
                  <Button asChild variant="secondary" size="sm">
                    <Link href={`/scout?tab=queue&search=${run.searchId}`}>Open review queue</Link>
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
