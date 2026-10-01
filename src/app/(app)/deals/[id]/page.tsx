import { Suspense } from "react";
import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { AudioLines, BookOpenCheck, ChevronLeft, ExternalLink, FileText, Rocket } from "lucide-react";
import { can, requireUser, type AppUser } from "@/lib/rbac/server";
import { getGoogleAccount } from "@/lib/integrations/google";
import { GMAIL_SEND_SCOPE, hasScope } from "@/lib/integrations/core";
import { listTranscripts } from "@/lib/transcripts/queries";
import { audit } from "@/lib/audit";
import { logServerError } from "@/lib/errors";
import { getDealDetail, getDealForUser } from "@/lib/deals/queries";
import { allLimited } from "@/lib/deals/concurrency";
import { ROLE_LABELS as STAKE_ROLE } from "@/lib/deals/rules";
import { countDealComments, getDealDiscussion } from "@/lib/comments/service";
import { dealPagePlaybook } from "@/lib/playbooks/service";
import { listDealHandoffs, pendingHandoffReview } from "@/lib/handoffs/service";
import { listDealHelpRequests } from "@/lib/help/service";
import { isActive as helpActive } from "@/lib/help/core";
import { HANDOFF_KIND_LABEL } from "@/lib/handoffs/core";
import { ColorTick, StatusBadge } from "@/components/ui/badge";
import { Avatar, Skeleton, Tooltip } from "@/components/ui/misc";
import { PriorityTag, RestrictedLock } from "@/components/deals/deal-bits";
import { StagePath } from "@/components/deals/record/stage-path";
import { CloseDateInput, NextStepEditor, OwnersBlock, PrioritySelect } from "@/components/deals/record/header-editors";
import { QuickActions } from "@/components/deals/record/quick-actions";
import { SlotBoundary } from "@/components/deals/record/slot-boundary";
import { SummaryCard } from "@/components/deals/record/summary-card";
import { Timeline } from "@/components/deals/record/timeline";
import { DocumentsPanel, Panel, StakeholdersPanel, TasksPanel } from "@/components/deals/record/side-panels";
import { Discussion } from "@/components/deals/record/discussion";
import { AutoMarker } from "@/components/deals/record/auto-marker";
import { DealTabs } from "@/components/deals/record/deal-tabs";
import { DEAL_TABS, type DealTab } from "@/components/deals/record/deal-tab-keys";
import { AdsPanel, MuuPanel, ProbabilityPanel, R100Panel } from "@/components/deals/record/type-panels";
import { CollisionNotice } from "@/components/deals/touches/collision-notice";
import { HandoffBanner } from "@/components/handoffs/handoff-banner";
import { HandoffButton } from "@/components/handoffs/handoff-dialog";
import { HelpRequestList, RequestHelpButton } from "@/components/help/request-help";
import { DealSignalsPanel } from "@/components/signals/deal-signals";
import { DealSequencesPanel } from "@/components/sequences/deal-sequences";
import { DealForecastBadge } from "@/components/forecast/deal-forecast";
import { DealShareButton } from "@/components/share/deal-share";
import { DealProposals } from "@/components/proposals/deal-proposals";
import { fmtDate, fmtNumber, fmtRelative, fmtUsd } from "@/lib/format";
import { healthStatus } from "@/lib/palette";

