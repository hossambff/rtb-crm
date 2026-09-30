import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader, Stat } from "@/components/ui/misc";
import { ConnectApify } from "@/components/scout/connect-apify";
import { ReviewQueue, type CandidateRow } from "@/components/scout/review-queue";
import { SearchesTable } from "@/components/scout/searches-table";
import { Funnel, RunsTable, ScoutTabNav, SCOUT_TABS, SpendBar, type ScoutTab } from "@/components/scout/scout-views";
import { ActorRegistryTable, ApifyTokenCard, ScoutSettingsForm } from "@/components/scout/settings-form";
import { usd } from "@/components/scout/bits";
import { requireUser } from "@/lib/rbac/server";
import { SCOPE_RANK } from "@/lib/rbac/model";
import { crmStatusLabel, type CrmMatch } from "@/lib/scout/core";
import { describeCriteria, type Criteria } from "@/lib/scout/criteria";
import {
  actorRegistryRows,
  apifyStatus,
  assignableUsers,
  budgetSummary,
  candidateCounts,
  listCandidates,
  listRuns,
  listSearches,
  rejectReasons,
  scoutFunnel,
  scoutPermissions,
  scoutPipelines,
  type CandidateFilter,
} from "@/lib/scout/queries";
import { getScoutSettings } from "@/lib/scout/settings";

export const metadata = { title: "Lead Scout" };
/** Server actions on this page start Apify runs via after(); give them room (PRD M25.9: ≤5 min). */
export const maxDuration = 300;

export default async function ScoutPage(props: PageProps<"/scout">) {
  const user = await requireUser();
  const perms = await scoutPermissions(user);
  if (SCOPE_RANK[perms.view] === 0 && SCOPE_RANK[perms.enrichView] === 0)
    return (
      <>
        <PageHeader title="Lead Scout" />
        <EmptyState title="No access" description="Your role doesn't include Lead Scout. Ask an admin if you need it." />
      </>
    );
  const sp = await props.searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const requested = one("tab") as ScoutTab | undefined;
  let tab: ScoutTab = SCOUT_TABS.some((t) => t.key === requested) ? requested! : "queue";
  if (tab === "settings" && !perms.configure) tab = "queue";

  const [apify, counts] = await Promise.all([apifyStatus(), candidateCounts(user)]);
  const canCreate = SCOPE_RANK[perms.create] > 0;

  return (
    <>
      <PageHeader
        title="Lead Scout"
        description="Find publishers that fit an RTB platform deal, score them by MUU and fit, and turn accepted targets into verified executive contacts."
        actions={
          canCreate ? (
            <Button asChild variant="primary" size="sm">
              <Link href="/scout/searches/new">
                <Plus aria-hidden /> New search
              </Link>
            </Button>
          ) : null
        }
      />
      {!apify.connected && tab !== "settings" ? <ConnectApify canConfigure={perms.configure} compact={tab !== "queue" && tab !== "searches"} /> : null}
      <ScoutTabNav active={tab} showSettings={perms.configure} queueCount={counts.new ?? 0} />
      {tab === "queue" ? (
        <QueueTab user={user} perms={perms} filter={{ state: one("state") as CandidateFilter["state"], searchId: one("search"), q: one("q"), minScore: one("min") ? Number(one("min")) : undefined }} apifyConnected={apify.connected} />
      ) : tab === "searches" ? (
        <SearchesTab user={user} canCreate={canCreate} />
      ) : tab === "runs" ? (
        <RunsTab user={user} />
      ) : tab === "budget" ? (
        <BudgetTab user={user} />
      ) : (
        <SettingsTab apify={apify} />
      )}
    </>
  );
}

type U = Awaited<ReturnType<typeof requireUser>>;
type P = Awaited<ReturnType<typeof scoutPermissions>>;

