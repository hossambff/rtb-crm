"use server";
import { revalidatePath } from "next/cache";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { aiAvailable, aiObject, modelFor, untrusted } from "@/lib/ai";
import { audit } from "@/lib/audit";
import { parseAudience } from "@/lib/domain";
import { accountVisibilityWhere } from "@/lib/accounts/queries";
import { assertCan, can, dealAccessWhere, ForbiddenError, type AppUser } from "@/lib/rbac/server";
import { getAccessibleDeal } from "@/lib/integrations/deal-access";
import { isSensitive } from "@/lib/notifications/sensitive";
import { loadDealForWrite, logActivity, recomputeDealHealth } from "@/lib/deals/service";
import { businessDeadline } from "@/lib/time";
import { aiCaptureSchema, capturePrompt, captureTargetFromPath, detectTarget, MAX_CAPTURE_CHARS, normalizeAiCapture, parseCaptureHeuristic, type CaptureParse, type CaptureTargetCandidate } from "./core";

/**
 * Quick capture (V2 A10): parse a dictated/typed note into a preview (AI with heuristic fallback, untrusted-wrapped,
 * logged in agent_runs) and apply the items the user kept. Nothing happens without the explicit Apply.
 */

export type CaptureTarget = { kind: "deal" | "account"; id: string; name: string };

/**
 * Auto-detect candidates: open deals the user can see that they or their team own (QA MIN-12 — not only their own),
 * own deals first, plus the team's accounts.
 */
async function targetCandidates(user: AppUser): Promise<CaptureTargetCandidate[]> {
  const userId = user.id;
  const team = user.teamMemberIds.length ? user.teamMemberIds : [userId];
  const [dealWhere, accWhere] = await Promise.all([dealAccessWhere(user, "view"), accountVisibilityWhere(user, "view")]);
  const [deals, accounts] = await Promise.all([
    db
      .select({ id: s.deals.id, name: s.deals.name, accountName: s.accounts.name, ownerId: s.deals.ownerId })
      .from(s.deals)
      .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
      .where(and(dealWhere, isNull(s.deals.deletedAt), inArray(s.deals.status, ["open", "hold"]), inArray(s.deals.ownerId, team)))
      .orderBy(sql`${s.deals.ownerId} = ${userId} desc`, desc(s.deals.lastActivityAt))
      .limit(400),
    db.select({ id: s.accounts.id, name: s.accounts.name }).from(s.accounts).where(and(accWhere, inArray(s.accounts.ownerId, team))).limit(300),
  ]);
  return [
    ...deals.map((d) => ({ kind: "deal" as const, id: d.id, name: d.name, accountName: d.accountName, mine: d.ownerId === userId })),
    ...accounts.map((a) => ({ kind: "account" as const, id: a.id, name: a.name })),
  ];
}

/**
 * Topbar Capture context (QA MIN-12): is capture available for this role, and which deal/account is the current page
 * about (so the dialog opens pre-targeted on /deals/:id and /accounts/:id)? Only records the user can see.
 */
export const captureContext = action(z.object({ path: z.string().max(300).default("") }), async ({ path }, user) => {
  if (!(await can(user, "activities", "create"))) return { allowed: false as const, target: null };
  const ref = captureTargetFromPath(path);
  if (ref?.kind === "deal") {
    const d = await getAccessibleDeal(user, ref.id, "view");
    return { allowed: true as const, target: d ? { kind: "deal" as const, id: d.id, name: d.name } : null };
  }
  if (ref?.kind === "account") {
    const [a] = await db.select({ id: s.accounts.id, name: s.accounts.name }).from(s.accounts).where(and(eq(s.accounts.id, ref.id), await accountVisibilityWhere(user, "view")));
    return { allowed: true as const, target: a ? { kind: "account" as const, id: a.id, name: a.name } : null };
  }
  return { allowed: true as const, target: null };
});

export const parseCapture = action(
  z.object({ text: z.string().trim().min(2, "Say or type something first").max(MAX_CAPTURE_CHARS), target: z.object({ kind: z.enum(["deal", "account"]), id: z.uuid() }).nullable().optional() }),
  async ({ text, target: picked }, user) => {
  await assertCan(user, "activities", "create");
  const now = new Date();
  let parsed: CaptureParse | null = null;
  let hint: string | null = null;
  // SEC M-6: AI only with copilot.use_ai, and never for a note the user already tied to a restricted (MNPI) record
  const sensitive = picked ? await isSensitive(picked.kind === "deal" ? { dealId: picked.id } : { accountId: picked.id }) : false;
  const useAi = aiAvailable() && text.length > 20 && !sensitive && (await can(user, "copilot", "use_ai"));
  if (useAi) {
    try {
      const model = await modelFor("fast");
      const ai = await aiObject({ kind: "quick_capture", userId: user.id, tier: "fast", schema: aiCaptureSchema, prompt: capturePrompt(untrusted("capture", text, MAX_CAPTURE_CHARS), now), maxOutputTokens: 1_500 });
      parsed = normalizeAiCapture(ai, text, now, model);
      hint = ai.deal_or_account_hint?.trim().slice(0, 80) || null;
    } catch {
      parsed = null; // logged in agent_runs; fall back
    }
  }
  parsed ??= parseCaptureHeuristic(text, now);

  let target: CaptureTarget | null = null;
  const hit = detectTarget(text, await targetCandidates(user));
  if (hit) target = { kind: hit.kind, id: hit.id, name: hit.name };
  if (!target && hint && hint.length >= 3) {
    // The AI's company hint, resolved only against deals the user may see.
    const like = `%${hint.replace(/[%_\\]/g, "\\$&")}%`;
    const [d] = await db
      .select({ id: s.deals.id, name: s.deals.name })
      .from(s.deals)
      .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
      .where(and(await dealAccessWhere(user, "view"), isNull(s.deals.deletedAt), inArray(s.deals.status, ["open", "hold"]), or(ilike(s.deals.name, like), ilike(s.accounts.name, like))))
      .orderBy(desc(s.deals.lastActivityAt))
      .limit(1);
    if (d) target = { kind: "deal", id: d.id, name: d.name };
  }
  return { parse: parsed, target };
  },
);

