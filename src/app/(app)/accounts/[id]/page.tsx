import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, ExternalLink, Lock, Mail, Phone, UserX } from "lucide-react";
import { Badge, ColorTick } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, EmptyState, Skeleton } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccountActionsSlot } from "@/components/accounts/account-actions-slot";
import { ActivityTimeline } from "@/components/accounts/activity-timeline";
import { AddMetricForm } from "@/components/accounts/add-metric-form";
import { AudienceChart, type AudiencePoint } from "@/components/accounts/audience-chart";
import { EditAccountDialog } from "@/components/accounts/edit-account-dialog";
import { MergeAccountDialog } from "@/components/accounts/merge-account-dialog";
import { ConfidenceBadge, MuuValue } from "@/components/accounts/muu-value";
import { ContactFormDialog } from "@/components/contacts/contact-form-dialog";
import { AccountCollisionNotice } from "@/components/deals/touches/collision-notice";
import { WhoIsTalking } from "@/components/deals/touches/who-is-talking";
import { AccountEnrollButton } from "@/components/sequences/deal-sequences";
import { accountFilterOptions, getAccount360, getVisibleAccount, type Account360 } from "@/lib/accounts/queries";
import { ownerFilterOptions } from "@/lib/users";
import { ACCOUNT_TYPES, LIFECYCLES, PRIORITIES, R100_TYPES, labelOf } from "@/lib/accounts/constants";
import { seniorityLabel } from "@/lib/contacts/seniority";
import { dealValue } from "@/lib/pipeline-math";
import { fmtDate, fmtNumber, fmtPct, fmtRelative, fmtUsd } from "@/lib/format";
import { PIPELINE_COLORS } from "@/lib/palette";
import { can, requireUser } from "@/lib/rbac/server";

export async function generateMetadata(props: PageProps<"/accounts/[id]">) {
  const user = await requireUser();
  if (!(await can(user, "accounts", "view"))) return { title: "Account" };
  const a = await getVisibleAccount(user, (await props.params).id);
  return { title: a?.name ?? "Account" };
}

