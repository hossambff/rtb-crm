import "server-only";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { getPrefs as getV2Prefs } from "@/lib/prefs";
import { ForbiddenError, type AppUser } from "@/lib/rbac/server";
import { getPicklist } from "@/lib/deals/queries";
import { loadDealForWrite, logActivity, recomputeDealHealth } from "@/lib/deals/service";
import { moveDealToStage } from "@/lib/deals/stage-service";
import { filledKeys, gateFieldMeta, missingFields } from "@/lib/deals/gates";
import type { StageCategory } from "@/lib/deals/types";
import { businessDeadline, formatInTz } from "@/lib/time";
import { stripQuoted } from "@/lib/gmail/parse";
import {
  applyMode,
  followUpTaskTitle,
  moveDialogHref,
  needsInputMessage,
  signalsFromEmail,
  signalsFromTranscript,
  type EmailAnalysisLike,
  type SignalCandidate,
  type SignalContext,
  type SignalKind,
  type StageLite,
  type TranscriptAnalysisLike,
} from "./core";

/**
 * Deal signals service (docs/V2_SPEC.md §A4): detection hooks called after email / transcript analysis, plus the
 * human Apply / Dismiss paths. Detection never throws into the caller (analysis must not fail because of signals) and
 * never changes the deal. Apply goes through the deals module's gated stage-move service.
 */

export type SignalSource = "email" | "transcript";

type DealForSignals = { id: string; name: string; status: string; stageId: string; pipelineId: string; ownerId: string | null; expectedCloseDate: Date | null };

async function loadDealContext(dealId: string, ref: Date): Promise<{ deal: DealForSignals; ctx: SignalContext } | null> {
  const [deal] = await db
    .select({
      id: s.deals.id,
      name: s.deals.name,
      status: s.deals.status,
      stageId: s.deals.stageId,
      pipelineId: s.deals.pipelineId,
      ownerId: s.deals.ownerId,
      expectedCloseDate: s.deals.expectedCloseDate,
    })
    .from(s.deals)
    .where(and(eq(s.deals.id, dealId), isNull(s.deals.deletedAt)));
  // Closed deals don't need nudges; held deals still do (a "let's sign" email should revive them).
  if (!deal || (deal.status !== "open" && deal.status !== "hold")) return null;
  const stages = (await db
    .select({ id: s.stages.id, name: s.stages.name, category: s.stages.category, sortOrder: s.stages.sortOrder })
    .from(s.stages)
    .where(eq(s.stages.pipelineId, deal.pipelineId))) as StageLite[];
  return { deal, ctx: { stages, currentStageId: deal.stageId, ref, expectedCloseDate: deal.expectedCloseDate } };
}

/** Autopilot switch: the deal owner's `autopilot.emailSignals` (default on) governs both email and call signals. */
async function signalsEnabledFor(userId: string | null): Promise<boolean> {
  if (!userId) return true;
  try {
    return (await getV2Prefs(userId)).autopilot.emailSignals !== false;
  } catch {
    return true;
  }
}

/** Insert candidates (unique per source × deal × kind → re-analysis is idempotent). Older pending signals of the same kind are superseded. */
export async function recordSignals(dealId: string, source: SignalSource, sourceId: string, candidates: SignalCandidate[]): Promise<number> {
  let inserted = 0;
  for (const c of candidates) {
    const [row] = await db
      .insert(s.dealSignals)
      .values({
        dealId,
        source,
        sourceId,
        kind: c.kind,
        suggestedStageId: c.suggestedStageId,
        suggestedCloseDate: c.suggestedCloseDate,
        quote: c.quote?.slice(0, 500) ?? null,
        rationale: c.rationale.slice(0, 500),
        confidence: Math.round(c.confidence * 100) / 100,
        engine: c.engine.slice(0, 80),
      })
      .onConflictDoNothing()
      .returning({ id: s.dealSignals.id });
    if (!row) continue;
    inserted++;
    await db
      .update(s.dealSignals)
      .set({ status: "expired", decidedAt: new Date() })
      .where(and(eq(s.dealSignals.dealId, dealId), eq(s.dealSignals.kind, c.kind), eq(s.dealSignals.status, "pending"), ne(s.dealSignals.id, row.id)));
  }
  return inserted;
}

