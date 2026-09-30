import "server-only";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { notify } from "@/lib/notifications/notify";
import { aiAvailable, aiObject, modelFor, untrusted } from "@/lib/ai";
import { audit } from "@/lib/audit";
import { getSetting } from "@/lib/settings";
import { autonomyLevel } from "@/lib/integrations/core";
import { getPrefs } from "@/lib/integrations/store";
import { dealStageNames } from "@/lib/integrations/directory";
import {
  emailAnalysisAiSchema,
  emailAnalysisPrompt,
  heuristicEmailAnalysis,
  normalizeAiEmailAnalysis,
  type Commitment,
  type EmailAnalysis,
  type EmailAnalysisInput,
} from "./analysis-core";
import { stripQuoted } from "./parse";
import { refreshThreadState } from "./ingest";
import { recomputeDealHealth } from "@/lib/deals/service";

export type StoredEmailAnalysis = EmailAnalysis & {
  suggestedDealId?: string | null;
  /** index in commitments[] → created task id */
  taskIds?: Record<string, string>;
  nextStepUpdated?: boolean;
  /** SEC M-11: next step proposed from an inbound (untrusted) email — shown for the user to apply, never auto-applied. */
  nextStepSuggestion?: { text: string; due: string } | null;
};

/** Run AI (fast tier) with heuristic fallback. Email text is always wrapped as untrusted. */
export async function runEmailAnalysis(input: EmailAnalysisInput, owner: { id: string; name: string }): Promise<EmailAnalysis> {
  if (!input.text.trim()) return heuristicEmailAnalysis(input);
  if (aiAvailable()) {
    try {
      const model = await modelFor("fast");
      const ai = await aiObject({
        kind: "email_analysis",
        userId: owner.id,
        tier: "fast",
        schema: emailAnalysisAiSchema,
        prompt: emailAnalysisPrompt(input, untrusted("email", input.text, 20_000), owner.name),
      });
      return normalizeAiEmailAnalysis(ai, input, model);
    } catch {
      /* fall through to heuristic (failure already logged in agent_runs) */
    }
  }
  return heuristicEmailAnalysis(input);
}

/** Create a task from an extracted commitment (dedupes on evidenceSource + title). Returns the task id. */
export async function createCommitmentTask(opts: {
  commitment: Commitment;
  messageRowId: string;
  assigneeId: string;
  createdBy: string;
  dealId: string | null;
  accountId: string | null;
}): Promise<string> {
  const c = opts.commitment;
  const title = (c.by === "us" ? c.text : `Waiting on ${c.person}: ${c.text}`).slice(0, 240);
  const evidenceSource = `email:${opts.messageRowId}`;
  const [dup] = await db
    .select({ id: s.tasks.id })
    .from(s.tasks)
    .where(and(eq(s.tasks.evidenceSource, evidenceSource), eq(s.tasks.title, title), ne(s.tasks.status, "cancelled")))
    .limit(1);
  if (dup) return dup.id;
  const [t] = await db
    .insert(s.tasks)
    .values({
      title,
      description: c.by === "them" ? "Their commitment — follow up if it slips." : null,
      dueAt: c.due ? new Date(c.due) : null,
      assigneeId: opts.assigneeId,
      createdBy: opts.createdBy,
      dealId: opts.dealId,
      accountId: opts.accountId,
      origin: "email_ai",
      owedBy: c.by,
      evidence: c.evidence.slice(0, 1000),
      evidenceSource,
    })
    .returning({ id: s.tasks.id });
  if (opts.dealId) await recomputeDealHealth(opts.dealId);
  return t!.id;
}

/**
 * Analyze one stored message and apply results per autonomy settings (§11.4):
 * - task_from_commitment ≥2 → tasks created automatically (+ in-app notification); 1 → suggestions shown in Inbox.
 * - next_step_update ≥2 → our dated commitment becomes the deal's next step when the deal has none / it is overdue —
 *   only for OUTBOUND mail we wrote. SEC M-11: inbound mail is untrusted external content (PRD §11.5 caps it at
 *   "suggest"), so a next step derived from it is only stored as a suggestion (`nextStepSuggestion`).
 * - stage suggestions are stored only; never applied here.
 */
