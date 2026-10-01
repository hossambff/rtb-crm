import { can, requireUser } from "@/lib/rbac/server";
import { getRevenueData } from "@/lib/revenue/queries";
import { fmtDate, fmtNumber, fmtPct, fmtUsd } from "@/lib/format";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader, Stat } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgingChart, ConcentrationChart } from "@/components/revenue/charts";
import { CollectionsBoard, InvoicesTable, NewInvoiceButton } from "@/components/revenue/invoices";
import { BillingTable } from "@/components/revenue/billing";

export const metadata = { title: "Revenue" };

const usd = (c: number) => fmtUsd(c, { cents: true, compact: true });

export default async function RevenuePage({ searchParams }: PageProps<"/revenue">) {
  const user = await requireUser();
  const sp = await searchParams;
  const invoiceParam = typeof sp.invoice === "string" ? sp.invoice : null;
  if (!(await can(user, "revenue", "view"))) return <EmptyState title="No access" description="Your role can't view revenue and invoices." />;
  const d = await getRevenueData(user);
  const { summary: s } = d;

  return (
    <div>
      <PageHeader
        title="Revenue"
        description="TheStreet sponsorships: deals closing, client revenue, invoices, collections and renewals."
        actions={d.perms.canCreate ? <NewInvoiceButton deals={d.invoiceDeals} /> : null}
      />

      <section aria-label="Executive summary" className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Stat label="Active deals closing" value={usd(s.activeClosing.cents)} hint={`${fmtNumber(s.activeClosing.count)} deals · negotiation, verbal or LOI`} />
        <Stat label="Current-client annualized" value={usd(s.currentAnnualized.cents)} hint={`${fmtNumber(s.currentAnnualized.count)} current clients`} />
        <Stat
          label="Upcoming collections · 60d"
          value={usd(s.upcomingCollections.cents)}
          hint={
            s.overdue.count ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {collectionsHint(s.upcomingCollections)} ·
                <StatusBadge status="critical" label={`${usd(s.overdue.cents)} overdue`} />
              </span>
            ) : (
              collectionsHint(s.upcomingCollections)
            )
          }
        />
        <Stat label="Warm deals in negotiation" value={usd(s.warmNegotiation.cents)} hint={`${fmtNumber(s.warmNegotiation.count)} deals · warm stage`} />
      </section>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>AR aging</CardTitle>
              <CardDescription>Overdue receivables by days past due.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {d.aging.some((a) => a.count > 0) ? <AgingChart data={d.aging} /> : <p className="py-10 text-center text-sm text-muted">No overdue invoices.</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Customer concentration</CardTitle>
              <CardDescription>
                {d.concentration.total > 0
                  ? `Largest client is ${fmtPct(d.concentration.topShare)} of ${usd(d.concentration.total)} annualized.`
                  : "Share of annualized client revenue by account."}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {d.concentration.rows.length ? <ConcentrationChart data={d.concentration.rows} /> : <p className="py-10 text-center text-sm text-muted">No client revenue yet.</p>}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="invoices">
        <TabsList>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="collections">Collections</TabsTrigger>
          <TabsTrigger value="renewals">Renewals{d.renewals.length ? ` (${d.renewals.length})` : ""}</TabsTrigger>
          <TabsTrigger value="deals">Deals & billing</TabsTrigger>
        </TabsList>
        <TabsContent value="invoices">
          <InvoicesTable invoices={d.invoices} perms={d.perms} deals={d.invoiceDeals} highlightId={invoiceParam} />
        </TabsContent>
        <TabsContent value="collections">
          <CollectionsBoard invoices={d.invoices} perms={d.perms} />
        </TabsContent>
        <TabsContent value="renewals">
          {d.renewals.length === 0 ? (
            <EmptyState title="No renewals in the next 60 days" description="Deals with a renewal or end date within 60 days show here, flagged at 60, 30 and 14 days." />
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {d.renewals.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium text-fg">{r.name}</p>
                    <p className="text-xs text-muted">
                      {r.accountName ?? "—"} · {r.ownerName ?? "Unassigned"}
                    </p>
                  </div>
                  <span className="text-sm tabular text-secondary">{usd(r.annualizedValueCents ?? 0)}/yr</span>
                  <span className="text-sm tabular text-secondary">{fmtDate(r.renewalAt)}</span>
                  {r.window === 14 ? (
                    <StatusBadge status="critical" label={`${r.days}d · 14-day window`} />
                  ) : r.window === 30 ? (
                    <StatusBadge status="serious" label={`${r.days}d · 30-day window`} />
                  ) : (
                    <Badge>{r.days}d · 60-day window</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
        <TabsContent value="deals">
          <BillingTable deals={d.deals} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** "3 invoices + 4 scheduled payments" — scheduled = current clients' next payment with no invoice yet (QA-08). */
function collectionsHint(u: { count: number; fromDealSchedule: number }) {
  const inv = u.count - u.fromDealSchedule;
  const parts = [];
  if (inv || !u.fromDealSchedule) parts.push(`${fmtNumber(inv)} invoice${inv === 1 ? "" : "s"} due`);
  if (u.fromDealSchedule) parts.push(`${fmtNumber(u.fromDealSchedule)} scheduled client payment${u.fromDealSchedule === 1 ? "" : "s"}`);
  return parts.join(" + ");
}