/** Hook: an inbound email on a deal-linked, non-private thread was analyzed. Never throws. */
export async function detectEmailSignals(messageRowId: string, analysis: EmailAnalysisLike | null): Promise<number> {
  try {
    const [row] = await db
      .select({ m: s.emailMessages, t: s.emailThreads })
      .from(s.emailMessages)
      .innerJoin(s.emailThreads, eq(s.emailThreads.id, s.emailMessages.threadId))
      .where(eq(s.emailMessages.id, messageRowId));
    if (!row || row.t.private || !row.t.dealId || row.m.direction === "outbound") return 0;
    const loaded = await loadDealContext(row.t.dealId, row.m.sentAt ?? row.m.createdAt);
    if (!loaded || !(await signalsEnabledFor(loaded.deal.ownerId ?? row.t.mailboxUserId))) return 0;
    const text = stripQuoted(row.m.bodyText ?? "").slice(0, 20_000);
    if (!text.trim()) return 0;
    return await recordSignals(loaded.deal.id, "email", messageRowId, signalsFromEmail(text, analysis, loaded.ctx));
  } catch (e) {
    console.error("[signals] email detection failed", (e as Error).message?.split("\nparams:")[0]?.slice(0, 200));
    return 0;
  }
}

/** Hook: a transcript linked to a deal was analyzed. Never throws. */
export async function detectTranscriptSignals(transcriptId: string, analysis: TranscriptAnalysisLike | null): Promise<number> {
  try {
    const [t] = await db.select().from(s.transcripts).where(eq(s.transcripts.id, transcriptId));
    if (!t?.dealId) return 0;
    const loaded = await loadDealContext(t.dealId, t.occurredAt ?? t.createdAt);
    if (!loaded || !(await signalsEnabledFor(loaded.deal.ownerId ?? t.uploadedBy))) return 0;
    const [owner] = t.uploadedBy ? await db.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, t.uploadedBy)) : [];
    return await recordSignals(loaded.deal.id, "transcript", transcriptId, signalsFromTranscript(t.rawText, owner ? [owner.name] : [], analysis, loaded.ctx));
  } catch (e) {
    console.error("[signals] transcript detection failed", (e as Error).message?.split("\nparams:")[0]?.slice(0, 200));
    return 0;
  }
}

/** A source became private / detached: its pending signals (and quotes) go away. */
export async function expireSignalsForSources(source: SignalSource, sourceIds: string[], opts: { dealId?: string | null; scrubQuotes?: boolean } = {}) {
  if (!sourceIds.length) return;
  if (opts.scrubQuotes) {
    // Private content: decided signals keep their outcome but lose the quoted text.
    await db.update(s.dealSignals).set({ quote: null }).where(and(eq(s.dealSignals.source, source), inArray(s.dealSignals.sourceId, sourceIds)));
  }
  const conds = [eq(s.dealSignals.source, source), inArray(s.dealSignals.sourceId, sourceIds), eq(s.dealSignals.status, "pending")];
  if (opts.dealId) conds.push(ne(s.dealSignals.dealId, opts.dealId));
  await db.update(s.dealSignals).set({ status: "expired", quote: null, decidedAt: new Date() }).where(and(...conds));
}

/* ───────────────────────────── Apply / dismiss (human click) ───────────────────────────── */

type SignalRow = typeof s.dealSignals.$inferSelect;

async function claim(id: string, status: "applied" | "dismissed", userId: string): Promise<SignalRow> {
  const [row] = await db
    .update(s.dealSignals)
    .set({ status, decidedBy: userId, decidedAt: new Date() })
    .where(and(eq(s.dealSignals.id, id), eq(s.dealSignals.status, "pending")))
    .returning();
  if (!row) throw new UserError("This signal was already handled.");
  return row;
}

async function release(id: string) {
  await db.update(s.dealSignals).set({ status: "pending", decidedBy: null, decidedAt: null }).where(eq(s.dealSignals.id, id));
}

