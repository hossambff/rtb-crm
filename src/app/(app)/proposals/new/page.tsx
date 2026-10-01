import Link from "next/link";
import { can, requireUser } from "@/lib/rbac/server";
import { prefillFromDeal, proposalDeal, proposalDealOptions } from "@/lib/proposals/queries";
import { approvalRules } from "@/lib/proposals/access";
import { emptyInputs, normalizeInputs } from "@/lib/proposals/calc";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { ProFormaBuilder } from "@/components/proposals/builder";

export const metadata = { title: "New pro forma" };

export default async function NewProposalPage({ searchParams }: PageProps<"/proposals/new">) {
  const user = await requireUser();
  if (!(await can(user, "proposals", "create"))) return <EmptyState title="No access" description="Your role can't create proposals." />;
  const sp = await searchParams;
  const dealId = typeof sp.dealId === "string" && /^[0-9a-f-]{36}$/i.test(sp.dealId) ? sp.dealId : undefined;
  const includeAll = sp.all === "1";
  const deal = dealId ? await proposalDeal(user, dealId) : null;

  if (!deal) {
    const deals = await proposalDealOptions(user, includeAll);
    return (
      <div>
        <PageHeader
          title="New pro forma"
          description="Pick the Enterprise deal this pro forma is for."
          actions={
            <Button asChild variant="ghost">
              <Link href={includeAll ? "/proposals/new" : "/proposals/new?all=1"}>{includeAll ? "Enterprise deals only" : "Include NetDev & Sports deals"}</Link>
            </Button>
          }
        />
        {dealId ? <p className="mb-4 text-sm text-muted">That deal isn&apos;t available to you. Pick another.</p> : null}
        {deals.length === 0 ? (
          <EmptyState title="No eligible deals" description={includeAll ? "You need access to an Enterprise, NetDev or Sports deal to build a pro forma." : "No Enterprise deals are visible to you. Include NetDev & Sports deals to pick one of those."} />
        ) : (
          <form action="/proposals/new" className="flex max-w-xl flex-wrap items-end gap-2">
            {includeAll ? <input type="hidden" name="all" value="1" /> : null}
            <label className="min-w-0 flex-1 text-xs text-secondary">
              <span className="mb-1 block">Deal</span>
              <NativeSelect name="dealId" required defaultValue="">
                <option value="" disabled>
                  Select a deal…
                </option>
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.pipelineKey} · {d.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <Button type="submit" variant="primary">
              Continue
            </Button>
          </form>
        )}
      </div>
    );
  }

  const [prefill, rules] = await Promise.all([prefillFromDeal(user, deal.id), approvalRules()]);
  const initial = normalizeInputs({ ...emptyInputs(), ...prefill.inputs });
  return (
    <div>
      <PageHeader
        title={`New pro forma · ${deal.name}`}
        description="Lead with cost, not revenue: same revenue, less cost, EBITDA multiple before any growth."
        actions={
          <Button asChild variant="ghost">
            <Link href="/proposals/new">Change deal</Link>
          </Button>
        }
      />
      <ProFormaBuilder mode="create" dealId={deal.id} initial={initial} rules={rules} prefilled={prefill.filled} />
    </div>
  );
}
