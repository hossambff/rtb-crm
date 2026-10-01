"use server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError, type ActionResult } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { createDealTask, updateDealQuick } from "@/lib/deals/actions";
import { moveDealToStage } from "@/lib/deals/stage-service";
import { getPicklist } from "@/lib/deals/queries";
import { dealAccessWhere, ForbiddenError } from "@/lib/rbac/server";
import { postTeamPostToSlack } from "@/lib/slack/deliver";
import { addBusinessDays, formatInTz, parseUserDate, toDateInput } from "@/lib/time";
import { recapText, type Decision, type Outcome } from "./core";
import {
  buildExceptionList,
  getSessionForUser,
  publicDealNames,
  reviewScopeOptions,
  sanitizeScope,
  SESSION_LIMIT,
  sessionDecisions,
} from "./queries";

const uuid = z.string().uuid();
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date");

/** Unwrap an existing deal action's result: a failure becomes a user-facing error with the same message. */
function unwrap<T>(r: ActionResult<T>): T {
  if (!r.ok) throw new UserError(r.error);
  return r.data;
}

/* ═════════════════════ Start / end ═════════════════════ */

export const startReview = action(
  z.object({
    pipelineKeys: z.array(z.string().max(20)).max(10).default([]),
    teamId: uuid.nullable().optional(),
    ownerIds: z.array(z.string().max(100)).max(50).default([]),
    title: z.string().trim().max(120).optional(),
  }),
  async (input, user) => {
    const opts = await reviewScopeOptions(user);
    if (opts.analyticsScope === "none") throw new ForbiddenError("Pipeline review isn't available for your role.");
    const scope = sanitizeScope(input, opts);
    const { rows } = await buildExceptionList(user, scope);
    if (!rows.length) throw new UserError("Nothing to review in this scope — every deal looks healthy.");
    const dealIds = rows.slice(0, SESSION_LIMIT).map((r) => r.id);
    const title = input.title || `Pipeline review — ${formatInTz(new Date(), user.timezone, "date")}`;
    const [row] = await db
      .insert(s.reviewSessions)
      .values({ title, facilitatorId: user.id, scope: { pipelineKeys: scope.pipelineKeys, teamId: scope.teamId, ownerIds: scope.ownerIds }, dealIds })
      .returning({ id: s.reviewSessions.id });
    await audit({ actorId: user.id, action: "review.start", entity: "review_session", entityId: row!.id, after: { scope, deals: dealIds.length } });
    revalidatePath("/review");
    return { id: row!.id, deals: dealIds.length };
  },
);

export const endReview = action(z.object({ sessionId: uuid }), async ({ sessionId }, user) => {
  const session = await getSessionForUser(user, sessionId);
  if (!session) throw new UserError("Review not found.");
  if (!session.endedAt) {
    await db.update(s.reviewSessions).set({ endedAt: new Date() }).where(and(eq(s.reviewSessions.id, sessionId), isNull(s.reviewSessions.endedAt)));
    await audit({ actorId: user.id, action: "review.end", entity: "review_session", entityId: sessionId, after: { decisions: session.decisions.length } });
  }
  revalidatePath("/review");
  revalidatePath(`/review/${sessionId}`);
  return { ok: true };
});

/** Re-open an ended review (e.g. finished by mistake). */
export const reopenReview = action(z.object({ sessionId: uuid }), async ({ sessionId }, user) => {
  const session = await getSessionForUser(user, sessionId);
  if (!session) throw new UserError("Review not found.");
  await db.update(s.reviewSessions).set({ endedAt: null }).where(eq(s.reviewSessions.id, sessionId));
  await audit({ actorId: user.id, action: "review.reopen", entity: "review_session", entityId: sessionId });
  revalidatePath(`/review/${sessionId}`);
  return { ok: true };
});

/* ═════════════════════ Decisions ═════════════════════ */

