import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { looksLikeInjection } from "@/lib/copilot/guards";
import { notify } from "@/lib/notifications/notify";
import { getPrefs } from "@/lib/prefs";
import { ForbiddenError, loadAppUserById, type AppUser } from "@/lib/rbac/server";
import { isSensitive } from "@/lib/notifications/sensitive";
import { loadDealForWrite, logActivity, recomputeDealHealth } from "@/lib/deals/service";
import { businessDeadline } from "@/lib/time";
import type { TranscriptAnalysis } from "./analysis-core";
import { autopilotSummary, nextStepUntouched, planAutoApply, taskStillAutopilots, undoAvailable, type AutopilotRecord } from "./autopilot-core";
import { deleteGmailDraft, followUpRecipients, saveFollowUpDraft, setAnalysisKey } from "./drafts";
import type { StoredDraft } from "@/lib/gmail/drafts-core";

/**
 * V2 A1 zero-touch post-call. Runs after a transcript linked to a deal is analyzed, as the call owner, when their
 * `autopilot.postCall` is "auto":
 *   tasks with evidence + next step & due + one activity  →  applied (undo for 24 h)
 *   stage                                                 →  only as a deal signal (never moved here)
 *   follow-up                                             →  Gmail draft (or in-app draft) — never sent
 * Idempotent: the transcript's `applied_at` is claimed first, so a re-analysis, a second sync or a manual Apply never
 * double-applies. Never throws into the caller.
 */