const isoDate = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "Invalid date")
  .nullable();

export const applyCapture = action(
  z.object({
    target: z.object({ kind: z.enum(["deal", "account"]), id: z.uuid() }),
    note: z.string().trim().max(MAX_CAPTURE_CHARS).default(""),
    tasks: z.array(z.object({ title: z.string().trim().min(2).max(240), due: isoDate })).max(10).default([]),
    nextStep: z.object({ text: z.string().trim().min(2).max(500), due: isoDate }).nullable().default(null),
    fieldUpdates: z.array(z.object({ field: z.enum(["muu", "expected_close_date"]), value: z.string().trim().min(1).max(60) })).max(2).default([]),
    engine: z.string().max(80).default("heuristic"),
  }),
  async (input, user) => {
    if (!input.note && !input.tasks.length && !input.nextStep && !input.fieldUpdates.length) throw new UserError("Nothing selected to apply.");
    await assertCan(user, "activities", "create");
    if (input.tasks.length) await assertCan(user, "tasks", "create");

    let dealId: string | null = null;
    let accountId: string | null = null;
    let href = "/home";
    if (input.target.kind === "deal") {
      const needsEdit = Boolean(input.nextStep || input.fieldUpdates.length);
      const ctx = await loadDealForWrite(user, input.target.id, needsEdit ? "edit" : "view");
      dealId = ctx.deal.id;
      accountId = ctx.deal.accountId;
      href = `/deals/${dealId}`;
      const set: Partial<typeof s.deals.$inferInsert> = {};
      const before: Record<string, unknown> = {};
      const blocked = (col: string) => ctx.hidden.has(col) || ctx.hidden.has("*");
      if (input.nextStep) {
        if (blocked("nextStep")) throw new ForbiddenError("Your role can't edit the next step.");
        set.nextStep = input.nextStep.text;
        set.nextStepDueAt = input.nextStep.due ? new Date(input.nextStep.due) : businessDeadline(new Date(), 3, user.timezone);
        before.nextStep = ctx.deal.nextStep;
        before.nextStepDueAt = ctx.deal.nextStepDueAt;
      }
      for (const f of input.fieldUpdates) {
        if (f.field === "muu") {
          if (blocked("muu")) throw new ForbiddenError("Your role can't edit MUU.");
          const n = parseAudience(f.value);
          if (!n) throw new UserError("MUU must be a number (e.g. 2500000 or 2.5M).");
          set.muu = n;
          before.muu = ctx.deal.muu;
        } else {
          if (blocked("expectedCloseDate")) throw new ForbiddenError("Your role can't edit the expected close date.");
          const d = new Date(f.value);
          if (Number.isNaN(d.getTime())) throw new UserError("Expected close date is not a valid date.");
          set.expectedCloseDate = d;
          before.expectedCloseDate = ctx.deal.expectedCloseDate;
        }
      }
      if (Object.keys(set).length) {
        await db.update(s.deals).set(set).where(eq(s.deals.id, dealId));
        await audit({ actorId: user.id, action: "deal.update_from_capture", entity: "deal", entityId: dealId, before, after: set });
      }
    } else {
      if (input.nextStep || input.fieldUpdates.length) throw new UserError("Pick a deal to set a next step or update fields.");
      const [a] = await db
        .select({ id: s.accounts.id })
        .from(s.accounts)
        .where(and(eq(s.accounts.id, input.target.id), await accountVisibilityWhere(user, "view")));
      if (!a) throw new ForbiddenError("You can't log notes on that account.");
      accountId = a.id;
      href = `/accounts/${a.id}`;
    }

    let activityId: string | null = null;
    if (input.note) {
      activityId = await logActivity({
        type: "note",
        source: "manual",
        subject: "Quick capture",
        body: input.note,
        actorId: user.id,
        dealId,
        accountId,
        metadata: { capture: true, engine: input.engine },
      });
    }
    const taskIds: string[] = [];
    for (const t of input.tasks) {
      const [row] = await db
        .insert(s.tasks)
        .values({
          title: t.title,
          dueAt: t.due ? new Date(t.due) : null,
          assigneeId: user.id,
          createdBy: user.id,
          dealId,
          accountId,
          origin: input.engine.startsWith("ai:") ? "agent" : "manual",
          owedBy: "us",
          evidence: input.note ? input.note.slice(0, 500) : null,
          evidenceSource: activityId ? `capture:${activityId}` : "capture",
        })
        .returning({ id: s.tasks.id });
      taskIds.push(row!.id);
    }
    await audit({
      actorId: user.id,
      action: "capture.apply",
      entity: input.target.kind,
      entityId: input.target.id,
      after: { activityId, tasks: taskIds.length, nextStep: Boolean(input.nextStep), fields: input.fieldUpdates.map((f) => f.field), engine: input.engine },
    });
    if (dealId) {
      await recomputeDealHealth(dealId);
      revalidatePath(`/deals/${dealId}`);
    }
    if (accountId) revalidatePath(`/accounts/${accountId}`);
    revalidatePath("/home");
    revalidatePath("/tasks");
    return { href, tasks: taskIds.length, note: Boolean(activityId), nextStep: Boolean(input.nextStep), fields: input.fieldUpdates.length };
  },
);
