"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, ExternalLink, FileText, Mail, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { EmailComposer } from "@/components/inbox/email-composer";
import { applyCallReview, saveCallDraft } from "@/lib/transcripts/actions";
import { gmailDraftUrl, type StoredDraft } from "@/lib/gmail/drafts-core";
import type { TranscriptAnalysis } from "@/lib/transcripts/analysis-core";
import { fmtNumber } from "@/lib/format";
import { matchStageName } from "@/lib/integrations/matching-core";
import { lineId } from "./transcript-viewer";

type Stage = { id: string; name: string };
type Deal = { id: string; name: string; stageId: string; stageName: string; muu: number | null; nextStep: string | null };

const FIELD_LABELS: Record<string, string> = { muu: "MUU", next_step: "Next step", expected_close_date: "Expected close date" };

function toDateInput(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

function matchStage(stages: Stage[], suggestion: string | null): string {
  const name = matchStageName(suggestion, stages.map((s) => s.name));
  return stages.find((s) => s.name === name)?.id ?? "";
}

/** What earlier "Apply selected" runs recorded on the analysis (src/lib/transcripts/apply.ts history). */
function appliedHistory(analysis: TranscriptAnalysis) {
  const raw = (analysis as TranscriptAnalysis & { applied?: unknown }).applied;
  const runs = Array.isArray(raw) ? (raw as { itemIds?: unknown; fieldKeys?: unknown }[]) : [];
  const ids = new Set<string>();
  const fields = new Set<string>();
  let legacy = false; // runs recorded before item ids were stored: we can't tell which items were applied
  for (const r of runs) {
    if (!Array.isArray(r.itemIds)) legacy = true;
    for (const x of Array.isArray(r.itemIds) ? r.itemIds : []) if (typeof x === "string") ids.add(x);
    for (const x of Array.isArray(r.fieldKeys) ? r.fieldKeys : []) if (typeof x === "string") fields.add(x);
  }
  return { ids, fields, legacy, any: runs.length > 0 };
}

/**
 * CALL-7 review screen: accept/edit/reject each task, field update, stage change and the follow-up draft.
 * QA-11: items already applied stay marked "Applied" and unchecked (re-applying is an explicit opt-in), and the AI
 * stage suggestion is never pre-selected.
 */
export function ApplyReview({
  id,
  analysis,
  deal,
  stages,
  canEdit,
  hiddenFields,
  canSendEmail,
  followUpTo,
  appliedAt,
  mode = "review",
  draft = null,
  canDraft = false,
}: {
  id: string;
  analysis: TranscriptAnalysis;
  deal: Deal | null;
  stages: Stage[];
  canEdit: boolean;
  hiddenFields: string[];
  canSendEmail: boolean;
  followUpTo: string[];
  appliedAt: string | null;
  /** The owner's autopilot.postCall preference (V2 A1): "review" adds the one-click "Apply all + draft". */
  mode?: "off" | "review" | "auto";
  /** Follow-up draft already saved for this call (Gmail or in-app). */
  draft?: StoredDraft | null;
  /** Only the call owner can save a draft into their own mailbox. */
  canDraft?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [history] = useState(() => appliedHistory(analysis));
  const wasApplied = (itemId: string) => history.ids.has(itemId) || (history.legacy && Boolean(appliedAt));
  const [items, setItems] = useState(
    analysis.action_items.map((a) => ({ ...a, include: !wasApplied(a.id), applied: wasApplied(a.id), dueInput: toDateInput(a.due) })),
  );
  const [fields, setFields] = useState(
    analysis.field_updates
      .filter((f) => !hiddenFields.includes(f.field))
      .map((f) => ({ ...f, applied: history.fields.has(f.field), include: Boolean(deal) && !history.fields.has(f.field) && !(history.legacy && appliedAt) })),
  );
  const suggestedStageId = matchStage(stages, analysis.suggested_stage.stage);
  const [stageOn, setStageOn] = useState(false);
  const [stageId, setStageId] = useState(suggestedStageId || "");
  const [draftOpen, setDraftOpen] = useState(false);

  const chosenTasks = items.filter((i) => i.include && i.task.trim());
  const chosenFields = deal ? fields.filter((f) => f.include && f.value.trim()) : [];
  const stageChange = deal && stageOn && stageId && stageId !== deal.stageId ? stageId : null;
  const total = chosenTasks.length + chosenFields.length + (stageChange ? 1 : 0);

  const followUp = analysis.follow_up_email_draft;
  const draftBlocked = draft?.status === "blocked";

  /** Save the follow-up as a Gmail draft (in-app when Gmail compose isn't granted or the guardrail flags it). */
  async function saveDraft(): Promise<boolean> {
    const r = await saveCallDraft({ id, to: draft?.to.length ? draft.to : followUpTo, subject: draft?.subject ?? followUp.subject, body: draft?.body ?? followUp.body });
    if (!r.ok) {
      toast.error(r.error);
      return false;
    }
    if (r.data.location === "gmail") toast.success("Follow-up saved to your Gmail drafts. Nothing was sent.");
    else if (r.data.status !== "ok") toast.warning("Follow-up kept here for review — the claims/MNPI check flagged it.");
    else if (r.data.needsReconnect) toast.message("Draft saved here. Reconnect Gmail to get drafts in Gmail.");
    else toast.success("Draft saved here.");
    return true;
  }

  function applyAllAndDraft() {
    start(async () => {
      if (total > 0 && !(await runApply())) return;
      await saveDraft();
      router.refresh();
    });
  }

  function saveDraftOnly() {
    start(async () => {
      if (await saveDraft()) router.refresh();
    });
  }

  async function runApply(): Promise<boolean> {
    const r = await applyCallReview({
      id,
      actionItems: chosenTasks.map((i) => ({
        task: i.task.trim(),
        owner: i.owner || "us",
        due: i.dueInput ? new Date(`${i.dueInput}T17:00:00Z`).toISOString() : null,
        evidence: i.evidence,
        timestamp: i.timestamp,
        itemId: i.id,
      })),
      fieldUpdates: chosenFields.map((f) => ({ field: f.field, value: f.value.trim() })),
      stageId: stageChange,
    });
    if (!r.ok) {
      toast.error(r.error);
      return false;
    }
    toast.success(
      `Applied: ${r.data.tasks} task${r.data.tasks === 1 ? "" : "s"}${r.data.fields ? `, ${r.data.fields} field update${r.data.fields === 1 ? "" : "s"}` : ""}${r.data.stageChanged ? ", stage moved" : ""}.`,
    );
    // Mark what was just applied right away so a second click can't duplicate it.
    const doneIds = new Set(chosenTasks.map((i) => i.id));
    const doneFields = new Set(chosenFields.map((f) => f.field));
    setItems((xs) => xs.map((x) => (doneIds.has(x.id) ? { ...x, include: false, applied: true } : x)));
    setFields((xs) => xs.map((x) => (doneFields.has(x.field) ? { ...x, include: false, applied: true } : x)));
    setStageOn(false);
    return true;
  }

  function apply() {
    start(async () => {
      if (await runApply()) router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {appliedAt ? (
        <p className="flex items-center gap-2 text-xs text-secondary">
          <StatusBadge status="good" label="Applied" /> Items from this call were applied. Applying again creates additional tasks.
        </p>
      ) : null}

      <section aria-labelledby="ai-tasks">
        <h4 id="ai-tasks" className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">
          Action items <span className="tabular">({items.length})</span>
        </h4>
        {items.length === 0 ? <p className="text-sm text-muted">No action items were found.</p> : null}
        <ul className="space-y-2">
          {items.map((it, i) => (
            <li key={it.id} className={`rounded-md border px-3 py-2.5 ${it.include ? "border-border-strong" : "border-border opacity-60"}`}>
              {it.applied ? (
                <p className="mb-1.5 flex items-center gap-2 text-[11px] text-muted">
                  <StatusBadge status="good" label="Applied" /> Task created — tick again only if you want a duplicate.
                </p>
              ) : null}
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-2 size-4 accent-white"
                  checked={it.include}
                  disabled={!canEdit}
                  aria-label={`Include “${it.task}”`}
                  onChange={(e) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))}
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <Input
                    value={it.task}
                    disabled={!canEdit}
                    aria-label="Task"
                    onChange={(e) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, task: e.target.value } : x)))}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <NativeSelect
                      aria-label="Owner"
                      className="h-8 w-auto text-xs"
                      disabled={!canEdit}
                      value={it.owner === "us" || it.owner === "them" ? it.owner : "named"}
                      onChange={(e) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, owner: e.target.value === "named" ? it.owner : e.target.value } : x)))}
                    >
                      <option value="us">We owe</option>
                      <option value="them">They owe</option>
                      {it.owner !== "us" && it.owner !== "them" ? <option value="named">{it.owner}</option> : null}
                    </NativeSelect>
                    <Input
                      type="date"
                      aria-label="Due date"
                      className="h-8 w-40 text-xs"
                      disabled={!canEdit}
                      value={it.dueInput}
                      onChange={(e) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, dueInput: e.target.value } : x)))}
                    />
                    {it.timestamp ? (
                      <a href={`#${lineId(it.timestamp.length === 5 ? `00:${it.timestamp}` : it.timestamp)}`} className="font-mono text-[11px] text-muted hover:text-fg">
                        @{it.timestamp}
                      </a>
                    ) : null}
                  </div>
                  {it.evidence ? <blockquote className="border-l border-border-strong pl-2 text-xs italic text-secondary">“{it.evidence}”</blockquote> : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ai-fields">
        <h4 id="ai-fields" className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">
          Deal updates
        </h4>
        {!deal ? (
          <p className="text-sm text-muted">Attach a deal to apply field and stage updates.</p>
        ) : (
          <ul className="space-y-2">
            {fields.map((f, i) => (
              <li key={`${f.field}-${i}`} className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
                <input
                  type="checkbox"
                  className="size-4 accent-white"
                  checked={f.include}
                  disabled={!canEdit}
                  aria-label={`Update ${FIELD_LABELS[f.field]}`}
                  onChange={(e) => setFields((xs) => xs.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))}
                />
                <span className="w-28 text-xs text-secondary">
                  {FIELD_LABELS[f.field] ?? f.field}
                  {f.applied ? <span className="block text-[10px] text-muted">applied</span> : null}
                </span>
                <span className="text-xs text-muted">
                  {f.field === "muu" ? fmtNumber(deal.muu) : f.field === "next_step" ? (deal.nextStep ?? "—") : "—"} →
                </span>
                <Input
                  className="h-8 min-w-40 flex-1 text-xs"
                  value={f.value}
                  disabled={!canEdit}
                  aria-label={`New ${FIELD_LABELS[f.field]}`}
                  onChange={(e) => setFields((xs) => xs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                />
                {f.evidence ? <p className="w-full pl-7 text-xs italic text-secondary">“{f.evidence}”</p> : null}
              </li>
            ))}
            <li className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
              <input type="checkbox" className="size-4 accent-white" checked={stageOn} disabled={!canEdit || !stages.length} aria-label="Move stage" onChange={(e) => setStageOn(e.target.checked)} />
              <span className="w-28 text-xs text-secondary">Stage</span>
              <span className="text-xs text-muted">{deal.stageName} →</span>
              <NativeSelect className="h-8 w-auto min-w-40 text-xs" value={stageId} disabled={!canEdit} aria-label="New stage" onChange={(e) => setStageId(e.target.value)}>
                <option value="">Choose stage…</option>
                {stages.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </NativeSelect>
              {analysis.suggested_stage.stage ? (
                <Badge title={analysis.suggested_stage.reason}>
                  AI suggests “{analysis.suggested_stage.stage}” · {Math.round(analysis.suggested_stage.confidence * 100)}%
                </Badge>
              ) : null}
            </li>
          </ul>
        )}
      </section>

      <section aria-labelledby="ai-email">
        <div className="mb-2 flex items-center justify-between">
          <h4 id="ai-email" className="text-xs font-medium uppercase tracking-wider text-muted">
            Follow-up email
          </h4>
          {analysis.follow_up_email_draft.claims_check === "flagged" ? (
            <StatusBadge status="warning" label="Claims check flagged" />
          ) : analysis.follow_up_email_draft.claims_check === "pass" ? (
            <StatusBadge status="good" label="Claims check passed" />
          ) : null}
        </div>
        {draft ? <DraftStatus draft={draft} /> : null}
        {draftOpen ? (
          <div className="rounded-md border border-border-strong p-3">
            <EmailComposer
              dealId={deal?.id ?? null}
              defaultTo={draft?.to.length ? draft.to : followUpTo}
              defaultSubject={draft?.subject ?? analysis.follow_up_email_draft.subject}
              defaultBody={draft?.body ?? analysis.follow_up_email_draft.body}
              canSend={canSendEmail}
              onCancel={() => setDraftOpen(false)}
              onSent={() => setDraftOpen(false)}
            />
          </div>
        ) : (
          <div className="space-y-2 rounded-md border border-border px-3 py-2.5">
            <p className="text-sm font-medium text-fg">{draft?.subject ?? followUp.subject}</p>
            <p className="line-clamp-4 whitespace-pre-wrap text-xs text-secondary">{draft?.body ?? followUp.body}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setDraftOpen(true)}>
                <Mail /> Edit & send
              </Button>
              {canDraft && !(draft?.location === "gmail") ? (
                <Button size="sm" variant="ghost" disabled={pending || draftBlocked} onClick={saveDraftOnly} title={draftBlocked ? "Edit & send — a banned claim must be removed first" : undefined}>
                  <FileText /> Save as Gmail draft
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </section>

      {canEdit ? (
        <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-1 px-5 py-3">
          <p className="text-xs text-muted">
            {total ? `${total} item${total === 1 ? "" : "s"} selected` : "Nothing selected"}
            <span className="hidden md:inline"> · tasks are created with origin “call AI” and linked evidence · drafts are never sent</span>
          </p>
          <div className="flex shrink-0 gap-2">
            {mode !== "off" && canDraft && !(draft?.location === "gmail") ? (
              <>
                <Button variant="secondary" size="sm" disabled={pending || total === 0} onClick={apply}>
                  <CheckCheck /> <span className="hidden sm:inline">Apply selected</span><span className="sm:hidden">Apply</span>
                </Button>
                <Button variant="primary" size="sm" disabled={pending || (total === 0 && draftBlocked)} onClick={applyAllAndDraft} title="Apply the checked items and save the follow-up as a Gmail draft (never sent)">
                  <Sparkles /> {pending ? "Working…" : total ? "Apply all + draft" : "Save draft"}
                </Button>
              </>
            ) : (
              <Button variant="primary" size="sm" disabled={pending || total === 0} onClick={apply}>
                <CheckCheck /> {pending ? "Applying…" : "Apply selected"}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted">Read-only — only the call owner or their manager can apply these.</p>
      )}
    </div>
  );
}

/** Where the follow-up draft lives + what the guardrails said. */
function DraftStatus({ draft }: { draft: StoredDraft }) {
  return (
    <div className="mb-2 space-y-1.5 rounded-md border border-border bg-surface-2/40 px-3 py-2 text-xs">
      {draft.location === "gmail" ? (
        <p className="flex flex-wrap items-center gap-2 text-secondary">
          <StatusBadge status="good" label="In your Gmail drafts" /> Review and send it from Gmail — nothing was sent.
          <a href={gmailDraftUrl(draft.gmailDraftId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-fg underline-offset-2 hover:underline">
            Open Gmail <ExternalLink className="size-3" aria-hidden />
          </a>
        </p>
      ) : draft.status !== "ok" ? (
        <p className="flex flex-wrap items-center gap-2 text-secondary">
          <StatusBadge status={draft.status === "blocked" ? "critical" : "warning"} label={draft.status === "blocked" ? "Blocked by claims policy" : "Kept here for review"} />
          Edit it below before sending.
        </p>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-secondary">
          <StatusBadge status="info" label="Draft saved here" />
          {draft.needsRecipients ? (
            "No verified recipient — add who it's for, then save it to Gmail or send."
          ) : draft.needsReconnect ? (
            <a href="/settings#connections" className="text-fg underline underline-offset-2">
              Reconnect Gmail to get drafts in Gmail
            </a>
          ) : (
            "Edit & send when ready."
          )}
        </p>
      )}
      {draft.unverified?.length ? (
        <p className="text-muted">Not added (not a known contact or attendee): {draft.unverified.join(", ")}</p>
      ) : null}
      {draft.warnings.length ? (
        <ul className="list-disc space-y-0.5 pl-4 text-secondary">
          {draft.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