async function QueueTab({ user, perms, filter, apifyConnected }: { user: U; perms: P; filter: CandidateFilter; apifyConnected: boolean }) {
  const editAll = perms.edit === "all" || perms.edit === "pipeline";
  const canAssign = SCOPE_RANK[perms.assign] > 0;
  const [rows, searches, pipelines, users, reasons, settings] = await Promise.all([
    listCandidates(user, filter),
    listSearches(user),
    scoutPipelines(),
    canAssign ? assignableUsers() : Promise.resolve(null),
    rejectReasons(),
    getScoutSettings(),
  ]);
  const suggestOnly = SCOPE_RANK[perms.edit] === 0;
  const data: CandidateRow[] = rows.map(({ c, searchName, searchOwnerId }) => {
    const raw = (c.raw ?? {}) as Record<string, unknown>;
    const m = (c.crmMatch ?? null) as CrmMatch | null;
    return {
      id: c.id,
      domain: c.domain,
      name: c.name,
      category: c.category,
      country: c.country,
      estMuu: c.estMuu,
      muuSource: c.muuSource,
      muuConfidence: (raw.muuConfidence as string) ?? (c.estMuu != null ? "estimate" : "unknown"),
      monthlyVisits: c.monthlyVisits,
      trendPct: c.trendPct,
      series: Array.isArray(raw.series) ? (raw.series as number[]).slice(-6) : [],
      techStack: c.techStack,
      displaceable: Array.isArray(raw.displaceable) ? (raw.displaceable as string[]) : [],
      ownership: c.ownership,
      fitScore: c.fitScore,
      fitFactors: c.fitFactors,
      fitExplanation: c.fitExplanation,
      estValueCents: c.estValueCents,
      crmLabel: crmStatusLabel(m),
      crmStatus: m?.status ?? "new",
      accountId: m?.accountId ?? null,
      dealId: m?.dealId ?? null,
      routing: (raw.routing as string) ?? "NET",
      routingReason: (raw.routingReason as string) ?? null,
      state: c.state,
      rejectReason: c.rejectReason,
      searchName,
      source: (raw.source as string) ?? "list",
      doNotContact: raw.doNotContact === true,
      canEdit: suggestOnly ? searchOwnerId === user.id : editAll || searchOwnerId === user.id || (perms.edit === "team" && searchOwnerId != null && user.teamMemberIds.includes(searchOwnerId)),
    };
  });
  return (
    <ReviewQueue
      rows={data}
      pipelines={pipelines}
      users={users}
      currentUserId={user.id}
      suggestOnly={suggestOnly}
      rejectReasons={reasons}
      apifyConnected={apifyConnected}
      searches={searches.map((s) => ({ id: s.search.id, name: s.search.name }))}
      weights={settings.fitWeights}
      canEnrich={SCOPE_RANK[perms.enrichCreate] > 0}
    />
  );
}

async function SearchesTab({ user, canCreate }: { user: U; canCreate: boolean }) {
  const perms = await scoutPermissions(user);
  const rows = await listSearches(user);
  return (
    <SearchesTable
      canCreate={canCreate}
      rows={rows.map((r) => ({
        id: r.search.id,
        name: r.search.name,
        summary: describeCriteria(r.search.criteria as Partial<Criteria>),
        schedule: r.search.schedule,
        ownerName: r.ownerName,
        lastRunAt: r.search.lastRunAt?.toISOString() ?? null,
        lastRunStatus: r.lastRunStatus,
        lastRunId: r.lastRunId,
        total: r.total,
        pending: r.pending,
        accepted: r.accepted,
        canEdit: perms.edit === "all" || r.search.ownerId === user.id,
      }))}
    />
  );
}

async function RunsTab({ user }: { user: U }) {
  const rows = await listRuns(user, { limit: 150 });
  return (
    <RunsTable
      empty="Scout runs and executive enrichments appear here with their Apify cost."
      rows={rows.map((r) => ({
        ...r.run,
        requester: r.requester,
        target: r.run.kind === "enrich" ? (r.accountRestricted ? "Restricted account" : (r.accountName ?? "Account")) : (r.searchName ?? "Search"),
      }))}
    />
  );
}

