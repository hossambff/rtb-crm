"use server";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, dealAccessWhere, ForbiddenError, inScope, ownedEntityWhere, scopeFor, type AppUser } from "@/lib/rbac/server";
import { notify } from "@/lib/notifications/notify";
import { isSensitive } from "@/lib/notifications/sensitive";
import { raiseSnoozeAlert } from "@/lib/alerts/engine";
import { assertReceiverCanSee, loadReceiver } from "@/lib/rbac/receiver";
import { canEditTaskSync } from "./queries";
import { PRIORITIES } from "./core";
import { recomputeDealHealth } from "@/lib/deals/service";
import { parseUserDate } from "@/lib/time";

const uuid = z.string().uuid();
const optUuid = z.string().uuid().nullish();
/** Validated date string; resolved in the user's zone with `parseUserDate` (date-only → 17:00 local, M-06/QA-12). */
const isoDate = z
  .string()
  .max(40)
  .refine((v) => parseUserDate(v, "UTC") != null, "Invalid date");

const TaskInput = z.object({
  id: uuid.optional(),
  title: z.string().trim().min(1, "Title is required").max(300),
  description: z.string().trim().max(5000).nullish(),
  dueAt: isoDate.nullish(),
  assigneeId: z.string().min(1).nullish(),
  priority: z.enum(PRIORITIES).default("medium"),
  dealId: optUuid,
  accountId: optUuid,
  contactId: optUuid,
});

/** Overdue open tasks feed deal health — recompute the linked deal(s) after task writes. */
async function refreshHealth(...dealIds: (string | null | undefined)[]) {
  for (const id of new Set(dealIds.filter((x): x is string => Boolean(x)))) await recomputeDealHealth(id);
}

function revalidate() {
  revalidatePath("/tasks");
  revalidatePath("/home");
}

/** Related records must be visible to the actor (deal scope + MNPI, account/contact ownership). */
async function assertRelatedVisible(user: AppUser, r: { dealId?: string | null; accountId?: string | null; contactId?: string | null }) {
  const checks: Promise<boolean>[] = [];
  if (r.dealId)
    checks.push(
      dealAccessWhere(user, "view").then(async (w) => (await db.select({ id: s.deals.id }).from(s.deals).where(and(w, eq(s.deals.id, r.dealId!)))).length > 0),
    );
  if (r.accountId)
    checks.push(
      ownedEntityWhere(user, "accounts", "view", s.accounts.ownerId).then(
        async (w) =>
          (
            await db
              .select({ id: s.accounts.id })
              .from(s.accounts)
              .where(and(w, eq(s.accounts.id, r.accountId!), isNull(s.accounts.deletedAt), eq(s.accounts.restricted, false)))
          ).length > 0,
      ),
    );
  if (r.contactId)
    checks.push(
      ownedEntityWhere(user, "contacts", "view", s.contacts.ownerId).then(
        async (w) =>
          (await db.select({ id: s.contacts.id }).from(s.contacts).where(and(w, eq(s.contacts.id, r.contactId!), isNull(s.contacts.deletedAt)))).length > 0,
      ),
    );
  const ok = await Promise.all(checks);
  if (ok.includes(false)) throw new ForbiddenError("You can't link a task to that record.");
}

/**
 * Assigning to someone else needs tasks.assign scope over them, a session-equivalent receiver (not banned / expired /
 * pending), and (SEC M-2) that the receiver can see the task's deal and account — titles and descriptions are free text
 * that usually name the deal, so a restricted deal's task never lands with someone off its access list.
 */
async function assertCanAssign(user: AppUser, assigneeId: string, related: { dealId?: string | null; accountId?: string | null }) {
  if (assigneeId === user.id) return;
  const scope = await assertCan(user, "tasks", "assign");
  if (!inScope(user, scope, { ownerId: assigneeId }) && scope !== "pipeline") throw new ForbiddenError("You can't assign tasks to that person.");
  const receiver = await loadReceiver(assigneeId, "tasks");
  await assertReceiverCanSee(receiver, related, "this task");
}

async function loadEditable(user: AppUser, id: string) {
  const [task] = await db.select().from(s.tasks).where(eq(s.tasks.id, id));
  if (!task) throw new UserError("Task not found.");
  const scope = await scopeFor(user, "tasks", "edit");
  if (!canEditTaskSync(user, scope, task)) throw new ForbiddenError();
  return task;
}