export default async function AccountPage(props: PageProps<"/accounts/[id]">) {
  const user = await requireUser();
  const { id } = await props.params;
  if (!(await can(user, "accounts", "view"))) notFound();
  const data = await getAccount360(user, id);
  if (!data) notFound();
  const [opts, ownerOpts, canAssign, canCreateContact] = await Promise.all([accountFilterOptions(), ownerFilterOptions(), can(user, "accounts", "assign"), can(user, "contacts", "create")]);
  const { account: a } = data;
  const owners = ownerOpts.map((o) => ({ id: o.id, name: o.name }));

  const deals = data.deals.map((d) => ({
    ...d,
    value: dealValue({
      unit: d.unit,
      muu: d.muu,
      pipelineUsdPerMuu: d.usdPerMuu,
      contractValueCents: d.contractValueCents,
      annualizedValueCents: d.annualizedValueCents,
      stageProbability: d.stageProbability,
      probabilityOverride: d.probabilityOverride,
      overrideStatus: d.overrideStatus,
    }),
  }));
  const open = deals.filter((d) => d.status === "open");
  const weighted = open.reduce((s, d) => s + d.value.weightedGrossUsd, 0);
  const childMuu = data.children.reduce((s, c) => s + (c.muu ?? 0), 0);
  const nowMs = new Date().getTime();

  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 text-xs text-muted">
        <Link href="/accounts" className="hover:text-fg">
          Accounts
        </Link>
        <ChevronRight className="size-3" aria-hidden />
        {data.parent ? (
          <>
            <Link href={`/accounts/${data.parent.id}`} className="hover:text-fg">
              {data.parent.name}
            </Link>
            <ChevronRight className="size-3" aria-hidden />
          </>
        ) : null}
        <span className="text-secondary">{a.name}</span>
      </nav>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-display text-[28px] font-medium leading-9 text-fg">{a.name}</h1>
            {a.restricted ? (
              <span title="Restricted (MNPI) — visible to the access list only" className="inline-flex items-center gap-1 rounded border border-border-strong px-1.5 py-0.5 text-[11px] text-secondary">
                <Lock className="size-3" /> Restricted
              </span>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            {a.domain ? (
              <a href={`https://${a.domain}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-secondary hover:text-fg">
                {a.domain} <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : (
              <span className="text-muted">No domain</span>
            )}
            <Badge>{labelOf(ACCOUNT_TYPES, a.type)}</Badge>
            {a.category ? <Badge>{a.category}</Badge> : null}
            <Badge>{labelOf(LIFECYCLES, a.lifecycle)}</Badge>
            {a.priority ? <Badge>{labelOf(PRIORITIES, a.priority)}</Badge> : null}
            {a.doNotContact ? (
              <Badge>
                <UserX className="size-3" /> Do not contact
              </Badge>
            ) : null}
            {data.parent ? (
              <span className="text-xs text-muted">
                Part of{" "}
                <Link href={`/accounts/${data.parent.id}`} className="text-secondary underline-offset-4 hover:underline">
                  {data.parent.name}
                </Link>
              </span>
            ) : null}
          </div>
          <div className="mt-2 empty:hidden">
            <Suspense fallback={null}>
              <AccountCollisionNotice user={user} accountId={a.id} />
            </Suspense>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AccountActionsSlot
            account={{ id: a.id, name: a.name, domain: a.domain, type: a.type, ownerId: a.ownerId, restricted: a.restricted }}
            canEdit={data.canEdit}
            openPipelineKeys={open.map((d) => d.pipelineKey)}
          />
          <Suspense fallback={null}>
            <AccountEnrollButton accountId={a.id} />
          </Suspense>
          {data.canEdit ? <MergeAccountDialog account={{ id: a.id, name: a.name }} /> : null}
          {data.canEdit ? (
            <EditAccountDialog
              owners={owners}
              categories={opts.categories}
              canAssign={canAssign}
              account={{ ...a, parentName: data.parent?.name ?? null, techStack: a.techStack ?? [] }}
            />
          ) : null}
        </div>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Kpi label="MUU">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <MuuValue value={a.muu} confidence={a.muuConfidence} source={a.muuSource} className="font-display text-[26px] leading-9" />
            <ConfidenceBadge confidence={a.muuConfidence} />
          </div>
          <p className="mt-1 truncate text-xs text-muted" title={a.muuSource ?? undefined}>
            {a.muuSource ?? "No audience data"}
            {a.monthlyVisits ? ` · ${fmtNumber(a.monthlyVisits, { compact: true })} visits` : ""}
          </p>
        </Kpi>
        <Kpi label="Open deals">
          <p className="font-display text-[26px] leading-9 text-fg tabular">{open.length}</p>
          <p className="mt-1 text-xs text-muted">{deals.length - open.length} closed / held</p>
        </Kpi>
        <Kpi label="Weighted pipeline (gross)">
          <p className="font-display text-[26px] leading-9 text-fg tabular">{fmtUsd(weighted, { compact: true })}</p>
          <p className="mt-1 text-xs text-muted">MUU × $/MUU × probability</p>
        </Kpi>
        <Kpi label="Owner">
          <div className="mt-1 flex items-center gap-2">
            <Avatar name={data.owner?.name ?? "—"} size={26} />
            <span className="truncate text-sm text-fg">{data.owner?.name ?? "Unassigned"}</span>
          </div>
          <p className="mt-2 text-xs text-muted">Updated {fmtRelative(a.updatedAt)}</p>
        </Kpi>
        <Kpi label="Group roll-up">
          {data.children.length ? (
            <>
              <p className="font-display text-[26px] leading-9 text-fg tabular">{fmtNumber(childMuu + (a.muu ?? 0), { compact: true })}</p>
              <p className="mt-1 text-xs text-muted">
                {data.children.length} brand{data.children.length === 1 ? "" : "s"} · {data.childDeals.reduce((s, d) => s + d.n, 0)} open deals
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-muted">No child brands</p>
          )}
        </Kpi>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger className="whitespace-nowrap" value="overview">Overview</TabsTrigger>
          <TabsTrigger className="whitespace-nowrap" value="audience">Audience</TabsTrigger>
          <TabsTrigger className="whitespace-nowrap" value="contacts">Contacts ({data.contacts.length})</TabsTrigger>
          <TabsTrigger className="whitespace-nowrap" value="activity">Activity</TabsTrigger>
          <TabsTrigger className="whitespace-nowrap" value="documents">Documents ({data.documents.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle>Deals across motions</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {deals.length ? <DealsTable deals={deals} nowMs={nowMs} /> : <div className="p-5"><EmptyState title="No deals" description="This account isn't in any pipeline you can see yet." /></div>}
            </CardContent>
          </Card>
          <div className="space-y-4">
            {R100_TYPES.includes(a.type) || a.ticker ? <CompanyCard a={a} /> : null}
            {data.children.length ? (
              <Card>
                <CardHeader>
                  <CardTitle>Child brands</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2 text-sm">
                    {data.children.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2">
                        <Link href={`/accounts/${c.id}`} className="truncate text-fg hover:underline">
                          {c.name}
                        </Link>
                        <MuuValue value={c.muu} confidence={c.muuConfidence} />
                      </li>
                    ))}
                  </ul>
                  {data.childDeals.length ? (
                    <p className="mt-3 flex flex-wrap gap-3 border-t border-border pt-3 text-xs text-muted">
                      {data.childDeals.map((d) => (
                        <span key={d.pipelineKey} className="inline-flex items-center gap-1">
                          <ColorTick color={PIPELINE_COLORS[d.pipelineKey] ?? "#828282"} /> {d.pipelineKey} {d.n} · {fmtNumber(Number(d.muu), { compact: true })} MUU
                        </span>
                      ))}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}
            <Card>
              <CardHeader>
                <CardTitle>Key contacts</CardTitle>
              </CardHeader>
              <CardContent>
                {data.contacts.length ? (
                  <ul className="space-y-2.5">
                    {data.contacts.slice(0, 6).map((c) => (
                      <li key={c.id} className="flex items-center gap-2.5">
                        <Avatar name={c.fullName} size={26} />
                        <div className="min-w-0">
                          <Link href={`/contacts/${c.id}`} className="block truncate text-sm text-fg hover:underline">
                            {c.fullName}
                          </Link>
                          <p className="truncate text-xs text-muted">{c.title ?? c.email ?? "—"}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted">No contacts yet.</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Latest activity</CardTitle>
              </CardHeader>
              <CardContent>
                <ActivityTimeline items={data.activities.slice(0, 5)} />
              </CardContent>
            </Card>
            <Suspense fallback={<Skeleton className="h-32" />}>
              <WhoIsTalking user={user} accountId={a.id} />
            </Suspense>
            {data.migrations.length ? (
              <Card>
                <CardHeader>
                  <CardTitle>Onboarding</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {data.migrations.map((m) => (
                    <div key={m.id} className="flex items-center justify-between gap-2">
                      <span className="truncate text-fg">{m.name}</span>
                      <Badge>{m.launched ? "Launched" : m.stage.replace(/_/g, " ")}</Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent value="audience" className="space-y-4">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Audience history</CardTitle>
                <p className="mt-1 text-xs text-muted">MUU and monthly visits are different measures — visits overstate unique users. Estimates are dashed / italic.</p>
              </div>
            </CardHeader>
            <CardContent>{data.metrics.length ? <AudienceChart data={audiencePoints(data.metrics)} /> : <EmptyState title="No audience data" description="Add a metric below (MUU, visits or pageviews) with its source." />}</CardContent>
          </Card>
          {data.metrics.length ? (
            <Card>
              <CardContent className="overflow-x-auto p-0">
                <table className="table-cards w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                      <th className="h-9 px-4 font-medium">Period</th>
                      <th className="px-4 font-medium">Metric</th>
                      <th className="px-4 text-right font-medium">Value</th>
                      <th className="px-4 font-medium">Raw</th>
                      <th className="px-4 font-medium">Source</th>
                      <th className="px-4 font-medium">Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.metrics].reverse().map((m) => (
                      <tr key={m.id} className="border-b border-border last:border-0">
                        <td data-label="Period" data-primary className="h-9 px-4 text-secondary tabular">{m.period ?? "—"}</td>
                        <td data-label="Metric" className="px-4 text-body">{m.metric === "muu" ? "MUU" : m.metric === "visits" ? "Visits" : "Pageviews"}</td>
                        <td data-label="Value" className="px-4 text-right tabular text-fg">
                          {fmtNumber(m.value)}
                          {m.derivedMuu ? <span className="block text-[11px] italic text-muted">≈ {fmtNumber(m.derivedMuu, { compact: true })} MUU (÷{m.factorUsed})</span> : null}
                        </td>
                        <td data-label="Raw" className="px-4 text-muted">{m.rawValue ?? "—"}</td>
                        <td data-label="Source" className="px-4 text-secondary">{m.source}</td>
                        <td data-label="Confidence" className="px-4">
                          <ConfidenceBadge confidence={m.confidence} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ) : null}
          {data.canEdit ? (
            <Card>
              <CardHeader>
                <CardTitle>Add audience metric</CardTitle>
              </CardHeader>
              <CardContent>
                <AddMetricForm accountId={a.id} />
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="contacts">
          <div className="mb-3 flex justify-end">
            {canCreateContact ? <ContactFormDialog trigger="create-small" owners={owners} initial={{ account: { id: a.id, name: a.name } }} /> : null}
          </div>
          {data.contacts.length ? (
            <div className="overflow-x-auto rounded-lg border border-border bg-surface-1">
              <table className="table-cards w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                    <th className="h-9 px-3 font-medium">Name</th>
                    <th className="px-3 font-medium">Title</th>
                    <th className="px-3 font-medium">Email</th>
                    <th className="px-3 font-medium">Relationship owner</th>
                    <th className="px-3 font-medium">Status</th>
                    <th className="px-3 font-medium">Last contacted</th>
                  </tr>
                </thead>
                <tbody>
                  {data.contacts.map((c) => (
                    <tr key={c.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                      <td data-label="Name" data-primary className="h-10 px-3">
                        <Link href={`/contacts/${c.id}`} className="font-medium text-fg hover:underline">
                          {c.fullName}
                        </Link>
                      </td>
                      <td data-label="Title" className="px-3 text-secondary">
                        {c.title ?? "—"}
                        {c.seniority ? <span className="block text-[11px] text-muted">{seniorityLabel(c.seniority)}</span> : null}
                      </td>
                      <td data-label="Email" className="px-3">
                        {c.email ? (
                          <a href={`mailto:${c.email}`} className="inline-flex min-w-0 items-center gap-1 break-all text-secondary hover:text-fg md:break-normal">
                            <Mail className="size-3" aria-hidden /> {c.email}
                          </a>
                        ) : c.phone ? (
                          <span className="inline-flex items-center gap-1 text-secondary">
                            <Phone className="size-3" aria-hidden /> {c.phone}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td data-label="Relationship owner" className="px-3 text-secondary">{c.relationshipOwner ?? "—"}</td>
                      <td data-label="Status" className="px-3">
                        <span className="inline-flex gap-1">
                          <Badge>{c.status === "left_company" ? "Left company" : "Active"}</Badge>
                          {c.doNotContact ? <Badge>DNC</Badge> : null}
                        </span>
                      </td>
                      <td data-label="Last contacted" className="px-3 text-xs text-muted">{fmtRelative(c.lastContactedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No contacts" description="Add the people you work with at this account." />
          )}
        </TabsContent>

        <TabsContent value="activity">
          <Card>
            <CardContent className="pt-5">
              <ActivityTimeline items={data.activities} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="documents">
          {data.documents.length ? (
            <div className="overflow-x-auto rounded-lg border border-border bg-surface-1">
              <table className="table-cards w-full min-w-[600px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                    <th className="h-9 px-3 font-medium">Document</th>
                    <th className="px-3 font-medium">Type</th>
                    <th className="px-3 font-medium">Status</th>
                    <th className="px-3 font-medium">Version</th>
                    <th className="px-3 font-medium">Signed</th>
                    <th className="px-3 font-medium">Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {data.documents.map((d) => (
                    <tr key={d.id} className="border-b border-border last:border-0">
                      <td data-label="Document" data-primary className="h-10 px-3">
                        {d.url ? (
                          <a href={d.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-fg hover:underline">
                            {d.name} <ExternalLink className="size-3" aria-hidden />
                          </a>
                        ) : (
                          <span className="text-fg">{d.name}</span>
                        )}
                      </td>
                      <td data-label="Type" className="px-3 uppercase text-secondary">{d.type.replace(/_/g, " ")}</td>
                      <td data-label="Status" className="px-3">
                        <Badge>{d.status}</Badge>
                      </td>
                      <td data-label="Version" className="px-3 tabular text-secondary">v{d.version}</td>
                      <td data-label="Signed" className="px-3 text-secondary">{fmtDate(d.signedAt)}</td>
                      <td data-label="Expires" className="px-3 text-secondary">{fmtDate(d.expiresAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No documents" description="NDAs, contracts, proposals and decks attached to this account or its deals appear here." />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Kpi({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface-1 px-4 py-3">
      <p className="truncate text-[11px] font-medium uppercase tracking-wide text-muted" title={label}>
        {label}
      </p>
      <div className="mt-1.5 min-w-0">{children}</div>
    </div>
  );
}

type DealRow = Account360["deals"][number] & { value: ReturnType<typeof dealValue> };

function DealsTable({ deals, nowMs }: { deals: DealRow[]; nowMs: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="table-cards w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="h-9 px-4 font-medium">Pipeline</th>
            <th className="px-4 font-medium">Deal</th>
            <th className="px-4 font-medium">Stage</th>
            <th className="px-4 text-right font-medium">Value</th>
            <th className="px-4 text-right font-medium">Prob.</th>
            <th className="px-4 font-medium">Next step</th>
          </tr>
        </thead>
        <tbody>
          {deals.map((d) => {
            const overdue = d.status === "open" && d.nextStepDueAt && d.nextStepDueAt.getTime() < nowMs;
            return (
              <tr key={d.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                <td data-label="Pipeline" className="h-11 px-4">
                  <span className="inline-flex items-center gap-1.5 text-xs text-secondary" title={d.pipelineName}>
                    <ColorTick color={d.pipelineColor || PIPELINE_COLORS[d.pipelineKey] || "#828282"} />
                    {d.pipelineKey}
                  </span>
                </td>
                <td data-label="Deal" data-primary className="md:max-w-[220px] px-4">
                  <Link href={`/deals/${d.id}`} className="block min-w-0 truncate text-fg hover:underline">
                    {d.name}
                  </Link>
                  <span className="text-[11px] text-muted">{d.ownerName ?? "Unassigned"}</span>
                </td>
                <td data-label="Stage" className="px-4">
                  <Badge>{d.stageName}</Badge>
                  {d.restricted ? <Lock className="ml-1 inline size-3 text-muted" aria-label="Restricted" /> : null}
                </td>
                <td data-label="Value" className="px-4 text-right tabular">
                  {d.unit === "muu" ? (
                    <>
                      <span className="text-fg">{fmtNumber(d.value.muu, { compact: true })} MUU</span>
                      <span className="block text-[11px] text-muted">{fmtUsd(d.value.grossUsd, { compact: true })} gross</span>
                    </>
                  ) : d.unit === "usd" ? (
                    <span className="text-fg">{fmtUsd(d.value.grossUsd, { compact: true })}</span>
                  ) : (
                    <span className="text-secondary">{d.r100?.postCount ? `${d.r100.postCount} posts` : "activation"}</span>
                  )}
                </td>
                <td data-label="Prob." className="px-4 text-right tabular text-secondary">
                  {fmtPct(d.value.probability)}
                  {d.probabilityOverride != null ? <span className="block text-[10px] text-muted">{d.overrideStatus === "pending" ? "override pending" : "override"}</span> : null}
                </td>
                <td data-label="Next step" className="md:max-w-[260px] px-4">
                  <span className="block min-w-0 truncate text-secondary" title={d.nextStep ?? undefined}>
                    {d.nextStep ?? "—"}
                  </span>
                  {d.nextStepDueAt ? <span className={`text-[11px] ${overdue ? "text-critical" : "text-muted"}`}>{overdue ? "Overdue · " : "Due "}{fmtDate(d.nextStepDueAt, "d MMM")}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CompanyCard({ a }: { a: Account360["account"] }) {
  const rows: [string, React.ReactNode][] = [
    ["Ticker", a.ticker ?? "—"],
    ["Token", a.tokenName ?? "—"],
    ["B2C", a.isB2c == null ? "—" : a.isB2c ? "Yes" : "No"],
    ["Market cap", a.marketCapUsd ? fmtUsd(a.marketCapUsd, { compact: true }) : "—"],
    [
      "Press page",
      a.pressPage ? (
        <a href={a.pressPage} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-fg">
          Open <ExternalLink className="size-3" />
        </a>
      ) : (
        "—"
      ),
    ],
    ["PR email", a.prEmail ?? "—"],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Company</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-[11px] uppercase tracking-wide text-muted">{k}</dt>
              <dd className="truncate text-secondary tabular">{v}</dd>
            </div>
          ))}
        </dl>
        {a.techStack?.length ? (
          <div className="mt-3 flex flex-wrap gap-1 border-t border-border pt-3">
            {a.techStack.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function audiencePoints(metrics: Account360["metrics"]): AudiencePoint[] {
  const by = new Map<string, AudiencePoint>();
  for (const m of metrics) {
    const period = m.period ?? m.createdAt.toISOString().slice(0, 7);
    const p = by.get(period) ?? { period, muu: null, muuSource: null, muuConfidence: null, visits: null, visitsSource: null, derivedMuu: null };
    if (m.metric === "muu") Object.assign(p, { muu: m.value, muuSource: m.source, muuConfidence: m.confidence });
    if (m.metric === "visits") Object.assign(p, { visits: m.value, visitsSource: m.source, derivedMuu: m.derivedMuu });
    by.set(period, p);
  }
  return [...by.values()].sort((x, y) => x.period.localeCompare(y.period));
}