export async function runPostCallAutopilot(transcriptId: string): Promise<AutopilotRecord | null> {
  try {
    const [t] = await db.select().from(s.transcripts).where(eq(s.transcripts.id, transcriptId));
    if (!t || t.status !== "ready" || !t.dealId || !t.uploadedBy || t.appliedAt) return null;
    const analysis = t.analysis as (TranscriptAnalysis & { autopilot?: AutopilotRecord }) | null;
    if (!analysis?.action_items || analysis.autopilot) return null;
    const prefs = await getPrefs(t.uploadedBy);
    if (prefs.autopilot.postCall !== "auto") return null;

    const owner = await loadAppUserById(t.uploadedBy);
    if (!owner) return null;
    const skip = async (reason: string, message: string) => {
      const rec: AutopilotRecord = { status: "skipped", reason, at: new Date().toISOString(), by: owner.id, taskIds: [], itemIds: [], nextStep: null };
      await setAnalysisKey(t.id, "autopilot", rec);
      await notify(owner.id, { kind: "system", title: `Call${t.title ? ` “${t.title.slice(0, 80)}”` : ""} needs a review`, body: message, href: `/calls/${t.id}`, sensitive: await isSensitive(t) });
      return rec;
    };

    // SEC: transcripts are untrusted. Text that tries to steer the AI downgrades auto → review.
    if (looksLikeInjection(t.rawText)) return await skip("untrusted", "The transcript contains instruction-like text, so nothing was applied automatically. Review and apply it yourself.");

    let ctx: Awaited<ReturnType<typeof loadDealForWrite>>;
    try {
      ctx = await loadDealForWrite(owner, t.dealId, "edit");
    } catch {
      return await skip("no_access", "You can't edit the linked deal, so nothing was applied automatically.");
    }

    // Claim (idempotency): only one runner gets past this line.
    const [claimed] = await db
      .update(s.transcripts)
      .set({ appliedAt: new Date() })
      .where(and(eq(s.transcripts.id, t.id), isNull(s.transcripts.appliedAt)))
      .returning({ id: s.transcripts.id });
    if (!claimed) return null;

    const plan = planAutoApply(analysis, { defaultDue: businessDeadline(t.occurredAt ?? new Date(), 3, owner.timezone) });
    const ourFirst = owner.name.toLowerCase().split(/\s+/)[0] ?? "";
    const taskIds: string[] = [];
    const taskTitles: Record<string, string> = {};
    for (const a of plan.tasks) {
      const ownerLc = a.owner.trim().toLowerCase();
      const theirs = ownerLc === "them" || (ownerLc !== "us" && ownerLc !== "" && !ownerLc.includes(ourFirst));
      const title = (theirs ? `Waiting on ${a.owner === "them" ? "them" : a.owner}: ${a.task}` : a.task).slice(0, 240);
      const evidenceSource = `transcript:${t.id}${a.timestamp ? `@${a.timestamp}` : ""}`;
      const [dup] = await db.select({ id: s.tasks.id }).from(s.tasks).where(and(eq(s.tasks.evidenceSource, evidenceSource), eq(s.tasks.title, title))).limit(1);
      if (dup) continue;
      const [row] = await db
        .insert(s.tasks)
        .values({
          title,
          dueAt: a.due ? new Date(a.due) : null,
          assigneeId: owner.id,
          createdBy: owner.id,
          dealId: t.dealId,
          accountId: t.accountId,
          origin: "call_ai",
          owedBy: theirs ? "them" : "us",
          evidence: a.evidence || null,
          evidenceSource,
        })
        .returning({ id: s.tasks.id });
      taskIds.push(row!.id);
      taskTitles[row!.id] = title;
    }

    let nextStep: AutopilotRecord["nextStep"] = null;
    const hidden = ctx.hidden.has("nextStep") || ctx.hidden.has("*");
    if (plan.nextStep && !hidden) {
      const before = { text: ctx.deal.nextStep, due: ctx.deal.nextStepDueAt?.toISOString() ?? null };
      await db.update(s.deals).set({ nextStep: plan.nextStep.text, nextStepDueAt: new Date(plan.nextStep.due) }).where(eq(s.deals.id, t.dealId));
      nextStep = { before, after: { text: plan.nextStep.text, due: plan.nextStep.due } };
    }

    // Follow-up draft (claims + MNPI scanned inside; never sent).
    let draftKind: "gmail" | "app" | "flagged" | "needs_recipients" | null = null;
    const d = analysis.follow_up_email_draft;
    if (d?.body?.trim()) {
      const rcpt = await followUpRecipients(t, owner);
      const draft = await saveFollowUpDraft(owner, t.id, { to: rcpt.to, subject: d.subject, body: d.body, unverified: rcpt.unverified }, { auto: true });
      // QA MIN-22: be honest — no recipient means the draft is in-app, not "drafted in Gmail"
      draftKind = draft.status !== "ok" ? "flagged" : draft.needsRecipients ? "needs_recipients" : draft.location;
    }

    const rec: AutopilotRecord = {
      status: "applied",
      at: new Date().toISOString(),
      by: owner.id,
      taskIds,
      itemIds: plan.tasks.map((x) => x.itemId),
      nextStep,
      taskTitles,
    };
    await setAnalysisKey(t.id, "autopilot", rec);
    // Keep the review screen in sync: the same history entry a manual Apply writes.
    await db
      .update(s.transcripts)
      .set({
        analysis: sql`jsonb_set(coalesce(${s.transcripts.analysis}, '{}'::jsonb), '{applied}', coalesce(${s.transcripts.analysis}->'applied', '[]'::jsonb) || ${JSON.stringify([
          { at: rec.at, by: owner.id, taskIds, itemIds: rec.itemIds, fieldKeys: nextStep ? ["next_step"] : [], stageId: null, auto: true },
        ])}::jsonb)`,
      })
      .where(eq(s.transcripts.id, t.id));

    const summary = autopilotSummary({ who: ctx.deal.name, tasks: taskIds.length, nextStep: Boolean(nextStep), draft: draftKind });
    await logActivity({
      type: "agent",
      source: "agent",
      subject: summary,
      body: [nextStep ? `Next step: ${nextStep.after.text}` : null, taskIds.length ? `${taskIds.length} task${taskIds.length === 1 ? "" : "s"} created from the call` : null].filter(Boolean).join("\n") || null,
      actorId: owner.id,
      dealId: t.dealId,
      accountId: t.accountId,
      transcriptId: t.id,
      metadata: { autopilot: true, taskIds },
    });
    await audit({
      actorId: owner.id,
      actorKind: "agent",
      action: "transcript.autopilot_apply",
      entity: "transcript",
      entityId: t.id,
      after: { dealId: t.dealId, tasks: taskIds.length, nextStep: nextStep?.after ?? null, draft: draftKind },
    });
    await recomputeDealHealth(t.dealId);
    await notify(owner.id, { kind: "system", title: summary, body: "Review the call to undo within 24 hours.", href: `/calls/${t.id}`, sensitive: await isSensitive(t) });
    return rec;
  } catch (e) {
    console.error("[autopilot] post-call failed", (e as Error).message?.split("\nparams:")[0]?.slice(0, 200));
    return null;
  }
}