export const saveTask = action(TaskInput, async (input, user) => {
  const assigneeId = input.assigneeId ?? user.id;
  await assertRelatedVisible(user, input);
  // Create and update (assignee change or a deal/account added later) both re-check the receiver.
  await assertCanAssign(user, assigneeId, { dealId: input.dealId ?? null, accountId: input.accountId ?? null });
  const values = {
    title: input.title,
    description: input.description || null,
    dueAt: input.dueAt ? (parseUserDate(input.dueAt, user.timezone) ?? null) : null,
    assigneeId,
    priority: input.priority,
    dealId: input.dealId ?? null,
    accountId: input.accountId ?? null,
    contactId: input.contactId ?? null,
  };
  if (input.id) {
    const before = await loadEditable(user, input.id);
    const [after] = await db.update(s.tasks).set(values).where(eq(s.tasks.id, input.id)).returning();
    await audit({ actorId: user.id, action: "task.update", entity: "task", entityId: input.id, before, after });
    await refreshHealth(before.dealId, after?.dealId);
    if (assigneeId !== before.assigneeId && assigneeId !== user.id)
      await notify(assigneeId, { kind: "task", title: `${user.name} assigned you: ${input.title}`, href: `/tasks?task=${input.id}`, sensitive: await isSensitive(values) });
    revalidate();
    return { id: input.id };
  }
  await assertCan(user, "tasks", "create");
  const [row] = await db
    .insert(s.tasks)
    .values({ ...values, createdBy: user.id, origin: "manual" })
    .returning();
  await audit({ actorId: user.id, action: "task.create", entity: "task", entityId: row!.id, after: row });
  await refreshHealth(row!.dealId);
  if (assigneeId !== user.id) await notify(assigneeId, { kind: "task", title: `${user.name} assigned you: ${input.title}`, href: `/tasks?task=${row!.id}`, sensitive: await isSensitive(values) });
  revalidate();
  return { id: row!.id };
});

export const setTaskStatus = action(z.object({ id: uuid, status: z.enum(["open", "done", "cancelled"]) }), async ({ id, status }, user) => {
  const before = await loadEditable(user, id);
  if (before.status === status) return { id };
  const [after] = await db
    .update(s.tasks)
    .set({ status, completedAt: status === "done" ? new Date() : null, ...(status === "open" ? {} : { snoozedUntil: null }) })
    .where(eq(s.tasks.id, id))
    .returning();
  await audit({ actorId: user.id, action: status === "done" ? "task.complete" : status === "open" ? "task.reopen" : "task.cancel", entity: "task", entityId: id, before, after });
  await refreshHealth(before.dealId);
  if (status !== "open") {
    // Nothing Slips: closing the task clears its task-scoped alerts (NS-05/06/26) right away.
    await db
      .update(s.alerts)
      .set({ state: "resolved", resolvedAt: new Date(), resolution: `Task ${status === "done" ? "completed" : "cancelled"}` })
      .where(and(eq(s.alerts.entity, "task"), eq(s.alerts.entityId, id), inArray(s.alerts.state, ["open", "acknowledged", "snoozed", "escalated"])));
  }
  if (status === "done" && before.createdBy && before.createdBy !== user.id && before.assigneeId !== before.createdBy)
    await notify(before.createdBy, { kind: "task", title: `${user.name} completed: ${before.title}`, href: `/tasks?task=${id}`, sensitive: await isSensitive(before) });
  revalidate();
  return { id };
});

export const snoozeTask = action(
  z.object({ id: uuid, until: isoDate, reason: z.string().trim().min(3, "Give a short reason").max(500) }),
  async ({ id, until: untilRaw, reason }, user) => {
    // a zone-less "YYYY-MM-DDTHH:mm" is wall time in the user's PROFILE zone, not the browser's or the server's (QA-12)
    const until = parseUserDate(untilRaw, user.timezone);
    if (!until) throw new UserError("Pick when it should come back.");
    if (until.getTime() <= Date.now()) throw new UserError("Pick a time in the future.");
    const before = await loadEditable(user, id);
    if (before.status !== "open") throw new UserError("Only open tasks can be snoozed.");
    const [after] = await db
      .update(s.tasks)
      .set({ snoozedUntil: until, dueAt: until, snoozeReason: reason, snoozeCount: sql`${s.tasks.snoozeCount} + 1` })
      .where(eq(s.tasks.id, id))
      .returning();
    await audit({ actorId: user.id, action: "task.snooze", entity: "task", entityId: id, before, after: { ...after, snoozeReason: reason } });
    await refreshHealth(before.dealId);
    const [rule] = await db.select({ params: s.alertRules.params }).from(s.alertRules).where(eq(s.alertRules.code, "NS-26"));
    const threshold = typeof rule?.params?.snoozes === "number" ? rule.params.snoozes : 3;
    let escalated = false;
    if (after!.snoozeCount >= threshold) escalated = await raiseSnoozeAlert(after!);
    revalidate();
    return { id, snoozeCount: after!.snoozeCount, escalated };
  },
);