async function loadPending(id: string): Promise<SignalRow> {
  const [sig] = await db.select().from(s.dealSignals).where(eq(s.dealSignals.id, id));
  if (!sig) throw new UserError("Signal not found.");
  if (sig.status !== "pending") throw new UserError("This signal was already handled.");
  return sig;
}

/** Pick a picklist reason for won/lost/hold moves, preferring one that fits the evidence. */
async function reasonFor(category: string, quote: string | null): Promise<string | undefined> {
  const list = category === "lost" ? "lost_reason" : category === "hold" ? "hold_reason" : null;
  if (!list) return undefined;
  const options = await getPicklist(list);
  const q = (quote ?? "").toLowerCase();
  const prefer = category === "lost" && /vendor|partner|provider|competitor|another|different/.test(q) ? /compet|vendor|another/i : /priority|timing|budget/.test(q) ? /timing|priority|budget/i : null;
  return (prefer ? options.find((o) => prefer.test(o.value) || prefer.test(o.label)) : undefined)?.value ?? options.find((o) => /other/i.test(o.value) || /other/i.test(o.label))?.value ?? options[0]?.value;
}

function sourceLabel(sig: SignalRow) {
  return sig.source === "email" ? "email" : "call";
}

export type ApplyResult =
  | { status: "applied"; message: string; pendingApproval?: boolean }
  /** CR M9: the move needs gate input (next step, required fields) — open `href` (the deal's prefilled move dialog). */
  | { status: "needs_input"; message: string; href: string; missing: string[] };

/**
 * Apply a pending signal as `user`:
 *  - advance / won / lost / stall with a stage → moveDealToStage (gates, required fields, approval-gated stages, audit);
 *    when the target stage's gate needs input the deal lacks, nothing changes and a "needs input" result points to the
 *    stage-move dialog (the signal stays pending)
 *  - close_date → expected close date (field security respected)
 *  - risk (or stall without a hold stage) → a follow-up task with the evidence
 * Only the MUTATION runs inside the claim/release guard: once the deal changed, a failure in bookkeeping (activity,
 * audit, health) never rolls the signal back to pending (it would stay actionable for a change that already happened).
 */