/** Undo the auto-applied changes (24 h): cancel still-open auto tasks, restore the previous next step if untouched since. */
export async function undoPostCallAutopilot(user: AppUser, transcriptId: string): Promise<{ tasks: number; nextStepRestored: boolean; draftRemoved: boolean }> {
  const [t] = await db.select().from(s.transcripts).where(eq(s.transcripts.id, transcriptId));
  if (!t) throw new UserError("Transcript not found.");
  const analysis = (t.analysis ?? {}) as { autopilot?: AutopilotRecord; applied?: { auto?: boolean; at?: string }[] };
  const rec = analysis.autopilot;
  if (!rec || rec.status !== "applied") throw new UserError("There's nothing automatic to undo on this call.");
  if (!undoAvailable(rec.at, rec.undoneAt, new Date())) throw new UserError("The 24-hour undo window has passed. Change the deal and tasks directly.");
  if (rec.by !== user.id && t.uploadedBy !== user.id) throw new ForbiddenError("Only the call owner can undo the autopilot.");

  let tasks = 0;
  if (rec.taskIds.length) {
    // CR L4: leave tasks the rep has since reassigned or renamed — they're the rep's now
    const rows = await db
      .select({ id: s.tasks.id, status: s.tasks.status, assigneeId: s.tasks.assigneeId, title: s.tasks.title })
      .from(s.tasks)
      .where(and(inArray(s.tasks.id, rec.taskIds), eq(s.tasks.origin, "call_ai")));
    const ids = rows.filter((r) => taskStillAutopilots(r, rec.by, rec.taskTitles?.[r.id])).map((r) => r.id);
    if (ids.length) {
      const cancelled = await db
        .update(s.tasks)
        .set({ status: "cancelled" })
        .where(and(inArray(s.tasks.id, ids), eq(s.tasks.status, "open")))
        .returning({ id: s.tasks.id });
      tasks = cancelled.length;
    }
  }
  let nextStepRestored = false;
  if (rec.nextStep && t.dealId) {
    const ctx = await loadDealForWrite(user, t.dealId, "edit");
    // Only when nobody changed it since — text AND due date (CR L4); otherwise the user's later edit wins.
    if (nextStepUntouched({ text: ctx.deal.nextStep, due: ctx.deal.nextStepDueAt }, rec.nextStep.after)) {
      await db
        .update(s.deals)
        .set({ nextStep: rec.nextStep.before.text, nextStepDueAt: rec.nextStep.before.due ? new Date(rec.nextStep.before.due) : null })
        .where(eq(s.deals.id, t.dealId));
      nextStepRestored = true;
    }
  }
  // QA MIN-22: the auto-created Gmail draft goes too (a draft the rep already sent or edited away is simply gone)
  const draft = (t.analysis as { draft?: StoredDraft } | null)?.draft;
  let draftRemoved = false;
  if (draft?.auto && draft.location === "gmail" && draft.gmailDraftResourceId && t.uploadedBy) draftRemoved = await deleteGmailDraft(t.uploadedBy, draft.gmailDraftResourceId);
  if (draftRemoved && draft) await setAnalysisKey(t.id, "draft", { ...draft, location: "app", gmailDraftId: null, gmailDraftResourceId: null });
  const undone: AutopilotRecord = { ...rec, status: "undone", undoneAt: new Date().toISOString(), undoneBy: user.id };
  await setAnalysisKey(t.id, "autopilot", undone);
  const history = Array.isArray(analysis.applied) ? analysis.applied.filter((h) => !(h.auto && h.at === rec.at)) : [];
  await db
    .update(s.transcripts)
    .set({
      appliedAt: history.length ? t.appliedAt : null,
      analysis: sql`jsonb_set(coalesce(${s.transcripts.analysis}, '{}'::jsonb), '{applied}', ${JSON.stringify(history)}::jsonb)`,
    })
    .where(eq(s.transcripts.id, t.id));
  if (t.dealId) {
    await logActivity({ type: "agent", source: "agent", subject: "Post-call autopilot undone", body: `${tasks} task${tasks === 1 ? "" : "s"} cancelled${nextStepRestored ? ", next step restored" : ""}`, actorId: user.id, dealId: t.dealId, accountId: t.accountId, transcriptId: t.id, metadata: { autopilot: true, undo: true } });
    await recomputeDealHealth(t.dealId);
  }
  await audit({ actorId: user.id, action: "transcript.autopilot_undo", entity: "transcript", entityId: t.id, before: { taskIds: rec.taskIds, nextStep: rec.nextStep?.after ?? null }, after: { tasks, nextStepRestored, draftRemoved } });
  return { tasks, nextStepRestored, draftRemoved };
}