async function BudgetTab({ user }: { user: U }) {
  const [b, funnel, runs] = await Promise.all([budgetSummary(user), scoutFunnel(user), listRuns(user, { limit: 25 })]);
  const monthLabel = b.monthStart.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Stat label={`Org spend · ${monthLabel}`} value={usd(b.orgSpentCents)} hint={`of ${usd(b.settings.orgMonthlyCents)} monthly cap`} />
        <Stat label="My spend" value={usd(b.mySpentCents)} hint={`of ${usd(b.myCapCents)} personal cap`} />
        <Stat label="Per-run max" value={usd(b.settings.perRunMaxCents)} hint={`≤ ${b.settings.maxDomainsPerRun} domains per scouting run`} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Spend vs caps</CardTitle>
              <CardDescription>Actual Apify usage where reported, otherwise items × cost per result. Running jobs reserve their estimate.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <SpendBar label="Organization" spentCents={b.orgSpentCents} capCents={b.settings.orgMonthlyCents} />
            {b.byUser.length ? (
              <table className="w-full text-sm">
                <caption className="sr-only">Spend by user</caption>
                <thead className="text-left text-xs text-muted">
                  <tr className="border-b border-border">
                    <th className="py-1.5">User</th>
                    <th className="py-1.5 text-right">Runs</th>
                    <th className="py-1.5 text-right">Spent</th>
                    <th className="py-1.5 text-right">Cap</th>
                  </tr>
                </thead>
                <tbody>
                  {b.byUser.map((u) => (
                    <tr key={u.userId ?? "system"} className="border-b border-border last:border-0">
                      <td className="py-1.5 text-secondary">{u.name ?? "System"}</td>
                      <td className="py-1.5 text-right tabular">{u.runs}</td>
                      <td className="py-1.5 text-right tabular text-body">{usd(u.cents)}</td>
                      <td className="py-1.5 text-right tabular text-muted">{usd(u.capCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted">No Apify spend this month.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Lead Scout funnel</CardTitle>
              <CardDescription>Found → accepted → contacted (deal past Outreach) → won.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <Funnel
              steps={[
                { label: "Found", value: funnel.found },
                { label: "Accepted", value: funnel.accepted },
                { label: "Contacted", value: funnel.contacted },
                { label: "Won", value: funnel.won },
              ]}
            />
            <p className="mt-4 text-xs text-muted">
              {funnel.rejected} rejected · cost per accepted target {funnel.accepted ? usd(Math.round(b.orgSpentCents / funnel.accepted)) : "—"} (this month’s spend)
            </p>
          </CardContent>
        </Card>
      </div>
      <div>
        <h2 className="mb-3 font-display text-lg text-fg">Recent runs</h2>
        <RunsTable
          empty="No runs yet."
          rows={runs.map((r) => ({ ...r.run, requester: r.requester, target: r.run.kind === "enrich" ? (r.accountRestricted ? "Restricted account" : (r.accountName ?? "Account")) : (r.searchName ?? "Search") }))}
        />
      </div>
    </div>
  );
}

async function SettingsTab({ apify }: { apify: Awaited<ReturnType<typeof apifyStatus>> }) {
  const [settings, actors] = await Promise.all([getScoutSettings(), actorRegistryRows()]);
  const raw = settings.rawFitWeights;
  const fitWeights = Object.fromEntries(Object.entries(settings.fitWeights).map(([k, v]) => [k, typeof raw[k] === "number" ? raw[k]! : Math.round(v)])) as typeof settings.fitWeights;
  return (
    <div className="space-y-6">
      <ApifyTokenCard apify={apify} />
      <ScoutSettingsForm
        initial={{
          visitsPerUnique: settings.visitsPerUnique,
          visitsPerUniqueByCategory: settings.visitsPerUniqueByCategory,
          fitWeights,
          targetRoles: settings.targetRoles,
          budget: settings.budget,
          autoPromoteValidSenior: settings.autoPromoteValidSenior,
        }}
      />
      <ActorRegistryTable actors={actors.map((a) => ({ id: a.id, purpose: a.purpose, actorId: a.actorId, fallbackOrder: a.fallbackOrder, costPerResultUsd: a.costPerResultUsd, enabled: a.enabled, compliant: a.compliant, timeoutSecs: a.timeoutSecs, maxItems: a.maxItems }))} />
    </div>
  );
}