const base = { sessionId: uuid, dealId: uuid, note: z.string().trim().max(500).optional() };
const decisionSchema = z.discriminatedUnion("outcome", [
  z.object({ ...base, outcome: z.literal("keep") }),
  z.object({ ...base, outcome: z.literal("push"), expectedCloseDate: ymd, nextStep: z.string().trim().max(500).optional(), nextStepDueAt: ymd.optional() }),
  z.object({ ...base, outcome: z.literal("update"), nextStep: z.string().trim().min(3, "Describe the next step").max(500), nextStepDueAt: ymd, createTask: z.boolean().default(true) }),
  z.object({ ...base, outcome: z.literal("escalate"), assigneeId: z.string().min(1).max(100), note: z.string().trim().min(3, "Say what you need").max(500), dueAt: ymd.optional() }),
  z.object({ ...base, outcome: z.literal("close_lost"), reasonCode: z.string().min(1, "Pick a reason").max(120) }),
]);

export const recordDecision = action(decisionSchema, async (input, user) => {
  const session = await getSessionForUser(user, input.sessionId);
  if (!session) throw new UserError("Review not found.");
  if (session.endedAt) throw new UserError("This review has ended — reopen it to make more decisions.");
  if (!session.dealIds.includes(input.dealId)) throw new UserError("That deal isn't part of this review.");
  // The facilitator must still see the deal (access can change mid-review); write outcomes re-check edit rights below.
  const [visible] = await db.select({ id: s.deals.id }).from(s.deals).where(and(eq(s.deals.id, input.dealId), await dealAccessWhere(user, "view")));
  if (!visible) throw new UserError("You no longer have access to this deal.");
  const tz = user.timezone;
  const todayKey = toDateInput(new Date(), tz);
  let taskId: string | null = null;
  let message: string;

  switch (input.outcome) {
    case "keep":
      message = "Kept as is.";
      break;
    case "push": {
      if (input.expectedCloseDate <= todayKey) throw new UserError("Pick a close date after today.");
      const patch: Record<string, string> = { expectedCloseDate: input.expectedCloseDate };
      if (input.nextStep) {
        patch.nextStep = input.nextStep;
        if (input.nextStepDueAt) patch.nextStepDueAt = input.nextStepDueAt;
      }
      unwrap(await updateDealQuick({ dealId: input.dealId, patch }));
      message = `Close date pushed to ${formatInTz(parseUserDate(input.expectedCloseDate, tz)!, tz, "date")}.`;
      break;
    }
    case "update": {
      if (input.nextStepDueAt < todayKey) throw new UserError("The due date is in the past.");
      unwrap(await updateDealQuick({ dealId: input.dealId, patch: { nextStep: input.nextStep, nextStepDueAt: input.nextStepDueAt } }));
      message = "Next step updated.";
      if (input.createTask) {
        const [deal] = await db.select({ ownerId: s.deals.ownerId }).from(s.deals).where(eq(s.deals.id, input.dealId));
        const r = await createDealTask({ dealId: input.dealId, title: input.nextStep, dueAt: input.nextStepDueAt, assigneeId: deal?.ownerId ?? user.id, priority: "high", owedBy: "us" });
        if (r.ok) {
          taskId = r.data.id;
          message = "Next step updated and a task created for the owner.";
        } else message = `Next step updated (task not created: ${r.error})`;
      }
      break;
    }
    case "escalate": {
      const [deal] = await db.select({ name: s.deals.name }).from(s.deals).where(eq(s.deals.id, input.dealId));
      const due = input.dueAt ?? toDateInput(addBusinessDays(new Date(), 2, tz), tz);
      const r = unwrap(
        await createDealTask({
          dealId: input.dealId,
          title: `Escalated in pipeline review: ${deal?.name ?? "deal"}`.slice(0, 300),
          description: `${input.note}\n\n— ${user.name}, ${session.title}`,
          dueAt: due,
          assigneeId: input.assigneeId,
          priority: "high",
          owedBy: "us",
        }),
      );
      taskId = r.id;
      message = input.assigneeId === user.id ? "Escalated — a task was created for you." : "Escalated — a task was created and the assignee notified.";
      break;
    }
    case "close_lost": {
      const reasons = await getPicklist("lost_reason");
      if (!reasons.some((r) => r.value === input.reasonCode)) throw new UserError("Pick a lost reason.");
      const [row] = await db
        .select({ stageId: s.stages.id })
        .from(s.deals)
        .innerJoin(s.stages, and(eq(s.stages.pipelineId, s.deals.pipelineId), eq(s.stages.category, "lost")))
        .where(eq(s.deals.id, input.dealId))
        .orderBy(s.stages.sortOrder)
        .limit(1);
      if (!row) throw new UserError("This pipeline has no lost stage.");
      // The one gated stage-change path: permissions, reasons, approvals, history, audit, health.
      const res = await moveDealToStage(user, input.dealId, { id: row.stageId }, { reasonCode: input.reasonCode, reasonText: input.note || undefined }, { via: "review" });
      message = res.pendingApproval ? "Close lost needs approval — request sent." : res.moved ? `Moved to ${res.stageName}.` : `Already in ${res.stageName}.`;
      break;
    }
  }

  const decision: Decision = { dealId: input.dealId, outcome: input.outcome as Outcome, note: input.note || undefined, taskId, at: new Date().toISOString() };
  // Atomic append (two tabs can't overwrite each other's decisions).
  await db
    .update(s.reviewSessions)
    .set({ decisions: sql`${s.reviewSessions.decisions} || ${JSON.stringify([decision])}::jsonb` })
    .where(eq(s.reviewSessions.id, session.id));
  await audit({ actorId: user.id, action: "review.decision", entity: "deal", entityId: input.dealId, after: { sessionId: session.id, outcome: input.outcome, taskId, note: input.note ?? null } });
  revalidatePath(`/review/${session.id}`);
  return { decision, message };
});

