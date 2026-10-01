import "server-only";
import { cache } from "react";
import { mnpiSafe } from "@/lib/deals/notice";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, withXactLock } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { logServerError } from "@/lib/errors";
import { notifyMany } from "@/lib/notifications/notify";
import { isSensitive } from "@/lib/notifications/sensitive";
import { filterRecipientsForDeal } from "@/lib/deals/service";
import { firstStep, playbookDueAt, playbookSource, resolveAssignee, tasksToCreate, type PlaybookEmail, type PlaybookTask } from "./core";

export type StagePlaybook = {
  id: string;
  stageId: string;
  name: string;
  guidance: string | null;
  tasks: PlaybookTask[];
  emailTemplates: PlaybookEmail[];
  active: boolean;
  updatedAt: string;
};

function toDto(r: typeof s.stagePlaybooks.$inferSelect): StagePlaybook {
  return { id: r.id, stageId: r.stageId, name: r.name, guidance: r.guidance, tasks: r.tasks ?? [], emailTemplates: r.emailTemplates ?? [], active: r.active, updatedAt: r.updatedAt.toISOString() };
}

/** Active playbook of a stage (null when none / inactive). Never throws. */
export async function getActivePlaybook(stageId: string): Promise<StagePlaybook | null> {
  try {
    const [r] = await db.select().from(s.stagePlaybooks).where(and(eq(s.stagePlaybooks.stageId, stageId), eq(s.stagePlaybooks.active, true)));
    return r ? toDto(r) : null;
  } catch (e) {
    logServerError("playbook.get", e);
    return null;
  }
}

/** All playbooks of a pipeline's stages (admin editor). */
export async function listPlaybooksForStages(stageIds: string[]): Promise<StagePlaybook[]> {
  if (!stageIds.length) return [];
  const rows = await db.select().from(s.stagePlaybooks).where(inArray(s.stagePlaybooks.stageId, stageIds));
  return rows.map(toDto);
}

/**
 * Next-step suggestions per stage for the stage-move dialog ("prefilled from the playbook's first task"):
 * stageId → { title, dueInDays }. Only active playbooks with tasks. Never throws.
 */
export async function playbookHints(pipelineId: string): Promise<Record<string, { title: string; dueInDays: number }>> {
  try {
    const rows = await activePipelinePlaybooks(pipelineId);
    const out: Record<string, { title: string; dueInDays: number }> = {};
    for (const r of rows) {
      const f = firstStep(r.tasks);
      if (f) out[r.stageId] = f;
    }
    return out;
  } catch (e) {
    logServerError("playbook.hints", e);
    return {};
  }
}

/** Active playbooks of a pipeline's stages, once per request (deal page: hints + current stage guidance in ONE query). */
const activePipelinePlaybooks = cache(async (pipelineId: string): Promise<StagePlaybook[]> => {
  const rows = await db
    .select({ p: s.stagePlaybooks })
    .from(s.stagePlaybooks)
    .innerJoin(s.stages, eq(s.stages.id, s.stagePlaybooks.stageId))
    .where(and(eq(s.stages.pipelineId, pipelineId), eq(s.stagePlaybooks.active, true)));
  return rows.map((r) => toDto(r.p));
});

/** Deal page (perf H-4): the current stage's active playbook + next-step hints for every stage, from one query. Never throws. */
export async function dealPagePlaybook(pipelineId: string, stageId: string): Promise<{ playbook: StagePlaybook | null; hints: Record<string, { title: string; dueInDays: number }> }> {
  try {
    const rows = await activePipelinePlaybooks(pipelineId);
    const hints: Record<string, { title: string; dueInDays: number }> = {};
    for (const r of rows) {
      const f = firstStep(r.tasks);
      if (f) hints[r.stageId] = f;
    }
    return { playbook: rows.find((r) => r.stageId === stageId) ?? null, hints };
  } catch (e) {
    logServerError("playbook.page", e);
    return { playbook: null, hints: {} };
  }
}

/**
 * Entering a stage (performStageMove success path, post-commit; deal creation): create the playbook's tasks.
 * Idempotent per deal × stage × task title (tasks.evidence_source = "playbook:<stageId>", any status), so a deal that
 * re-enters a stage gets no duplicates. Restricted deals: assignees off the access list fall back to the owner.
 * Never throws — the stage move already succeeded.
 */