export async function generateMetadata({ params }: PageProps<"/deals/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const deal = await getDealForUser(user, id);
  return { title: deal?.name ?? "Deal" };
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Deal workspace (V2 §B6) — summary first: who/what/where in the header, the Copilot read in three lines, the ONE next
 * step, then signals and quick actions; everything else in tabs. At 375 px: header → next step → quick actions → rest.
 */
export default async function DealPage({ params, searchParams }: PageProps<"/deals/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const tabParam = one(sp.tab);
  const initialTab: DealTab = (DEAL_TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as DealTab) : "activity";
  const focusHandoff = one(sp.handoff) ?? null;
  const focusHelp = one(sp.help) ?? null;
  const uuidRe = /^[0-9a-f-]{36}$/i;
  const moveParam = one(sp.move);
  const autoMove = moveParam && uuidRe.test(moveParam) ? { stageId: moveParam, signalId: uuidRe.test(one(sp.signal) ?? "") ? one(sp.signal)! : null } : null;

  const d = await getDealDetail(user, id, { muuHistory: initialTab === "details" });
  if (!d) {
    // V2 §C3: a pending handoff receiver who can't see the deal yet gets the read-only brief.
    const review = await pendingHandoffReview(user, id);
    if (review) return <HandoffReview review={review} currentUserId={user.id} />;
    notFound(); // not visible (scope / restricted access list) → indistinguishable from missing
  }
  if (d.deal.restricted) {
    await audit({ actorId: user.id, action: "deal.view_restricted", entity: "deal", entityId: d.deal.id });
  }

  const { deal, pipeline, value, perms } = d;
  const [canEmail, canEnrich, googleAcct, commentCount, { playbook, hints }, handoffs, helps] = await allLimited(
    [
      () => can(user, "email", "view"),
      () => can(user, "enrichment", "create"),
      () => getGoogleAccount(user.id),
      () => countDealComments(deal.id),
      () => dealPagePlaybook(pipeline.id, d.stage.id),
      () => listDealHandoffs(deal.id),
      () => listDealHelpRequests(deal.id),
    ],
    3,
  );
  const primary = d.stakeholders.find((c) => c.isPrimary) ?? d.stakeholders.find((c) => c.email);
  const emailTo = primary?.email ? [primary.email] : [];
  const motion = ["NET", "SPT", "ENT", "R100"].includes(pipeline.key) ? pipeline.key : "NET";
  const isOpen = deal.status === "open";
  const movable = { id: deal.id, name: deal.name, filled: deal.filled, stageId: d.stage.id, nextStep: deal.nextStep, nextStepDueAt: deal.nextStepDueAt };
  // Perf H-4 / QA MIN-20: only the ACTIVE tab's heavy, separately-loaded parts (transcripts, sequences, proposals,
  // discussion) render on the server; switching tabs re-requests the page with ?tab= (DealTabs) and they stream in then.
  const lazy = (tab: DealTab, node: React.ReactNode, fallback: React.ReactNode = <Skeleton className="h-24" />) => (initialTab === tab ? node : fallback);
  const pendingHandoff = handoffs.find((h) => h.status === "pending") ?? null;
  const activeHelp = helps.filter((h) => helpActive(h.status));
  const openTasks = d.tasks.filter((t) => t.status === "open").length;
  const keyPeople = [...d.stakeholders].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || Number(!!b.role) - Number(!!a.role)).slice(0, 4);
  const auto = deal.autofill;
  const canHandoff = perms.canEdit && (isOpen || deal.status === "hold" || (deal.status === "won" && ["NET", "ENT", "SPT"].includes(pipeline.key)));

  const quickActions = (
    <QuickActions
      dealId={deal.id}
      contacts={d.accountContacts}
      users={d.users}
      ownerId={deal.ownerId}
      currentUserId={d.currentUserId}
      canLog={perms.canLog}
      canTask={perms.canCreateTask}
      canUseAi={perms.canUseAi}
      dealName={deal.name}
      email={canEmail ? { to: emailTo, canSend: hasScope(googleAcct?.scope, GMAIL_SEND_SCOPE) } : null}
      enrich={canEnrich && d.account?.domain ? { accountId: d.account.id, motion } : null}
      more={
        <>
          <Slot name="share">
            <DealShareButton dealId={deal.id} />
          </Slot>
          {canHandoff && !pendingHandoff ? <HandoffButton dealId={deal.id} dealStatus={deal.status} /> : null}
          {isOpen || deal.status === "hold" ? <RequestHelpButton dealId={deal.id} /> : null}
        </>
      }
    />
  );

  return (
    <div className="space-y-5">
      {/* ── Header: who / what / where ── */}
      <header className="space-y-3">
        <Link href={`/pipelines/${pipeline.key}`} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg">
          <ChevronLeft className="size-3.5" />
          <ColorTick color={pipeline.color} className="h-2.5" /> {pipeline.name}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-72">
            <h1 className="flex flex-wrap items-center gap-x-2 gap-y-1 font-display text-[26px] font-medium leading-8 text-fg sm:text-[28px] sm:leading-9">
              <span className="min-w-0 break-words">{deal.name}</span>
              {deal.restricted ? <RestrictedLock /> : null}
              {deal.status === "won" ? <StatusBadge status="good" label="Won" /> : deal.status === "lost" ? <StatusBadge status="critical" label="Lost" /> : deal.status === "hold" ? <StatusBadge status="warning" label="On hold" /> : null}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-secondary">
              {d.account ? (
                <Link href={`/accounts/${d.account.id}`} className="text-body hover:underline">
                  {d.account.name}
                </Link>
              ) : (
                <span className="text-muted">No account</span>
              )}
              {d.account?.domain ? (
                <a href={`https://${d.account.domain}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-muted hover:text-fg">
                  {d.account.domain} <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : null}
              {d.account?.category ? <span className="hidden text-muted sm:inline">{d.account.category}</span> : null}
              <PriorityTag priority={deal.priority} />
              {/* QA MIN-21: the forecast badge sits beside the heading, not inside the <h1>. */}
              <Slot name="forecast">
                <DealForecastBadge dealId={deal.id} />
              </Slot>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <OwnersBlock dealId={deal.id} owner={d.owner} splits={d.splits} assignable={d.assignable} users={d.users} canEdit={perms.canEdit} canAssign={perms.canAssign} />
          </div>
        </div>
        <StagePath deal={movable} stages={d.stages} canEdit={perms.canEdit} picklists={d.picklists} hiddenFields={d.hiddenFields} canCreateContact={perms.canCreateContact} playbookHints={hints} autoMove={autoMove} />
      </header>

      {/* ── Summary first: next step, Copilot read, numbers, people ── */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <section
          aria-labelledby="next-step-h"
          id="next-step"
          className={`order-1 min-w-0 rounded-lg border px-4 py-3.5 lg:order-2 ${isOpen && !deal.nextStep && !deal.nextStepWaitingReason ? "border-border-strong bg-surface-2" : "border-border bg-surface-1"}`}
        >
          <h2 id="next-step-h" className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
            Next step
          </h2>
          <NextStepEditor dealId={deal.id} nextStep={deal.nextStep} dueAt={deal.nextStepDueAt} waitingReason={deal.nextStepWaitingReason} overdueDays={deal.overdueDays} canEdit={perms.canEdit} isOpen={isOpen} />
        </section>
        <div className="order-2 min-w-0 lg:order-4 lg:col-span-2">{quickActions}</div>
        <SummaryCard className="order-3 lg:order-1" dealId={deal.id} summary={deal.aiSummary} at={deal.aiSummaryAt} restricted={deal.restricted} />
        <div className="order-4 grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] lg:order-3 lg:col-span-2">
          <dl className="grid min-w-0 grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
            {pipeline.unit === "muu" ? (
              <>
                <ValueCell label="MUU" value={fmtNumber(value.muu, { compact: true })} hint={deal.muu == null ? "not set" : undefined} />
                <ValueCell label="Gross / yr" value={fmtUsd(value.grossUsd, { compact: true })} />
                <ValueCell label="Weighted" value={fmtUsd(value.weightedGrossUsd, { compact: true })} hint={`${Math.round(value.probability * 100)}%${value.overridden ? " override" : ""}`} />
              </>
            ) : pipeline.unit === "usd" ? (
              <>
                <ValueCell label="Contract" value={fmtUsd(deal.contractValueCents, { cents: true, compact: true })} />
                <ValueCell label="Annualized" value={fmtUsd(value.grossUsd, { compact: true })} />
                <ValueCell label="Weighted" value={fmtUsd(value.weightedGrossUsd, { compact: true })} hint={`${Math.round(value.probability * 100)}%`} />
              </>
            ) : (
              <>
                <ValueCell label="Program" value={deal.status === "won" ? "Live" : "In progress"} />
                <ValueCell label="Posts" value={fmtNumber(deal.r100.postCount ?? 0)} />
                <ValueCell label="First post" value={fmtDate(deal.r100.firstPostDate ?? null, "d MMM")} />
              </>
            )}
            <div className="min-w-0 bg-surface-1 px-4 py-2.5">
              <dt className="text-[11px] font-medium uppercase tracking-wider text-muted">Health</dt>
              <dd className="mt-0.5 flex items-center gap-2">
                {deal.healthScore != null ? (
                  <Tooltip content={<span className="block max-w-64">{deal.healthExplanation}</span>}>
                    <span tabIndex={0} className="inline-flex items-center gap-2" aria-label={`Health ${deal.healthScore} of 100. ${deal.healthExplanation ?? ""}`}>
                      <span className="font-display text-2xl leading-8 text-fg tabular">{deal.healthScore}</span>
                      <StatusBadge status={healthStatus(deal.healthScore)} label={HEALTH_WORD[healthStatus(deal.healthScore)]} />
                    </span>
                  </Tooltip>
                ) : (
                  <span className="text-sm text-muted">Not scored</span>
                )}
              </dd>
            </div>
          </dl>
          <div className="flex min-w-0 items-center gap-4 rounded-lg border border-border bg-surface-1 px-4 py-2.5">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Key people</p>
              {keyPeople.length ? (
                <ul className="mt-1 flex -space-x-1.5" aria-label="Key stakeholders">
                  {keyPeople.map((p) => (
                    <li key={p.contactId}>
                      <Tooltip content={`${p.name}${p.title ? ` · ${p.title}` : ""}${p.role ? ` · ${STAKE_ROLE[p.role] ?? p.role}` : ""}${p.isPrimary ? " · primary" : ""}`}>
                        <span tabIndex={0} className="inline-flex rounded-full" aria-label={`${p.name}${p.role ? `, ${STAKE_ROLE[p.role] ?? p.role}` : ""}`}>
                          <Avatar name={p.name} size={26} className="ring-2 ring-surface-1" />
                        </span>
                      </Tooltip>
                    </li>
                  ))}
                  {d.stakeholders.length > keyPeople.length ? <li className="pl-3 text-[11px] text-muted tabular">+{d.stakeholders.length - keyPeople.length}</li> : null}
                </ul>
              ) : (
                <p className="mt-1 text-[12px] text-muted">None linked</p>
              )}
            </div>
            <dl className="ml-auto grid shrink-0 gap-0.5 text-right text-[11px]">
              <KeyDate label="In stage" value={`${deal.daysInStage}d`} />
              <KeyDate label="Last touch" value={deal.lastActivityAt ? fmtRelative(deal.lastActivityAt) : "—"} />
            </dl>
          </div>
        </div>
      </div>

      {/* QA MIN-21 / V2 §B6: signals directly under the summary, before notices and banners. */}
      <Slot name="signals">
        <DealSignalsPanel dealId={deal.id} />
      </Slot>

      <Suspense fallback={null}>
        <CollisionNotice user={user} dealId={deal.id} known={{ accountId: d.account?.id ?? null, accountType: d.account?.type ?? null, accountRestricted: !!d.account?.restricted }} />
      </Suspense>

      {pendingHandoff ? <HandoffBanner handoff={pendingHandoff} currentUserId={user.id} canEdit={perms.canEdit} focus={focusHandoff === pendingHandoff.id} /> : null}
      {activeHelp.length ? <HelpRequestList requests={activeHelp} currentUserId={user.id} focusId={focusHelp} /> : null}

      {playbook?.guidance && isOpen ? (
        // QA A7: the stage playbook is open for the first days in a stage (when it matters), collapsed afterwards.
        <details open={deal.daysInStage <= 3} className="group rounded-lg border border-border bg-surface-1 px-4 py-2.5 [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] text-secondary">
            <BookOpenCheck className="size-4 text-muted" aria-hidden />
            <span>
              <span className="text-body">{d.stage.name} playbook</span>
              <span className="text-muted"> · how to win this stage</span>
            </span>
            <span className="ml-auto text-[11px] text-muted group-open:hidden">Show</span>
            <span className="ml-auto hidden text-[11px] text-muted group-open:inline">Hide</span>
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-5 text-body">{playbook.guidance}</p>
          {playbook.emailTemplates.length ? (
            <p className="mt-2 text-[11px] text-muted">Templates: {playbook.emailTemplates.map((t) => t.name).join(" · ")}</p>
          ) : null}
        </details>
      ) : null}

      {/* ── Tabs ── */}
      <DealTabs
        initial={initialTab}
        lazyTabs={["activity", "contacts", "docs", "details", "discussion"]}
        counts={{ tasks: openTasks, contacts: d.stakeholders.length, docs: d.documents.length, discussion: commentCount }}
        panels={{
          activity: (
            <div className="space-y-4">
              <Timeline dealId={deal.id} items={d.activities} canLog={perms.canLog} canPin={perms.canEdit} />
              {lazy(
                "activity",
                <Suspense fallback={<Skeleton className="h-24" />}>
                  <TranscriptsPanel user={user} dealId={deal.id} />
                </Suspense>,
              )}
            </div>
          ),
          tasks: <TasksPanel dealId={deal.id} tasks={d.tasks} users={d.users} defaultAssignee={deal.ownerId ?? d.currentUserId} canCreate={perms.canCreateTask} />,
          contacts: (
            <div className="grid gap-4 xl:grid-cols-2">
              <StakeholdersPanel dealId={deal.id} stakeholders={d.stakeholders} gaps={d.coverageGaps} accountContacts={d.accountContacts} canEdit={perms.canEdit} canCreateContact={perms.canCreateContact} />
              {lazy(
                "contacts",
                <Slot name="sequences">
                  <DealSequencesPanel dealId={deal.id} />
                </Slot>,
              )}
            </div>
          ),
          docs: (
            <div className="space-y-4">
              <DocumentsPanel dealId={deal.id} documents={d.documents} canEdit={perms.canEdit} />
              {lazy(
                "docs",
                <Slot name="proposals" fallback={<Skeleton className="h-24" />}>
                  <DealProposals dealId={deal.id} />
                </Slot>,
              )}
              {/* ENT's "Generate pro forma" lives in DealProposals; keep the generic builder link for the other motions. */}
              {["NET", "SPT", "ADS"].includes(pipeline.key) && !d.hiddenFields.includes("revSharePct") ? (
                <Link href={`/proposals/new?dealId=${deal.id}`} className="flex items-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-3 text-[13px] text-secondary transition-colors duration-150 hover:border-border-strong hover:text-fg">
                  <FileText className="size-4" aria-hidden /> Generate a proposal from this deal
                </Link>
              ) : null}
            </div>
          ),
          details: (
            <div className="grid gap-4 xl:grid-cols-2">
              <div className="space-y-4">
                <Panel title="Details">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
                    <div>
                      <dt className="mb-1 flex items-center gap-1.5 text-[11px] text-muted">
                        Priority <AutoMarker dealId={deal.id} field="priority" entry={auto.priority} canEdit={perms.canEdit} />
                      </dt>
                      <dd>
                        <PrioritySelect dealId={deal.id} value={deal.priority} canEdit={perms.canEdit} />
                      </dd>
                    </div>
                    <div>
                      <dt className="mb-1 flex items-center gap-1.5 text-[11px] text-muted">
                        Expected close <AutoMarker dealId={deal.id} field="expectedCloseDate" entry={auto.expectedCloseDate} canEdit={perms.canEdit} />
                      </dt>
                      <dd>
                        <CloseDateInput dealId={deal.id} value={deal.expectedCloseDate} canEdit={perms.canEdit} />
                      </dd>
                    </div>
                    <div>
                      <dt className="flex items-center gap-1.5 text-[11px] text-muted">
                        Primary contact <AutoMarker dealId={deal.id} field="primaryContactId" entry={auto.primaryContactId} canEdit={perms.canEdit} />
                      </dt>
                      <dd className="truncate text-body">{d.stakeholders.find((c) => c.isPrimary)?.name ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="flex items-center gap-1.5 text-[11px] text-muted">
                        Source <AutoMarker dealId={deal.id} field="source" entry={auto.source} canEdit={perms.canEdit} />
                      </dt>
                      <dd className="text-body">{deal.source ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-muted">Stage SLA</dt>
                      <dd className="text-body">{d.stage.slaDays ? `${d.stage.slaDays} days` : "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-muted">Created</dt>
                      <dd className="text-body tabular">{fmtDate(deal.createdAt)}</dd>
                    </div>
                    {deal.wonAt ? (
                      <div>
                        <dt className="text-[11px] text-muted">Won</dt>
                        <dd className="text-body tabular">{fmtDate(deal.wonAt)}</dd>
                      </div>
                    ) : null}
                    {deal.lostAt ? (
                      <div>
                        <dt className="text-[11px] text-muted">Lost</dt>
                        <dd className="text-body tabular">{fmtDate(deal.lostAt)}</dd>
                      </div>
                    ) : null}
                  </dl>
                  {deal.lostReason || deal.holdReason ? (
                    <p className="mt-3 text-[12px] text-secondary">
                      {deal.status === "lost" ? "Lost reason" : "Hold reason"}: <span className="text-body">{deal.status === "lost" ? deal.lostReason : deal.holdReason}</span>
                    </p>
                  ) : null}
                  {d.migration ? (
                    <Link href={`/onboarding?project=${d.migration.id}`} className="mt-3 flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[12px] text-secondary hover:border-border-strong hover:text-fg">
                      <Rocket className="size-3.5" aria-hidden /> Onboarding: {d.migration.stage.replace("_", " ")}
                    </Link>
                  ) : null}
                </Panel>
                <ProbabilityPanel
                  dealId={deal.id}
                  stageProbability={value.stageProbability}
                  effective={value.probability}
                  override={deal.probabilityOverride}
                  overrideReason={deal.overrideReason}
                  overrideStatus={deal.overrideStatus}
                  pendingSince={d.pendingApproval?.createdAt ?? null}
                  canEdit={perms.canEdit}
                  isApprover={perms.isApprover}
                />
                {handoffs.length || helps.length ? (
                  <Panel title="Handoffs & help">
                    <ul className="space-y-2 text-[12px]">
                      {handoffs.map((h) => (
                        <li key={h.id} className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-body">
                            {HANDOFF_KIND_LABEL[h.kind]}: {h.from?.name ?? "—"} → {h.to.name}
                          </span>
                          <span className="text-muted">
                            {h.status} · {fmtDate(h.respondedAt ?? h.createdAt)}
                          </span>
                          {h.responseNote ? <span className="w-full text-secondary">“{h.responseNote}”</span> : null}
                        </li>
                      ))}
                      {helps
                        .filter((h) => !helpActive(h.status))
                        .map((h) => (
                          <li key={h.id} className="flex flex-wrap items-baseline gap-x-2">
                            <span className="text-body">
                              Help: {h.requester.name} → {h.target.name}
                            </span>
                            <span className="text-muted">
                              {h.status} · {fmtDate(h.respondedAt ?? h.createdAt)}
                            </span>
                            <span className="w-full truncate text-secondary">{h.ask}</span>
                          </li>
                        ))}
                    </ul>
                  </Panel>
                ) : null}
              </div>
              <div className="space-y-4">
                {pipeline.unit === "muu"
                  ? lazy("details", <MuuPanel dealId={deal.id} deal={deal} hidden={d.hiddenFields} pipelineUsdPerMuu={pipeline.usdPerMuu} history={d.muuHistory} canEdit={perms.canEdit} />)
                  : null}
                {pipeline.key === "ADS" ? <AdsPanel dealId={deal.id} deal={deal} invoices={d.invoices} canEdit={perms.canEdit} /> : null}
                {pipeline.key === "R100" ? <R100Panel dealId={deal.id} r100={deal.r100} canEdit={perms.canEdit} /> : null}
              </div>
            </div>
          ),
          discussion: lazy(
            "discussion",
            <Suspense fallback={<Skeleton className="h-40" />}>
              <DiscussionPanel user={user} dealId={deal.id} restricted={deal.restricted} canComment={perms.canComment} />
            </Suspense>,
            <Skeleton className="h-40" />,
          ),
        }}
      />
    </div>
  );
}

/**
 * Slot components are owned by other teams (signals, sequences, forecast, share, proposals). A failure inside one must never take
 * the deal page down: each slot streams in its own Suspense boundary, is wrapped in a client error boundary (nested async
 * errors), renders nothing on error, and gives up after SLOT_TIMEOUT_MS (CR L2 / QA MIN-20).
 */
function Slot({ name, children, fallback = null }: { name: string; children: React.ReactElement<{ dealId: string }>; fallback?: React.ReactNode }) {
  return (
    <SlotBoundary name={name}>
      <Suspense fallback={fallback}>
        <SlotInner name={name}>{children}</SlotInner>
      </Suspense>
    </SlotBoundary>
  );
}

const SLOT_TIMEOUT_MS = 5000;

async function SlotInner({ name, children }: { name: string; children: React.ReactElement<{ dealId: string }> }) {
  const render = children.type as unknown as (p: { dealId: string }) => Promise<React.ReactNode> | React.ReactNode;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<React.ReactNode>((resolve) => {
      timer = setTimeout(() => {
        logServerError(`deal-slot.${name}`, new Error(`slot timed out after ${SLOT_TIMEOUT_MS} ms`));
        resolve(null);
      }, SLOT_TIMEOUT_MS);
    });
    return await Promise.race([Promise.resolve(render(children.props)), timeout]);
  } catch (e) {
    unstable_rethrow(e); // never swallow notFound()/forbidden()/redirect() or dynamic-usage interrupts
    logServerError(`deal-slot.${name}`, e);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Streams in after the header (the discussion audience is computed per user — keep it off the critical path). */
async function DiscussionPanel({ user, dealId, restricted, canComment }: { user: AppUser; dealId: string; restricted: boolean; canComment: boolean }) {
  const discussion = await getDealDiscussion(user, dealId);
  if (!discussion) return <p className="text-sm text-muted">Discussion is unavailable right now.</p>;
  return <Discussion dealId={dealId} threads={discussion.threads} mentionable={discussion.mentionable} restricted={restricted} canComment={canComment} />;
}

async function TranscriptsPanel({ user, dealId }: { user: AppUser; dealId: string }) {
  const transcripts = await listTranscripts(user, { dealId }, 20);
  if (!transcripts) return null;
  return (
    <Panel
      title="Calls & transcripts"
      count={transcripts.length}
      action={
        <Link href={`/calls/upload?dealId=${dealId}`} className="text-xs text-secondary hover:text-fg">
          Upload
        </Link>
      }
    >
      {transcripts.length ? (
        <ul className="space-y-2">
          {transcripts.map((t) => (
            <li key={t.id}>
              <Link href={`/calls/${t.id}`} className="flex items-start gap-2 rounded-md px-1 py-1 text-[13px] hover:bg-surface-2">
                <AudioLines className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body">{t.title ?? "Call transcript"}</span>
                  <span className="block text-[11px] text-muted">
                    {fmtDate(t.occurredAt ?? t.createdAt)} · {t.source}
                    {t.appliedAt ? " · applied" : t.status === "ready" ? " · ready to review" : ` · ${t.status}`}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-muted">No calls linked yet. Upload a transcript or connect Granola / Zoom.</p>
      )}
    </Panel>
  );
}

/** Read-only brief for a handoff receiver who can't see the deal yet (V2 §C3). */
function HandoffReview({ review, currentUserId }: { review: NonNullable<Awaited<ReturnType<typeof pendingHandoffReview>>>; currentUserId: string }) {
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header>
        <p className="text-xs text-muted">{review.deal.pipelineName} · handoff review</p>
        <h1 className="mt-1 font-display text-[28px] font-medium leading-9 text-fg">{review.deal.name}</h1>
        <p className="mt-1 text-sm text-secondary">
          {review.deal.accountName ?? "No account"} · {review.deal.stage}
        </p>
      </header>
      <HandoffBanner handoff={review.handoff} currentUserId={currentUserId} canEdit={false} focus />
      <p className="text-[12px] text-muted">You&apos;ll see the full deal once you accept. Declining returns it to the sender with your note.</p>
    </div>
  );
}

const HEALTH_WORD = { good: "Healthy", warning: "Watch", serious: "At risk", critical: "Critical" } as const;

function ValueCell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 bg-surface-1 px-4 py-2.5">
      <dt className="truncate text-[11px] font-medium uppercase tracking-wider text-muted" title={label}>
        {label}
      </dt>
      <dd className="mt-0.5 min-w-0">
        <span className="block truncate font-display text-2xl leading-8 text-fg tabular" title={value}>
          {value}
        </span>
        {hint ? <span className="block truncate text-[11px] leading-4 text-muted">{hint}</span> : null}
      </dd>
    </div>
  );
}

function KeyDate({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-end gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="text-body tabular">{value}</dd>
    </div>
  );
}