/* ═════════════════════ Recap → team feed (+ Slack) ═════════════════════ */

export const postRecap = action(z.object({ sessionId: uuid, slack: z.boolean().default(false) }), async ({ sessionId, slack }, user) => {
  const session = await getSessionForUser(user, sessionId);
  if (!session) throw new UserError("Review not found.");
  const decisions = sessionDecisions(session);
  if (!decisions.length) throw new UserError("No decisions to share yet.");
  const names = await publicDealNames(user, [...new Set(decisions.map((d) => d.dealId))]);
  const { title, body } = recapText({ title: session.title, dealCount: session.dealIds.length, decisions, names });
  const tag = `review:${session.id}`;
  const id = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tag}))`);
    const existing = await recapPostIdTx(tx, tag);
    if (existing) throw new UserError("The recap was already posted.");
    const [row] = await tx
      .insert(s.teamPosts)
      .values({ kind: "announcement", authorId: user.id, title: title.slice(0, 140), body, tags: ["review", tag], restricted: false })
      .returning({ id: s.teamPosts.id });
    await audit({ actorId: user.id, action: "team_post.create", entity: "team_post", entityId: row!.id, after: { kind: "announcement", reviewSessionId: session.id } }, tx);
    return row!.id;
  });
  // The body never names restricted deals (publicDealNames), so the channel post is MNPI-safe.
  if (slack) {
    after(async () => {
      try {
        await postTeamPostToSlack(id);
      } catch {
        /* never throws by contract */
      }
    });
  }
  revalidatePath("/team");
  revalidatePath(`/review/${session.id}`);
  return { id };
});

async function recapPostIdTx(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], tag: string) {
  const [row] = await tx
    .select({ id: s.teamPosts.id })
    .from(s.teamPosts)
    .where(and(sql`${s.teamPosts.tags} @> array[${tag}]::text[]`, isNull(s.teamPosts.deletedAt)))
    .limit(1);
  return row?.id ?? null;
}