export async function applyStagePlaybook(opts: { dealId: string; stageId: string; actorId: string }): Promise<{ created: number }> {
  try {
    const pb = await getActivePlaybook(opts.stageId);
    if (!pb || !pb.tasks.length) return { created: 0 };
    const [deal] = await db
      .select({ id: s.deals.id, name: s.deals.name, ownerId: s.deals.ownerId, accountId: s.deals.accountId, restricted: s.deals.restricted, stageId: s.deals.stageId, deletedAt: s.deals.deletedAt })
      .from(s.deals)
      .where(eq(s.deals.id, opts.dealId));
    // The deal moved on in the meantime (or was deleted): don't create a stale checklist.
    if (!deal || deal.deletedAt || deal.stageId !== opts.stageId) return { created: 0 };
    const source = playbookSource(opts.stageId);
    const pre = await db.select({ title: s.tasks.title }).from(s.tasks).where(and(eq(s.tasks.dealId, deal.id), eq(s.tasks.evidenceSource, source)));
    if (!tasksToCreate(pb.tasks, pre.map((e) => e.title)).length) return { created: 0 };

    const ownerOrActor = deal.ownerId ?? opts.actorId;
    const [owner] = await db.select({ managerId: s.user.managerId, timezone: s.user.timezone }).from(s.user).where(eq(s.user.id, ownerOrActor));
    let onboardingId: string | null = null;
    if (pb.tasks.some((x) => x.assignTo === "onboarding")) {
      // Least-loaded onboarding specialist (open tasks), name as the tie-breaker.
      const [ob] = await db
        .select({ id: s.user.id })
        .from(s.user)
        .where(and(eq(s.user.role, "onboarding"), sql`coalesce(${s.user.banned}, false) = false`))
        .orderBy(sql`(select count(*) from rso.tasks t where t.assignee_id = ${s.user.id} and t.status = 'open')`, asc(s.user.name))
        .limit(1);
      onboardingId = ob?.id ?? null;
    }
    const allTasks = tasksToCreate(pb.tasks, []);
    const wantedAll = allTasks.map((x) => resolveAssignee(x.assignTo, { ownerId: deal.ownerId, managerId: owner?.managerId ?? null, onboardingId, actorId: opts.actorId }));
    const allowed = new Set(await filterRecipientsForDeal(deal, Array.from(new Set(wantedAll))));
    const now = new Date();
    const tz = owner?.timezone ?? "America/New_York";
    // CR L5 / QA MIN-14: re-check + insert under a per deal×stage transaction lock, so two concurrent entries (creation +
    // an immediate move, two tabs) can't both create the checklist.
    const locked = await withXactLock(`rso.playbook:${deal.id}:${opts.stageId}`, async (tx) => {
      const existing = await tx.select({ title: s.tasks.title }).from(s.tasks).where(and(eq(s.tasks.dealId, deal.id), eq(s.tasks.evidenceSource, source)));
      const todo = tasksToCreate(pb.tasks, existing.map((e) => e.title));
      if (!todo.length) return [];
      const values = todo.map((x) => {
        const wanted = wantedAll[allTasks.findIndex((t) => t.title === x.title)] ?? ownerOrActor;
        return {
          title: x.title,
          description: x.description ?? `From the “${pb.name}” playbook.`,
          dueAt: playbookDueAt(now, x.dueInDays, tz),
          assigneeId: allowed.has(wanted) ? wanted : ownerOrActor,
          createdBy: opts.actorId,
          dealId: deal.id,
          accountId: deal.accountId,
          priority: x.priority ?? ("medium" as const),
          owedBy: "us",
          origin: "rule" as const,
          evidenceSource: source,
        };
      });
      return tx.insert(s.tasks).values(values).returning({ id: s.tasks.id, assigneeId: s.tasks.assigneeId });
    });
    const inserted = locked.locked ? locked.value : [];
    if (!inserted.length) return { created: 0 };
    await audit({ actorId: opts.actorId, action: "playbook.apply", entity: "deal", entityId: deal.id, after: { stageId: opts.stageId, playbookId: pb.id, taskIds: inserted.map((t) => t.id) } });
    const others = Array.from(new Set(inserted.map((t) => t.assigneeId).filter((id): id is string => !!id && id !== opts.actorId)));
    if (others.length) await notifyMany(others, { kind: "task", ...mnpiSafe(deal.restricted || (await isSensitive({ dealId: deal.id })), { title: `New playbook task on ${deal.name}`, body: pb.name }, "New playbook task on a restricted deal"), href: `/deals/${deal.id}` });
    return { created: inserted.length };
  } catch (e) {
    logServerError("playbook.apply", e);
    return { created: 0 };
  }
}