export async function analyzeStoredMessage(messageRowId: string): Promise<StoredEmailAnalysis | null> {
  const [row] = await db
    .select({ m: s.emailMessages, t: s.emailThreads })
    .from(s.emailMessages)
    .innerJoin(s.emailThreads, eq(s.emailThreads.id, s.emailMessages.threadId))
    .where(eq(s.emailMessages.id, messageRowId));
  if (!row || row.t.private) return null;
  const [owner] = await db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(eq(s.user.id, row.t.mailboxUserId));
  if (!owner) return null;

  const [sender] = row.m.fromAddr
    ? await db.select({ name: s.contacts.fullName }).from(s.contacts).where(and(eq(s.contacts.email, row.m.fromAddr), isNull(s.contacts.deletedAt))).limit(1)
    : [];
  const input: EmailAnalysisInput = {
    text: stripQuoted(row.m.bodyText ?? "").slice(0, 20_000),
    subject: row.t.subject,
    direction: row.m.direction === "outbound" ? "outbound" : "inbound",
    fromName: row.m.direction === "outbound" ? owner.name : (sender?.name ?? null),
    fromEmail: row.m.fromAddr,
    sentAt: row.m.sentAt ?? row.m.createdAt,
    stageNames: await dealStageNames(row.t.dealId),
  };
  const analysis = await runEmailAnalysis(input, owner);
  const prev = (row.m.analysis ?? {}) as Partial<StoredEmailAnalysis>;
  const stored: StoredEmailAnalysis = { ...analysis, suggestedDealId: prev.suggestedDealId ?? null, taskIds: {} };

  const autonomy = await getSetting<Record<string, unknown>>("agent.autonomy", {});
  if (autonomyLevel(autonomy, "task_from_commitment") >= 2 && analysis.commitments.length) {
    for (const [i, c] of analysis.commitments.entries()) {
      stored.taskIds![String(i)] = await createCommitmentTask({
        commitment: c,
        messageRowId,
        assigneeId: owner.id,
        createdBy: owner.id,
        dealId: row.t.dealId,
        accountId: row.t.accountId,
      });
    }
    const prefs = await getPrefs(owner.id);
    if (prefs.notifications.aiActions && prefs.notifications.inApp) {
      await notify(owner.id, {
        kind: "system",
        title: `${analysis.commitments.length} task${analysis.commitments.length === 1 ? "" : "s"} created from email`,
        body: `From “${(row.t.subject ?? "(no subject)").slice(0, 120)}”. Review or undo in the Inbox.`,
        href: `/inbox?thread=${row.t.id}`,
      });
    }
  }

  const oursNext = analysis.commitments.find((c) => c.by === "us" && c.due);
  if (row.t.dealId && oursNext && row.m.direction !== "outbound" && autonomyLevel(autonomy, "next_step_update") >= 1) {
    stored.nextStepSuggestion = { text: oursNext.text.slice(0, 240), due: oursNext.due! };
  }
  if (row.t.dealId && row.m.direction === "outbound" && autonomyLevel(autonomy, "next_step_update") >= 2) {
    const ours = oursNext;
    if (ours) {
      const updated = await db
        .update(s.deals)
        .set({ nextStep: ours.text.slice(0, 240), nextStepDueAt: new Date(ours.due!) })
        .where(and(eq(s.deals.id, row.t.dealId), sql`(${s.deals.nextStep} is null or ${s.deals.nextStepDueAt} is null or ${s.deals.nextStepDueAt} < now())`))
        .returning({ id: s.deals.id });
      if (updated.length) {
        stored.nextStepUpdated = true;
        await audit({ actorId: owner.id, actorKind: "agent", action: "deal.next_step_from_email", entity: "deal", entityId: row.t.dealId, after: { nextStep: ours.text, due: ours.due, source: `email:${messageRowId}` } });
      }
    }
  }

  await db.update(s.emailMessages).set({ analysis: stored as unknown as Record<string, unknown>, analyzedAt: new Date() }).where(eq(s.emailMessages.id, messageRowId));
  await refreshThreadState(row.t.id);
  return stored;
}

/** Analyze messages that haven't been analyzed yet for a mailbox (bounded per run to control AI cost). */
export async function analyzePending(userId: string, limit = 20): Promise<number> {
  const rows = await db
    .select({ id: s.emailMessages.id })
    .from(s.emailMessages)
    .innerJoin(s.emailThreads, eq(s.emailThreads.id, s.emailMessages.threadId))
    .where(and(eq(s.emailThreads.mailboxUserId, userId), isNull(s.emailMessages.analyzedAt), eq(s.emailThreads.private, false)))
    .orderBy(sql`${s.emailMessages.sentAt} desc nulls last`)
    .limit(limit);
  let n = 0;
  for (const r of rows) {
    try {
      if (await analyzeStoredMessage(r.id)) n++;
    } catch {
      // mark as analyzed-with-error so one bad message can't block the queue
      await db.update(s.emailMessages).set({ analyzedAt: new Date() }).where(eq(s.emailMessages.id, r.id));
    }
  }
  return n;
}
