import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getHiddenFields, requireUser } from "@/lib/rbac/server";
import { getTranscriptForUser } from "@/lib/transcripts/queries";
import { getGoogleAccount } from "@/lib/integrations/google";
import { GMAIL_SEND_SCOPE, hasScope } from "@/lib/integrations/core";
import { internalDomains } from "@/lib/integrations/directory";
import { isInternal, normalizeEmail } from "@/lib/integrations/matching-core";
import { fmtDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { TranscriptViewer } from "@/components/calls/transcript-viewer";
import { SummaryPanel, InsightPanels } from "@/components/calls/analysis-panels";
import { ApplyReview } from "@/components/calls/apply-review";
import { AttachDeal, AutoRefresh, ReanalyzeTranscriptButton } from "@/components/calls/call-controls";
import { SOURCE_LABELS, TranscriptStatus } from "@/components/calls/transcript-status";

export const metadata = { title: "Call" };

const FIELD_COLS = { muu: "muu", next_step: "nextStep", expected_close_date: "expectedCloseDate" } as const;

export default async function CallDetailPage({ params }: PageProps<"/calls/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const detail = await getTranscriptForUser(user, id);
  if (!detail) notFound();
  const { transcript: t, analysis, deal } = detail;

  const [acct, internal] = await Promise.all([getGoogleAccount(user.id), internalDomains(user.email)]);
  const followUpTo = [...new Set([...(detail.meeting?.attendees ?? []), ...t.participants].map((p) => normalizeEmail(p)).filter((e): e is string => Boolean(e)))]
    .filter((e) => !isInternal(e, internal))
    .slice(0, 5);
  const hiddenDeal = await getHiddenFields(user.role, "deal");
  const hiddenFields = (Object.keys(FIELD_COLS) as (keyof typeof FIELD_COLS)[]).filter((f) => hiddenDeal.has(FIELD_COLS[f]));
  const stages = detail.stages.filter((st) => (st.category === "open" || st.category === "hold") && !st.requiresApproval).map((st) => ({ id: st.id, name: st.name }));
  const busy = t.status === "pending" || t.status === "processing";

  return (
    <div>
      <AutoRefresh active={busy} />
      <Link href="/calls" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ChevronLeft className="size-3.5" /> Calls
      </Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-[28px] font-medium leading-9 text-fg">{t.title ?? "Untitled call"}</h1>
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
                    key={`${analysis.analyzedAt ?? ""}-${t.dealId ?? ""}-${t.appliedAt?.getTime() ?? 0}`}
                    id={t.id}
                    analysis={analysis}
                    deal={deal ? { id: deal.id, name: deal.name, stageId: deal.stageId, stageName: deal.stageName, muu: deal.muu, nextStep: deal.nextStep } : null}
                    stages={stages}
                    canEdit={detail.canEdit}
                    hiddenFields={hiddenFields}
                    canSendEmail={hasScope(acct?.scope, GMAIL_SEND_SCOPE)}
                    followUpTo={followUpTo}
                    appliedAt={t.appliedAt?.toISOString() ?? null}
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
        <Card className="h-fit overflow-hidden xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)]">
          <div className="flex h-full max-h-[70vh] flex-col xl:max-h-[calc(100vh-6rem)]">
            <div className="border-b border-border px-4 py-3">
              <p className="font-display text-base text-fg">Transcript</p>
            </div>
            <TranscriptViewer text={t.rawText} />
          </div>
        </Card>
      </div>
    </div>
  );
}