export async function applySignal(user: AppUser, id: string): Promise<ApplyResult> {
  const sig = await loadPending(id);
  // Permission first (edit scope on the deal, restricted access list) — before claiming the row.
  const ctx = await loadDealForWrite(user, sig.dealId, "edit");
  const mode = applyMode(sig.kind as SignalKind, sig.suggestedStageId);

  let stage: typeof s.stages.$inferSelect | undefined;
  if (mode === "stage") {
    [stage] = await db.select().from(s.stages).where(and(eq(s.stages.id, sig.suggestedStageId!), eq(s.stages.pipelineId, ctx.deal.pipelineId)));
    if (!stage) throw new UserError("The suggested stage no longer exists in this pipeline.");
    if (stage.id !== ctx.deal.stageId) {
      const target = { requiredFields: stage.requiredFields ?? [], category: stage.category as StageCategory };
      const missing = missingFields(target, filledKeys(ctx.deal as unknown as Record<string, unknown>, target.requiredFields));
      if (missing.length) {
        const hiddenMissing = missing.filter((k) => ctx.hidden.has(k) || ctx.hidden.has("*"));
        if (hiddenMissing.length) throw new UserError(`${stage.name} requires ${hiddenMissing.map((k) => gateFieldMeta(k).label).join(", ")} — ask a manager to complete it.`);
        return { status: "needs_input", message: needsInputMessage(ctx.deal.name, stage.name, missing.map((k) => gateFieldMeta(k).label)), href: moveDialogHref(sig.dealId, stage.id, sig.id), missing };
      }
    }
  }

  await claim(id, "applied", user.id);
  let result: ApplyResult;
  let after: (() => Promise<void>) | null = null;
  try {
    if (mode === "stage") {
      const st = stage!;
      const reasonText = `From ${sourceLabel(sig)} signal${sig.quote ? `: “${sig.quote.slice(0, 300)}”` : ""}`;
      const r = await moveDealToStage(user, sig.dealId, { id: st.id }, { reasonCode: await reasonFor(st.category, sig.quote), reasonText }, { via: "signal" });
      result = r.pendingApproval
        ? { status: "applied", message: `Approval requested to move ${ctx.deal.name} to ${st.name}.`, pendingApproval: true }
        : { status: "applied", message: r.moved ? `${ctx.deal.name} moved to ${st.name}.` : `${ctx.deal.name} is already in ${st.name}.` };
    } else if (mode === "close_date") {
      if (!sig.suggestedCloseDate) throw new UserError("This signal has no date to apply.");
      if (ctx.hidden.has("expectedCloseDate") || ctx.hidden.has("*")) throw new ForbiddenError("Your role can't edit the expected close date.");
      const before = ctx.deal.expectedCloseDate;
      const date = sig.suggestedCloseDate;
      await db.update(s.deals).set({ expectedCloseDate: date }).where(eq(s.deals.id, sig.dealId));
      const label = formatInTz(date, user.timezone, "date");
      after = async () => {
        await logActivity({
          type: "field_change",
          subject: "Expected close date updated from a deal signal",
          body: `${before ? formatInTz(before, user.timezone, "date") : "—"} → ${label}${sig.quote ? `\n“${sig.quote}”` : ""}`,
          actorId: user.id,
          dealId: sig.dealId,
          accountId: ctx.deal.accountId,
          metadata: { signalId: sig.id, source: `${sig.source}:${sig.sourceId}` },
        });
        await audit({ actorId: user.id, action: "deal.update_close_from_signal", entity: "deal", entityId: sig.dealId, before: { expectedCloseDate: before }, after: { expectedCloseDate: date, signalId: sig.id } });
        await recomputeDealHealth(sig.dealId);
      };
      result = { status: "applied", message: `Expected close set to ${label}.` };
    } else {
      const [task] = await db
        .insert(s.tasks)
        .values({
          title: followUpTaskTitle(sig.kind as SignalKind, ctx.deal.name, sig.rationale),
          description: sig.rationale,
          dueAt: businessDeadline(new Date(), 2, user.timezone),
          assigneeId: user.id,
          createdBy: user.id,
          dealId: sig.dealId,
          accountId: ctx.deal.accountId,
          priority: sig.kind === "risk" ? "high" : "medium",
          origin: sig.source === "email" ? "email_ai" : "call_ai",
          owedBy: "us",
          evidence: sig.quote,
          evidenceSource: `${sig.source}:${sig.sourceId}`,
        })
        .returning({ id: s.tasks.id });
      after = async () => {
        await audit({ actorId: user.id, action: "task.create_from_signal", entity: "task", entityId: task!.id, after: { dealId: sig.dealId, signalId: sig.id } });
        await recomputeDealHealth(sig.dealId);
      };
      result = { status: "applied", message: "Follow-up task created." };
    }
  } catch (e) {
    await release(id); // the mutation itself failed → nothing changed → the signal stays actionable
    throw e;
  }
  // bookkeeping AFTER the change: failures are logged, never turned into "pending" again
  try {
    if (after) await after();
    await audit({ actorId: user.id, action: "deal_signal.apply", entity: "deal", entityId: sig.dealId, after: { signalId: sig.id, kind: sig.kind, mode, pendingApproval: result.status === "applied" && Boolean(result.pendingApproval) } });
  } catch (e) {
    console.error("[signals] bookkeeping after apply failed", (e as Error).message?.split("\nparams:")[0]?.slice(0, 200));
  }
  return result;
}

export async function dismissSignal(user: AppUser, id: string): Promise<void> {
  const sig = await loadPending(id);
  await loadDealForWrite(user, sig.dealId, "edit");
  await claim(id, "dismissed", user.id);
  await audit({ actorId: user.id, action: "deal_signal.dismiss", entity: "deal", entityId: sig.dealId, after: { signalId: sig.id, kind: sig.kind } });
}

/** Signals older than this are not shown anymore (stale advice is noise). */
export const SIGNAL_TTL_DAYS = 30;
export const freshSignalSql = sql`${s.dealSignals.createdAt} > now() - make_interval(days => ${SIGNAL_TTL_DAYS})`;
