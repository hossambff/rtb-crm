"use server";
import { revalidatePath } from "next/cache";
import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, dealModule, ForbiddenError, inScope } from "@/lib/rbac/server";
import { gateIssues } from "./guards";
import { listMyWork, loadAccessibleDeal, newRunState, pipelineReport, stagesOfPipeline } from "./queries";
import { insertTask, meetingPrep, validateTask } from "./service";

const uuid = z.string().uuid();

/** Confirm a Copilot task suggestion (user click). Re-validates permissions server-side. */
export const confirmCopilotTask = action(
  z.object({
    title: z.string().min(1).max(200),
    dueAt: z.string().nullish(),
    dealId: uuid.nullish(),
    assigneeId: z.string().nullish(),
    description: z.string().max(2000).nullish(),
    evidence: z.string().max(1000).nullish(),
  }),
  async (input, user) => {
    await assertCan(user, "tasks", "create");
    const v = await validateTask(user, input);
    if (!v.ok) throw new UserError(v.error);
    const id = await insertTask(user, v.task, v.dealAccountId, "user");
    revalidatePath("/tasks");
    if (v.task.dealId) revalidatePath(`/deals/${v.task.dealId}`);
    return { taskId: id };
  },
);

/** Undo a task Copilot auto-created (autonomy level 2) within 24h. */
export const undoCopilotTask = action(z.object({ taskId: uuid }), async ({ taskId }, user) => {
  const [t] = await db
    .select()
    .from(s.tasks)
    .where(and(eq(s.tasks.id, taskId), eq(s.tasks.createdBy, user.id), eq(s.tasks.origin, "agent"), gte(s.tasks.createdAt, new Date(Date.now() - 24 * 3_600_000))));
  if (!t) throw new UserError("This task can no longer be undone.");
  if (t.status !== "open") throw new UserError("The task is already closed.");
  await db.update(s.tasks).set({ status: "cancelled" }).where(eq(s.tasks.id, taskId));
  await audit({ actorId: user.id, action: "task.undo_agent_create", entity: "task", entityId: taskId, before: { status: t.status }, after: { status: "cancelled" } });
  revalidatePath("/tasks");
  return { taskId };
});

/**
 * Apply a Copilot stage suggestion — only on explicit user click. Re-checks RBAC and stage gates, then writes
 * deal_stage_history, a stage_change activity and an audit entry. Approval-gated stages create an approval request.
 */
export const applyCopilotStageChange = action(
  z.object({ dealId: uuid, stageKey: z.string().min(1).max(40), reason: z.string().max(500).default("") }),
  async ({ dealId, stageKey, reason }, user) => {
    const deal = await loadAccessibleDeal(user, dealId, "edit");
    if (!deal) throw new ForbiddenError("You can't edit this deal.");
    const scope = await assertCan(user, dealModule(deal.pipelineKey), "edit");
    if (!inScope(user, scope, { ownerId: deal.ownerId, teamId: deal.teamId, pipelineKey: deal.pipelineKey })) throw new ForbiddenError("This deal is outside your edit scope.");
    const stages = await stagesOfPipeline(deal.pipelineId);
    const target = stages.find((st) => st.key === stageKey);
    if (!target) throw new UserError(`Unknown stage "${stageKey}".`);
    if (target.id === deal.stageId) throw new UserError(`The deal is already in "${target.name}".`);
    const missing = gateIssues({ ...target, requiresApproval: false, category: "open" }, deal);
    if (missing.length) throw new UserError(`Stage gate: ${missing.join("; ")}.`);

    if (target.requiresApproval) {
      const [appr] = await db
        .insert(s.approvals)
        .values({
          kind: "stage_gate",
          entity: "deal",
          entityId: deal.id,
          requestedBy: user.id,
          payload: { fromStageId: deal.stageId, toStageId: target.id, toStageKey: target.key, reason, via: "copilot" },
        })
        .returning({ id: s.approvals.id });
      await audit({ actorId: user.id, action: "deal.stage_change_requested", entity: "deal", entityId: deal.id, before: { stageId: deal.stageId }, after: { stageId: target.id, approvalId: appr!.id, reason } });
      return { status: "pending_approval" as const, stageName: target.name };
    }

    const now = new Date();
    const status = target.category;
    await db.transaction(async (tx) => {
      await tx
        .update(s.deals)
        .set({
          stageId: target.id,
          stageEnteredAt: now,
          status,
          ...(status === "won" ? { wonAt: now } : {}),
          ...(status === "lost" ? { lostAt: now, lostReason: reason || null } : {}),
          ...(status === "hold" ? { holdReason: reason || null } : {}),
          lastActivityAt: now,
        })
        .where(eq(s.deals.id, deal.id));
      await tx.insert(s.dealStageHistory).values({ dealId: deal.id, fromStageId: deal.stageId, toStageId: target.id, changedBy: user.id, reason: reason || "Applied from Copilot suggestion" });
      await tx.insert(s.activities).values({
        type: "stage_change",
        source: "manual",
        subject: `Stage: ${deal.stageName} → ${target.name}`,
        body: reason || null,
        actorId: user.id,
        dealId: deal.id,
        accountId: deal.accountId,
        metadata: { via: "copilot", fromStageId: deal.stageId, toStageId: target.id },
      });
    });
    await audit({ actorId: user.id, action: "deal.stage_change", entity: "deal", entityId: deal.id, before: { stageId: deal.stageId, status: deal.status }, after: { stageId: target.id, status, reason, via: "copilot" } });
    revalidatePath(`/deals/${deal.id}`);
    revalidatePath("/pipelines");
    return { status: "applied" as const, stageName: target.name };
  },
);

/** Deterministic quick actions (no AI) for the Copilot rail and for graceful degradation. */
export const runCopilotQuickAction = action(
  z.object({
    kind: z.enum(["pipeline", "tasks", "alerts", "at_risk", "prep"]),
    basis: z.enum(["gross", "net"]).default("gross"),
    dealId: uuid.optional(),
    meetingId: uuid.optional(),
  }),
  async (input, user) => {
    await assertCan(user, "copilot", "use_ai");
    switch (input.kind) {
      case "pipeline":
        return { kind: "pipeline" as const, report: await pipelineReport(user, { groupBy: "stage", basis: input.basis, includeOverrides: true }) };
      case "tasks":
        return { kind: "tasks" as const, work: await listMyWork(user, null, "tasks") };
      case "alerts":
        return { kind: "alerts" as const, work: await listMyWork(user, null, "alerts") };
      case "at_risk":
        return { kind: "at_risk" as const, work: await listMyWork(user, null, "deals_at_risk") };
      case "prep": {
        const brief = await meetingPrep(user, newRunState(), { dealId: input.dealId, meetingId: input.meetingId });
        if ("error" in brief) throw new UserError(brief.error);
        return { kind: "prep" as const, brief };
      }
    }
  },
);
