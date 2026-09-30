"use server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, ForbiddenError, inScope, scopeFor, type AppUser } from "@/lib/rbac/server";
import { notify } from "@/lib/notifications/notify";
import { runSweep } from "./engine";
import { alertHref } from "./rules";

const id = z.string().uuid();
const CLOSED = ["resolved", "dismissed"];

function revalidate() {
  revalidatePath("/tasks");
  revalidatePath("/home");
}

/** The recipient may act on an alert; so may anyone with tasks.assign scope covering the recipient (managers/admins). */
async function loadActionable(user: AppUser, alertId: string) {
  const [a] = await db.select().from(s.alerts).where(eq(s.alerts.id, alertId));
  if (!a) throw new UserError("Alert not found.");
  if (a.recipientId !== user.id) {
    const scope = await scopeFor(user, "tasks", "assign");
    if (!inScope(user, scope, { ownerId: a.recipientId })) throw new ForbiddenError();
  }
  if (CLOSED.includes(a.state)) throw new UserError("This alert is already closed.");
  return a;
}

export const resolveAlert = action(z.object({ id, note: z.string().trim().max(500).nullish() }), async ({ id, note }, user) => {
  const before = await loadActionable(user, id);
  const [after] = await db
    .update(s.alerts)
    .set({ state: "resolved", resolvedAt: new Date(), resolution: note ? `Done: ${note}` : `Done by ${user.name}` })
    .where(eq(s.alerts.id, id))
    .returning();
  await audit({ actorId: user.id, action: "alert.resolve", entity: "alert", entityId: id, before, after });
  revalidate();
  return { id };
});

export const snoozeAlert = action(
  z.object({
    id,
    until: z
      .string()
      .refine((v) => !Number.isNaN(new Date(v).getTime()), "Invalid date")
      .transform((v) => new Date(v)),
    reason: z.string().trim().min(3, "Give a short reason").max(500),
  }),
  async ({ id, until, reason }, user) => {
    if (until.getTime() <= Date.now()) throw new UserError("Pick a time in the future.");
    if (until.getTime() > Date.now() + 90 * 86_400_000) throw new UserError("Snooze for at most 90 days.");
    const before = await loadActionable(user, id);
    const [after] = await db
      .update(s.alerts)
      .set({ state: "snoozed", snoozedUntil: until, resolution: `Snoozed: ${reason}` })
      .where(eq(s.alerts.id, id))
      .returning();
    await audit({ actorId: user.id, action: "alert.snooze", entity: "alert", entityId: id, before, after: { ...after, reason } });
    revalidate();
    return { id };
  },
);

export const dismissAlert = action(z.object({ id, reason: z.string().trim().min(3, "A reason is required").max(500) }), async ({ id, reason }, user) => {
  const before = await loadActionable(user, id);
  const [after] = await db
    .update(s.alerts)
    .set({ state: "dismissed", resolvedAt: new Date(), resolution: `Dismissed: ${reason}` })
    .where(eq(s.alerts.id, id))
    .returning();
  await audit({ actorId: user.id, action: "alert.dismiss", entity: "alert", entityId: id, before, after: { ...after, reason } });
  revalidate();
  return { id };
});

export const reassignAlert = action(z.object({ id, userId: z.string().min(1) }), async ({ id, userId }, user) => {
  const before = await loadActionable(user, id);
  if (userId === before.recipientId) return { id };
  const scope = await assertCan(user, "tasks", "assign");
  if (!inScope(user, scope, { ownerId: userId }) && scope !== "pipeline") throw new ForbiddenError("You can't reassign to that person.");
  const [target] = await db.select({ id: s.user.id, role: s.user.role, banned: s.user.banned }).from(s.user).where(eq(s.user.id, userId));
  if (!target || target.role === "pending" || target.banned) throw new UserError("That user can't receive alerts.");
  try {
    const [after] = await db.update(s.alerts).set({ recipientId: userId, state: "open", snoozedUntil: null }).where(eq(s.alerts.id, id)).returning();
    await audit({ actorId: user.id, action: "alert.reassign", entity: "alert", entityId: id, before, after });
  } catch {
    // target already has this exact alert open (unique index) → close ours as a duplicate
    await db.update(s.alerts).set({ state: "resolved", resolvedAt: new Date(), resolution: "Duplicate after reassignment" }).where(eq(s.alerts.id, id));
    await audit({ actorId: user.id, action: "alert.reassign_merge", entity: "alert", entityId: id, before });
  }
  await notify(userId, { kind: "alert", title: `${user.name} assigned you an alert: ${before.title}`, body: before.detail, href: alertHref(before.entity, before.entityId) });
  revalidate();
  return { id };
});

/** Admin-only "Run sweep now". */
export const runSweepNow = action(z.object({}), async (_input, user) => {
  await assertCan(user, "admin", "configure", "all");
  const stats = await runSweep();
  await audit({ actorId: user.id, action: "alerts.sweep_manual", entity: "alerts", after: stats });
  revalidate();
  return stats;
});
