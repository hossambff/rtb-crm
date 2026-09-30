import Link from "next/link";
import { notFound } from "next/navigation";
import { AudioLines, ChevronLeft, ExternalLink, Rocket } from "lucide-react";
import { can, requireUser } from "@/lib/rbac/server";
import { getGoogleAccount } from "@/lib/integrations/google";
import { GMAIL_SEND_SCOPE, hasScope } from "@/lib/integrations/core";
import { listTranscripts } from "@/lib/transcripts/queries";
import { audit } from "@/lib/audit";
import { getDealDetail, getDealForUser } from "@/lib/deals/queries";
import { ColorTick, StatusBadge } from "@/components/ui/badge";
import { PriorityTag, RestrictedLock } from "@/components/deals/deal-bits";
import { StagePath } from "@/components/deals/record/stage-path";
import { CloseDateInput, NextStepEditor, OwnersBlock, PrioritySelect } from "@/components/deals/record/header-editors";
import { QuickActions } from "@/components/deals/record/quick-actions";
import { AiSummaryBox } from "@/components/deals/record/ai-summary";
import { Timeline } from "@/components/deals/record/timeline";
import { DocumentsPanel, Panel, StakeholdersPanel, TasksPanel } from "@/components/deals/record/side-panels";
import { Comments } from "@/components/deals/record/comments";
import { AdsPanel, MuuPanel, ProbabilityPanel, R100Panel } from "@/components/deals/record/type-panels";
import { fmtDate, fmtNumber, fmtRelative, fmtUsd } from "@/lib/format";
import { healthStatus } from "@/lib/palette";

export async function generateMetadata({ params }: PageProps<"/deals/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const deal = await getDealForUser(user, id);
  return { title: deal?.name ?? "Deal" };
}

