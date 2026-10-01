import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getHiddenFields, requireUser } from "@/lib/rbac/server";
import { getTranscriptForUser } from "@/lib/transcripts/queries";
import { getGoogleAccount } from "@/lib/integrations/google";
import { GMAIL_SEND_SCOPE, hasScope } from "@/lib/integrations/core";
import { followUpRecipients } from "@/lib/transcripts/drafts";
import { fmtDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { TranscriptViewer } from "@/components/calls/transcript-viewer";
import { AddToPlaybook } from "@/components/team/add-to-playbook";
import { SummaryPanel, InsightPanels } from "@/components/calls/analysis-panels";
import { ApplyReview } from "@/components/calls/apply-review";
import { AttachDeal, AutoRefresh, ReanalyzeTranscriptButton } from "@/components/calls/call-controls";
import { SOURCE_LABELS, TranscriptStatus } from "@/components/calls/transcript-status";
import { AutopilotBanner, type AutopilotView } from "@/components/calls/autopilot-banner";
import { getPrefs } from "@/lib/prefs";
import { AUTOPILOT_UNDO_MS, undoAvailable, type AutopilotRecord } from "@/lib/transcripts/autopilot-core";
import type { StoredDraft } from "@/lib/gmail/drafts-core";

// One load per request, shared by generateMetadata and the page (QA-27 record-named tab titles).
const loadCall = cache(async (id: string) => (/^[0-9a-f-]{36}$/i.test(id) ? getTranscriptForUser(await requireUser(), id) : null));

export async function generateMetadata({ params }: PageProps<"/calls/[id]">) {
  const d = await loadCall((await params).id);
  return { title: d?.transcript.title ? `${d.transcript.title} · Call` : "Call" };
}

const FIELD_COLS = { muu: "muu", next_step: "nextStep", expected_close_date: "expectedCloseDate" } as const;

export default async function CallDetailPage({ params }: PageProps<"/calls/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const detail = await loadCall(id);
  if (!detail) notFound();
  const { transcript: t, analysis, deal } = detail;

  // SEC L-8: only calendar attendees and visible CRM contacts pre-fill the follow-up; other transcript names don't
  const [acct, rcpt] = await Promise.all([getGoogleAccount(user.id), followUpRecipients(t, user)]);
  const followUpTo = rcpt.to;
  const hiddenDeal = await getHiddenFields(user.role, "deal");
  const hiddenFields = (Object.keys(FIELD_COLS) as (keyof typeof FIELD_COLS)[]).filter((f) => hiddenDeal.has(FIELD_COLS[f]));
  const stages = detail.stages.filter((st) => (st.category === "open" || st.category === "hold") && !st.requiresApproval).map((st) => ({ id: st.id, name: st.name }));
  const busy = t.status === "pending" || t.status === "processing";
  // QA MAJ-13: the autopilot mode is the call OWNER's setting, not the viewer's (a manager sees the rep's mode)
  const prefs = await getPrefs(t.uploadedBy ?? user.id);
  const extra = (analysis ?? {}) as { autopilot?: AutopilotRecord; draft?: StoredDraft };
  const isOwner = t.uploadedBy === user.id;
  const ap = extra.autopilot;
  const autopilotView: AutopilotView | null = ap
    ? {
        status: ap.status,
        reason: ap.reason ?? null,
        at: ap.at,
        tasks: ap.taskIds.length,
        nextStep: ap.nextStep?.after.text ?? null,
        undoUntil: undoAvailable(ap.at, ap.undoneAt, new Date()) ? new Date(new Date(ap.at).getTime() + AUTOPILOT_UNDO_MS).toISOString() : null,
      }
    : null;
  // Drafts live in the call owner's mailbox: only the owner sees the stored draft body.
  const draft = isOwner ? (extra.draft ?? null) : null;

  return (
    <div>
      <AutoRefresh active={busy} />
      <Link href="/calls" className="-my-2 mb-1 inline-flex items-center gap-1 py-2 text-xs text-muted hover:text-fg">
        <ChevronLeft className="size-3.5" /> Calls
      </Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-words font-display text-2xl font-medium leading-8 text-fg sm:text-[28px] sm:leading-9">{t.title ?? "Untitled call"}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span className="tabular">{fmtDate(t.occurredAt ?? t.createdAt, "EEE d MMM yyyy, HH:mm")}</span>
            {t.durationMin ? <span>· {t.durationMin} min</span> : null}
            <Badge>{SOURCE_LABELS[t.source] ?? t.source}</Badge>
            <TranscriptStatus status={t.status} />
            {detail.uploaderName ? <span>· {t.uploadedBy === user.id ? "Your call" : detail.uploaderName}</span> : null}
          </div>
          <p className="mt-2 text-sm text-secondary">
            Deal:{" "}
            {deal ? (
              <Link href={`/deals/${deal.id}`} className="text-fg hover:underline">
                {deal.name}
              </Link>
            ) : t.dealId ? (
              "Linked (no access)"
            ) : (
              <span className="text-muted">not attached</span>
            )}
            {detail.accountName ? <span className="text-muted"> · {detail.accountName}</span> : null}
          </p>
        </div>
        {detail.canEdit ? (
          <div className="flex flex-wrap gap-2">
            <AttachDeal id={t.id} deal={deal ? { id: deal.id, name: deal.name } : null} />
            {!busy ? <ReanalyzeTranscriptButton id={t.id} /> : null}
          </div>
        ) : null}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-6">
          {busy ? (
            <Card>
              <CardContent className="py-10 text-center">
                <p className="font-display text-lg text-fg">Analyzing the call…</p>
                <p className="mt-1 text-sm text-muted">Summary, action items and a follow-up draft usually take under a minute.</p>
              </CardContent>
            </Card>
          ) : t.status === "failed" || !analysis ? (
            <EmptyState
              title="Analysis failed"
              description={t.error ?? "Something went wrong analyzing this transcript."}
              action={detail.canEdit ? <ReanalyzeTranscriptButton id={t.id} label="Try again" /> : undefined}
            />
          ) : (
            <>
              {autopilotView ? <AutopilotBanner id={t.id} view={autopilotView} canUndo={isOwner} /> : null}
              <Card>
                <CardHeader>
                  <CardTitle>Summary</CardTitle>
                </CardHeader>
                <CardContent>
                  <SummaryPanel a={analysis} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Review &amp; apply</CardTitle>
                    <CardDescription>Accept, edit or reject each item. Nothing is changed until you apply.</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="pb-0">
                  <ApplyReview
                    key={`${analysis.analyzedAt ?? ""}-${t.dealId ?? ""}-${t.appliedAt?.getTime() ?? 0}-${draft?.createdAt ?? ""}`}
                    id={t.id}
                    analysis={analysis}
                    deal={deal ? { id: deal.id, name: deal.name, stageId: deal.stageId, stageName: deal.stageName, muu: deal.muu, nextStep: deal.nextStep } : null}
                    stages={stages}
                    canEdit={detail.canEdit}
                    hiddenFields={hiddenFields}
                    canSendEmail={hasScope(acct?.scope, GMAIL_SEND_SCOPE)}
                    followUpTo={followUpTo}
                    appliedAt={t.appliedAt?.toISOString() ?? null}
                    mode={prefs.autopilot.postCall ?? "review"}
                    draft={draft}
                    canDraft={isOwner && detail.canEdit}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Insights</CardTitle>
                </CardHeader>
                <CardContent>
                  <InsightPanels a={analysis} />
                </CardContent>
              </Card>
            </>
          )}
        </div>
        <Card className="h-fit overflow-hidden xl:sticky xl:top-20 xl:max-h-[calc(100dvh-6rem)]">
          <div className="flex h-full max-h-[70dvh] flex-col xl:max-h-[calc(100dvh-6rem)]">
            <div className="border-b border-border px-4 py-3">
              <p className="font-display text-base text-fg">Transcript</p>
            </div>
            <AddToPlaybook transcriptId={t.id} className="flex min-h-0 flex-1 flex-col">
              <TranscriptViewer text={t.rawText} />
            </AddToPlaybook>
          </div>
        </Card>
      </div>
    </div>
  );
}
