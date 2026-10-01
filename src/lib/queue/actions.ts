"use server";
import { revalidatePath } from "next/cache";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError, type ActionResult } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, ForbiddenError, inScope, scopeFor, type AppUser } from "@/lib/rbac/server";
import { assertReceiverCanSee, loadReceiver } from "@/lib/rbac/receiver";
import { notify } from "@/lib/notifications/notify";
import { isSensitive } from "@/lib/notifications/sensitive";
import { canEditTaskSync } from "@/lib/tasks/queries";
import { setTaskStatus, snoozeTask } from "@/lib/tasks/actions";
import { reassignAlert, resolveAlert, snoozeAlert } from "@/lib/alerts/actions";
import * as handoffs from "./providers/handoffs";
import * as help from "./providers/help";
import * as signals from "./providers/signals";
import * as forecast from "./providers/forecast";
import * as sequences from "./providers/sequences";
import * as stories from "./providers/stories";
import { DISMISSAL_TTL_DAYS, parseQueueKey, snoozeUntil } from "./core";
import { UNDO_WINDOW_MS, safeQueueHref, undoPlan } from "./undo-core";
import type { QueueServerHandler } from "./types";

const ITEM_KEY = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[a-z_]+:[A-Za-z0-9:_\-.#]+$/, "Invalid item");
const UUID = z.string().uuid();

function revalidate() {
  revalidatePath("/home");
  revalidatePath("/tasks");
}

/** Unwrap a nested action result (the nested action re-authenticates and does its own permission checks + audit). */
function unwrap<T>(r: ActionResult<T>): T {
  if (!r.ok) throw new UserError(r.error);
  return r.data;
}

async function upsertSnooze(userId: string, itemKey: string, until: Date | null) {
  // Housekeeping (code review L11): dismissals older than 90 days are pruned — the rows they hid are long gone.
  await db
    .delete(s.queueSnoozes)
    .where(and(eq(s.queueSnoozes.userId, userId), isNull(s.queueSnoozes.until), lt(s.queueSnoozes.createdAt, new Date(Date.now() - DISMISSAL_TTL_DAYS * 86_400_000))))
    .catch(() => undefined);
  await db
    .insert(s.queueSnoozes)
    .values({ userId, itemKey, until })
    .onConflictDoUpdate({ target: [s.queueSnoozes.userId, s.queueSnoozes.itemKey], set: { until, createdAt: new Date() } });
}

/**
 * "Done" on a Today row: tasks → completed, alerts → resolved (both audited by their modules), everything else →
 * dismissed from Today (queue_snoozes.until = null). Reply rows are keyed by the thread's latest message
 * (`thread:<id>#<ms>`), so a new inbound message brings the thread back. Approvals, deals and grouped rows must be
 * acted on, not dismissed. Everything is undoable for a few minutes (queueRestore).
 */
export const queueDone = action(z.object({ key: ITEM_KEY }), async ({ key }, user) => {
  const k = parseQueueKey(key)!;
  if (k.kind === "task") unwrap(await setTaskStatus({ id: UUID.parse(k.id), status: "done" }));
  else if (k.kind === "alert") unwrap(await resolveAlert({ id: UUID.parse(k.id), note: "Done from Today" }));
  else if (k.kind === "approval" || k.kind === "deal" || k.kind === "group") throw new UserError("Open it to act — this one can only be snoozed.");
  else await upsertSnooze(user.id, key, null);
  revalidate();
  return { key, undoable: true };
});

export const queueSnooze = action(z.object({ key: ITEM_KEY, preset: z.enum(["1h", "tomorrow", "monday"]) }), async ({ key, preset }, user) => {
  const k = parseQueueKey(key)!;
  const until = snoozeUntil(preset, new Date(), user.timezone);
  const reason = "Snoozed from Today";
  if (k.kind === "task") unwrap(await snoozeTask({ id: UUID.parse(k.id), until: until.toISOString(), reason }));
  else if (k.kind === "alert") unwrap(await snoozeAlert({ id: UUID.parse(k.id), until: until.toISOString(), reason }));
  else await upsertSnooze(user.id, key, until);
  revalidate();
  return { key, until: until.toISOString(), undoable: true };
});

/**
 * Undo for Today (QA MAJ-01): reopen a task completed from Today, un-snooze a task, reopen an alert resolved or
 * snoozed from Today (only the recipient, only within UNDO_WINDOW_MS), or bring back a dismissed/snoozed derived row.
 */
export const queueRestore = action(z.object({ key: ITEM_KEY, from: z.enum(["done", "snooze"]).default("done") }), async ({ key, from }, user) => {
  const k = parseQueueKey(key)!;
  const plan = undoPlan(k.kind, from);
  if (plan === "task.reopen") unwrap(await setTaskStatus({ id: UUID.parse(k.id), status: "open" }));
  else if (plan === "task.unsnooze") await unsnoozeTask(user, UUID.parse(k.id));
  else if (plan === "alert.reopen") await reopenAlert(user, UUID.parse(k.id), from);
  else await db.delete(s.queueSnoozes).where(and(eq(s.queueSnoozes.userId, user.id), eq(s.queueSnoozes.itemKey, key)));
  revalidate();
  return { key };
});

async function unsnoozeTask(user: AppUser, id: string) {
  const [task] = await db.select().from(s.tasks).where(eq(s.tasks.id, id));
  if (!task) throw new UserError("Task not found.");
  if (!canEditTaskSync(user, await scopeFor(user, "tasks", "edit"), task)) throw new ForbiddenError();
  const [after] = await db.update(s.tasks).set({ snoozedUntil: null }).where(eq(s.tasks.id, id)).returning();
  await audit({ actorId: user.id, action: "task.unsnooze", entity: "task", entityId: id, before: task, after });
}

/** Reopen an alert the user themself resolved / snoozed from Today moments ago (the undo toast). */
async function reopenAlert(user: AppUser, id: string, from: "done" | "snooze") {
  const since = new Date(Date.now() - UNDO_WINDOW_MS);
  const [before] = await db.select().from(s.alerts).where(eq(s.alerts.id, id));
  if (!before || before.recipientId !== user.id) throw new UserError("That alert can't be restored.");
  const where =
    from === "done"
      ? and(eq(s.alerts.id, id), eq(s.alerts.recipientId, user.id), eq(s.alerts.state, "resolved"), gt(s.alerts.resolvedAt, since))
      : and(eq(s.alerts.id, id), eq(s.alerts.recipientId, user.id), eq(s.alerts.state, "snoozed"));
  try {
    const [after] = await db.update(s.alerts).set({ state: "open", resolvedAt: null, snoozedUntil: null, resolution: null }).where(where).returning();
    if (!after) throw new UserError("Too late to undo — the alert was already closed.");
    await audit({ actorId: user.id, action: "alert.reopen", entity: "alert", entityId: id, before, after: { ...after, via: "today_undo" } });
  } catch (e) {
    if (e instanceof UserError) throw e;
    // a fresh copy of the same alert was raised meanwhile (alerts_open_uq) — it's already back in Today
    throw new UserError("This alert is already back in Today.");
  }
}

/** Delegate a task (reassign, tasks.assign scope) or an alert (existing reassign flow). */
export const queueDelegate = action(z.object({ key: ITEM_KEY, userId: z.string().min(1).max(100) }), async ({ key, userId }, user) => {
  const k = parseQueueKey(key)!;
  if (userId === user.id) throw new UserError("Pick someone else.");
  if (k.kind === "alert") {
    // SEC M-1: the alert's title/detail name its subject — the receiver must be able to see it (restricted lists incl.).
    const id = UUID.parse(k.id);
    const [alert] = await db.select({ entity: s.alerts.entity, entityId: s.alerts.entityId }).from(s.alerts).where(eq(s.alerts.id, id));
    if (!alert) throw new UserError("Alert not found.");
    const target = await loadReceiver(userId, "alerts");
    await assertReceiverCanSee(target, await alertSubject(alert), "this alert");
    unwrap(await reassignAlert({ id, userId }));
    revalidate();
    return { key };
  }
  if (k.kind !== "task") throw new UserError("Only tasks and alerts can be delegated.");
  const id = UUID.parse(k.id);
  const [task] = await db.select().from(s.tasks).where(eq(s.tasks.id, id));
  if (!task) throw new UserError("Task not found.");
  if (task.status !== "open") throw new UserError("Only open tasks can be delegated.");
  if (!canEditTaskSync(user, await scopeFor(user, "tasks", "edit"), task)) throw new ForbiddenError();
  const scope = await assertCan(user, "tasks", "assign");
  if (!inScope(user, scope, { ownerId: userId }) && scope !== "pipeline") throw new ForbiddenError("You can't assign tasks to that person.");
  // Session-equivalent receiver (null for pending / banned / expired users).
  const target = await loadReceiver(userId, "tasks");
  // MNPI / scope: the receiver must be able to see the deal and account the task is about (restricted access lists incl.).
  await assertReceiverCanSee(target, task, "this task");
  const [after] = await db.update(s.tasks).set({ assigneeId: userId, snoozedUntil: null }).where(eq(s.tasks.id, id)).returning();
  await audit({ actorId: user.id, action: "task.delegate", entity: "task", entityId: id, before: task, after });
  await notify(userId, { kind: "task", title: `${user.name} handed you: ${task.title}`, href: `/tasks?task=${id}`, sensitive: await isSensitive(task) });
  revalidate();
  return { key, to: target.name };
});

/** The deal / account an alert is about (tasks resolve to their own deal/account). Unknown entities have none. */
async function alertSubject(a: { entity: string; entityId: string }): Promise<{ dealId: string | null; accountId: string | null }> {
  const id = a.entityId.split("#")[0] ?? "";
  if (!UUID.safeParse(id).success) return { dealId: null, accountId: null };
  if (a.entity === "deal") return { dealId: id, accountId: null };
  if (a.entity === "account") return { dealId: null, accountId: id };
  if (a.entity === "task") {
    const [t] = await db.select({ dealId: s.tasks.dealId, accountId: s.tasks.accountId }).from(s.tasks).where(eq(s.tasks.id, id));
    return t ?? { dealId: null, accountId: null };
  }
  if (a.entity === "proposal") {
    const [p] = await db.select({ dealId: s.proposals.dealId }).from(s.proposals).where(eq(s.proposals.id, id));
    return { dealId: p?.dealId ?? null, accountId: null };
  }
  if (a.entity === "email_thread") {
    const [t] = await db.select({ dealId: s.emailThreads.dealId, accountId: s.emailThreads.accountId }).from(s.emailThreads).where(eq(s.emailThreads.id, id));
    return t ?? { dealId: null, accountId: null };
  }
  return { dealId: null, accountId: null };
}

/* ───────────── { kind: "server" } actions from team providers ───────────── */

// Providers may (optionally) export `actions`; read it structurally so a provider without actions still type-checks.
const MODULES = { handoffs, help, signals, forecast, sequences, stories } as unknown as Record<string, { actions?: Record<string, QueueServerHandler> }>;

/** Dispatch "<provider>.<handler>" to the provider file's exported `actions` (handlers re-check permissions). */
export const runQueueAction = action(
  z.object({
    actionId: z.string().regex(/^[a-z]+\.[A-Za-z0-9_]+$/, "Unknown action"),
    payload: z.record(z.string().max(60), z.string().max(4000)).refine((p) => Object.keys(p).length <= 30, "Too many fields"),
  }),
  async ({ actionId, payload }, user) => {
    const [mod, name] = actionId.split(".") as [string, string];
    const own = (o: object | undefined, k: string) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);
    const actions = own(MODULES, mod) ? MODULES[mod]!.actions : undefined;
    const handler = own(actions, name) ? actions![name] : undefined;
    if (typeof handler !== "function") throw new UserError("That action is no longer available.");
    const res = (await handler(user, payload)) ?? {};
    revalidate();
    // Only same-origin paths ("/deals/…"), never "//host" or absolute URLs.
    const href = safeQueueHref(res.href);
    return { message: res.message ?? null, keep: Boolean(res.keep), href };
  },
);