export default async function DealPage({ params }: PageProps<"/deals/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const d = await getDealDetail(user, id);
  if (!d) notFound(); // not visible (scope / restricted access list) → indistinguishable from missing
  if (d.deal.restricted) {
    await audit({ actorId: user.id, action: "deal.view_restricted", entity: "deal", entityId: d.deal.id });
  }

  const { deal, pipeline, value, perms } = d;
  const [canEmail, canEnrich, googleAcct, transcripts] = await Promise.all([
    can(user, "email", "view"),
    can(user, "enrichment", "create"),
    getGoogleAccount(user.id),
    listTranscripts(user, { dealId: deal.id }, 20),
  ]);
  const primary = d.stakeholders.find((c) => c.isPrimary) ?? d.stakeholders.find((c) => c.email);
  const emailTo = primary?.email ? [primary.email] : [];
  const motion = ["NET", "SPT", "ENT", "R100"].includes(pipeline.key) ? pipeline.key : "NET";
  const isOpen = deal.status === "open";
  const overdueDays = deal.overdueDays;
  const movable = { id: deal.id, name: deal.name, filled: deal.filled, stageId: d.stage.id };
  const picklists = d.picklists;

  return (
    <div className="space-y-5">
      {/* ── Header (CARD-1) ── */}
      <header className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Link href={`/pipelines/${pipeline.key}`} className="mb-1 inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg">
              <ChevronLeft className="size-3.5" />
              <ColorTick color={pipeline.color} className="h-2.5" /> {pipeline.name}
            </Link>
            <h1 className="flex flex-wrap items-center gap-2 font-display text-[28px] font-medium leading-9 text-fg">
              {deal.name}
              {deal.restricted ? <RestrictedLock /> : null}
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
                  {d.account.domain} <ExternalLink className="size-3" />
                </a>
              ) : null}
              {d.account?.category ? <span className="text-muted">{d.account.category}</span> : null}
              <PriorityTag priority={deal.priority} />
              {deal.status === "won" ? <StatusBadge status="good" label="Won" /> : deal.status === "lost" ? <StatusBadge status="critical" label="Lost" /> : deal.status === "hold" ? <StatusBadge status="warning" label="On hold" /> : null}
            </p>
          </div>
          <OwnersBlock dealId={deal.id} owner={d.owner} splits={d.splits} assignable={d.assignable} users={d.users} canEdit={perms.canEdit} canAssign={perms.canAssign} />
        </div>

        <StagePath deal={movable} stages={d.stages} canEdit={perms.canEdit} picklists={picklists} hiddenFields={d.hiddenFields} canCreateContact={perms.canCreateContact} />

        {/* Value block + health + next step */}
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)_minmax(0,1fr)]">
          <div className="grid min-w-0 grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4 lg:col-span-2 xl:col-span-1 xl:grid-cols-2 2xl:grid-cols-4">
            {pipeline.unit === "muu" ? (
              <>
                <ValueCell label="MUU" value={fmtNumber(value.muu, { compact: true })} hint={deal.muu == null ? "Not set" : undefined} />
                <ValueCell label="Gross / yr" value={fmtUsd(value.grossUsd, { compact: true })} hint="gross" />
                <ValueCell label="RTB net / yr" value={value.netUsd !== undefined ? fmtUsd(value.netUsd, { compact: true }) : "Hidden"} hint="net" muted={value.netUsd === undefined} />
                <ValueCell label="Weighted" value={fmtUsd(value.weightedGrossUsd, { compact: true })} hint={`gross × ${Math.round(value.probability * 100)}%${value.overridden ? " (override)" : ""}`} />
              </>
            ) : pipeline.unit === "usd" ? (
              <>
                <ValueCell label="Contract value" value={fmtUsd(deal.contractValueCents, { cents: true, compact: true })} hint="gross" />
                <ValueCell label="Annualized" value={fmtUsd(value.grossUsd, { compact: true })} hint="gross" />
                <ValueCell label="Probability" value={`${Math.round(value.probability * 100)}%`} hint={value.overridden ? "override" : "stage default"} />
                <ValueCell label="Weighted" value={fmtUsd(value.weightedGrossUsd, { compact: true })} hint="gross × probability" />
              </>
            ) : (
              <>
                <ValueCell label="Program" value={deal.status === "won" ? "Live" : "In progress"} />
                <ValueCell label="Posts" value={fmtNumber(deal.r100.postCount ?? 0)} />
                <ValueCell label="First post" value={fmtDate(deal.r100.firstPostDate ?? null, "d MMM")} />
                <ValueCell label="Probability" value={`${Math.round(value.probability * 100)}%`} />
              </>
            )}
          </div>
          <div className="min-w-0 rounded-lg border border-border bg-surface-1 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Health</p>
            {deal.healthScore != null ? (
              <>
                <div className="mt-1 flex items-center gap-2">
                  <span className="font-display text-3xl text-fg tabular">{deal.healthScore}</span>
                  <StatusBadge status={healthStatus(deal.healthScore)} label={HEALTH_WORD[healthStatus(deal.healthScore)]} />
                </div>
                <p className="mt-1 line-clamp-3 text-[12px] text-secondary">{deal.healthExplanation}</p>
              </>
            ) : (
              <p className="mt-1 text-[12px] text-muted">{deal.healthExplanation ?? "Not scored"}</p>
            )}
          </div>
          <div className="min-w-0 rounded-lg border border-border bg-surface-1 px-4 py-3">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Next step</p>
            <NextStepEditor
              dealId={deal.id}
              nextStep={deal.nextStep}
              dueAt={deal.nextStepDueAt}
              waitingReason={deal.nextStepWaitingReason}
              overdueDays={overdueDays}
              canEdit={perms.canEdit}
              isOpen={isOpen}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <QuickActions
            dealId={deal.id}
            contacts={d.accountContacts}
            users={d.users}
            ownerId={deal.ownerId}
            currentUserId={d.currentUserId}
            canLog={perms.canLog}
            canTask={perms.canCreateTask}
            canUseAi={perms.canUseAi}
            showProposal={["NET", "ENT", "SPT", "ADS"].includes(pipeline.key) && !d.hiddenFields.includes("revSharePct")}
            dealName={deal.name}
            email={canEmail ? { to: emailTo, canSend: hasScope(googleAcct?.scope, GMAIL_SEND_SCOPE) } : null}
            enrich={canEnrich && d.account?.domain ? { accountId: d.account.id, motion } : null}
          />
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
            <KeyDate label="In stage" value={`${deal.daysInStage}d`} />
            <KeyDate label="Last activity" value={deal.lastActivityAt ? fmtRelative(deal.lastActivityAt) : "—"} />
            <KeyDate label="Created" value={fmtDate(deal.createdAt)} />
            {deal.wonAt ? <KeyDate label="Won" value={fmtDate(deal.wonAt)} /> : null}
            {deal.lostAt ? <KeyDate label="Lost" value={fmtDate(deal.lostAt)} /> : null}
          </dl>
        </div>
        {deal.lostReason || deal.holdReason ? (
          <p className="text-[12px] text-secondary">
            {deal.status === "lost" ? "Lost reason" : "Hold reason"}: <span className="text-body">{deal.status === "lost" ? deal.lostReason : deal.holdReason}</span>
          </p>
        ) : null}
      </header>

      {/* ── Body ── */}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          <AiSummaryBox dealId={deal.id} summary={deal.aiSummary} at={deal.aiSummaryAt} restricted={deal.restricted} />
          <Timeline dealId={deal.id} items={d.activities} canLog={perms.canLog} canPin={perms.canEdit} />
          <Comments dealId={deal.id} comments={d.comments} users={d.users} />
        </div>
        <aside className="min-w-0 space-y-4" aria-label="Deal details">
          <Panel title="Details">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
              <div>
                <dt className="mb-1 text-[11px] text-muted">Priority</dt>
                <dd>
                  <PrioritySelect dealId={deal.id} value={deal.priority} canEdit={perms.canEdit} />
                </dd>
              </div>
              <div>
                <dt className="mb-1 text-[11px] text-muted">Expected close</dt>
                <dd>
                  <CloseDateInput dealId={deal.id} value={deal.expectedCloseDate} canEdit={perms.canEdit} />
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-muted">Source</dt>
                <dd className="text-body">{deal.source ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-[11px] text-muted">Stage SLA</dt>
                <dd className="text-body">{d.stage.slaDays ? `${d.stage.slaDays} days` : "—"}</dd>
              </div>
            </dl>
            {d.migration ? (
              <Link href={`/onboarding?project=${d.migration.id}`} className="mt-3 flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[12px] text-secondary hover:border-border-strong hover:text-fg">
                <Rocket className="size-3.5" /> Onboarding: {d.migration.stage.replace("_", " ")}
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
          {pipeline.unit === "muu" ? (
            <MuuPanel
              dealId={deal.id}
              deal={deal}
              hidden={d.hiddenFields}
              pipelineUsdPerMuu={pipeline.usdPerMuu}
              history={d.muuHistory}
              canEdit={perms.canEdit}
            />
          ) : null}
          {pipeline.key === "ADS" ? <AdsPanel dealId={deal.id} deal={deal} invoices={d.invoices} canEdit={perms.canEdit} /> : null}
          {pipeline.key === "R100" ? <R100Panel dealId={deal.id} r100={deal.r100} canEdit={perms.canEdit} /> : null}
          <StakeholdersPanel
            dealId={deal.id}
            stakeholders={d.stakeholders}
            gaps={d.coverageGaps}
            accountContacts={d.accountContacts}
            canEdit={perms.canEdit}
            canCreateContact={perms.canCreateContact}
          />
          <TasksPanel dealId={deal.id} tasks={d.tasks} users={d.users} defaultAssignee={deal.ownerId ?? d.currentUserId} canCreate={perms.canCreateTask} />
          <DocumentsPanel dealId={deal.id} documents={d.documents} canEdit={perms.canEdit} />
          {transcripts ? (
            <Panel
              title="Transcripts"
              count={transcripts.length}
              action={
                <Link href={`/calls/upload?dealId=${deal.id}`} className="text-xs text-secondary hover:text-fg">
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
          ) : null}
        </aside>
      </div>
    </div>
  );
}

const HEALTH_WORD = { good: "Healthy", warning: "Watch", serious: "At risk", critical: "Critical" } as const;

function ValueCell({ label, value, hint, muted }: { label: string; value: string; hint?: string; muted?: boolean }) {
  return (
    <div className="min-w-0 bg-surface-1 px-4 py-3">
      <p className="truncate text-[11px] font-medium uppercase tracking-wider text-muted" title={label}>
        {label}
      </p>
      <p className={muted ? "mt-1 truncate text-sm text-muted" : "mt-0.5 truncate font-display text-2xl leading-8 text-fg tabular"} title={value}>
        {value}
      </p>
      {hint ? (
        <p className="truncate text-[11px] text-muted" title={hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function KeyDate({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="text-body tabular">{value}</dd>
    </div>
  );
}
