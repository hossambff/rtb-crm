import Link from "next/link";
import { Download } from "lucide-react";
import { requireUser } from "@/lib/rbac/server";
import { getCommissionsOverview, getRegistrations } from "@/lib/commissions/queries";
import { fmtNumber, fmtUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/input";
import { EmptyState, PageHeader, Stat } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Ledger, RunAccrualsButton } from "@/components/commissions/ledger";
import { AssignmentsPanel, PlansPanel, WhatIf } from "@/components/commissions/plans";
import { ApprovalQueue, RegisterLead, RegistrationList } from "@/components/commissions/registrations";

export const metadata = { title: "Commissions" };

const TABS = ["ledger", "statements", "plans", "assignments", "registrations"] as const;

export default async function CommissionsPage({ searchParams }: PageProps<"/commissions">) {
  const user = await requireUser();
  const sp = await searchParams;
  const period = typeof sp.period === "string" && /^\d{4}-\d{2}$/.test(sp.period) ? sp.period : undefined;
  const tab = typeof sp.tab === "string" && (TABS as readonly string[]).includes(sp.tab) ? sp.tab : "ledger";
  const [data, regs] = await Promise.all([getCommissionsOverview(user, { period }), getRegistrations(user)]);
  const { perms } = data;
  if (perms.view === "none") return <EmptyState title="No access" description="Your role can't view commissions." />;
  const repPortal = perms.view === "own";
  const usd = (c: number) => fmtUsd(c, { cents: true });

  return (
    <div>
      <PageHeader
        title="Commissions"
        description={repPortal ? "Your accruals, statements and registered leads." : "Plans, accruals, statements, payouts and lead registrations."}
        actions={
          <>
            <Button asChild>
              <a href={`/commissions/export${period ? `?period=${period}` : ""}`}>
                <Download /> Export CSV
              </a>
            </Button>
            {perms.canRun ? <RunAccrualsButton /> : null}
          </>
        }
      />

      <section aria-label="Totals" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={repPortal ? "Your net commission" : "Net accrued"} value={usd(data.totals.net)} hint={period ? `Period ${period}` : "All periods"} />
        <Stat label="Awaiting approval" value={usd(data.totals.accrued)} hint={data.totals.disputed ? `${usd(data.totals.disputed)} disputed` : undefined} />
        <Stat label="Approved, unpaid" value={usd(data.totals.approved)} />
        <Stat label="Paid" value={usd(data.totals.paid)} hint={data.totals.clawbacks ? `${usd(data.totals.clawbacks)} clawed back` : undefined} />
      </section>

      <form className="mb-4 flex flex-wrap items-end gap-2" action="/commissions">
        <input type="hidden" name="tab" value={tab} />
        <label className="text-xs text-secondary">
          <span className="mb-1 block">Period</span>
          <NativeSelect name="period" defaultValue={period ?? ""} className="w-40">
            <option value="">All periods</option>
            {data.periods.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            {period && !data.periods.includes(period) ? <option value={period}>{period}</option> : null}
          </NativeSelect>
        </label>
        <Button type="submit" size="md">
          Apply
        </Button>
      </form>

      <Tabs defaultValue={tab}>
        <TabsList className="overflow-x-auto">
          <TabsTrigger value="ledger">{repPortal ? "My accruals" : "Accrual ledger"}</TabsTrigger>
          <TabsTrigger value="statements">Statements</TabsTrigger>
          <TabsTrigger value="plans">Plans</TabsTrigger>
          {!repPortal ? <TabsTrigger value="assignments">Assignments</TabsTrigger> : null}
          <TabsTrigger value="registrations">Registrations{regs.queue.length ? ` (${regs.queue.length})` : ""}</TabsTrigger>
        </TabsList>

        <TabsContent value="ledger">
          <Ledger rows={data.accruals} perms={perms} currentUserId={user.id} />
        </TabsContent>

        <TabsContent value="statements">
          {data.statements.length === 0 ? (
            <EmptyState title="No statements yet" description="Statements are generated per rep per month from the accrual ledger." />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-surface-1 text-left text-xs text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Period</th>
                    <th className="px-3 py-2 font-medium">Rep</th>
                    <th className="px-3 py-2 text-right font-medium">Lines</th>
                    <th className="px-3 py-2 text-right font-medium">Gross</th>
                    <th className="px-3 py-2 text-right font-medium">Clawbacks</th>
                    <th className="px-3 py-2 text-right font-medium">Net</th>
                    <th className="px-3 py-2 text-right font-medium">Paid</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {data.statements.map((st) => (
                    <tr key={`${st.userId}-${st.period}`} className="border-t border-border">
                      <td className="px-3 py-2 tabular">{st.period}</td>
                      <td className="px-3 py-2 text-fg">{st.userName}</td>
                      <td className="px-3 py-2 text-right tabular">{fmtNumber(st.count)}</td>
                      <td className="px-3 py-2 text-right tabular">{usd(st.totals.gross)}</td>
                      <td className="px-3 py-2 text-right tabular text-secondary">{st.totals.clawbacks ? usd(st.totals.clawbacks) : "—"}</td>
                      <td className="px-3 py-2 text-right font-medium text-fg tabular">{usd(st.totals.net)}</td>
                      <td className="px-3 py-2 text-right tabular">{usd(st.totals.paid)}</td>
                      <td className="px-3 py-2 text-right">
                        <Link href={`/commissions/statement?user=${encodeURIComponent(st.userId)}&period=${st.period}`} className="text-xs text-fg underline-offset-2 hover:underline">
                          Open statement
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="plans" className="space-y-4">
          <PlansPanel plans={data.plans} canConfigure={perms.canConfigure} />
          <WhatIf plans={data.plans.filter((p) => p.active)} />
        </TabsContent>

        {!repPortal ? (
          <TabsContent value="assignments">
            <AssignmentsPanel assignments={data.assignments} plans={data.plans} users={data.users} canConfigure={perms.canConfigure} />
          </TabsContent>
        ) : null}

        <TabsContent value="registrations" className="space-y-6">
          <RegisterLead protectDays={regs.protectDays} />
          {regs.canDecide ? (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Waiting for your decision</CardTitle>
                  <CardDescription>Approving protects ownership for {regs.protectDays} days and assigns unowned accounts to the rep.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <ApprovalQueue rows={regs.queue} />
              </CardContent>
            </Card>
          ) : null}
          <div>
            <h2 className="mb-2 font-display text-lg text-fg">{regs.canDecide ? "All registrations" : "My registrations"}</h2>
            <RegistrationList rows={regs.canDecide ? regs.all : regs.mine} empty="Registered accounts and their protection windows show here." />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
