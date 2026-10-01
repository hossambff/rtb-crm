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
import { isSensitiveEntity, resolveSubject, type Subject } from "@/lib/notifications/sensitive";
import { assertReceiverCanSee, loadReceiver } from "@/lib/rbac/receiver";
import { runSweep } from "./engine";
import { alertHref } from "./rules";
import { recordSweep } from "@/lib/background";

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
    .set({ state: "resolved", resolvedAt: new Date(), snoozedUntil: null, resolution: note ? `Done: ${note}` : `Done by ${user.name}` }) // live suppression (suppression.ts)
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
    .set({ state: "dismissed", resolvedAt: new Date(), snoozedUntil: null, resolution: `Dismissed: ${reason}` }) // live suppression (suppression.ts)
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
  // Session-equivalent receiver (null for pending / banned / expired / removed-domain users).
  const target = await loadReceiver(userId, "alerts");
  // SEC M-1: the alert's title/detail name its subject — the receiver must be able to see that deal / account (incl.
  // restricted access lists). Unresolvable subjects fail closed.
  let subject: Subject | null;
  try {
    subject = await resolveSubject(before.entity, before.entityId);
  } catch {
    throw new UserError("This alert can't be reassigned — resolve it or ask an admin.");
  }
  if (subject) await assertReceiverCanSee(target, subject, "this alert");
  try {
    const [after] = await db.update(s.alerts).set({ recipientId: userId, state: "open", snoozedUntil: null }).where(eq(s.alerts.id, id)).returning();
    await audit({ actorId: user.id, action: "alert.reassign", entity: "alert", entityId: id, before, after });
  } catch {
    // target already has this exact alert open (unique index) → close ours as a duplicate
    await db.update(s.alerts).set({ state: "resolved", resolvedAt: new Date(), resolution: "Duplicate after reassignment" }).where(eq(s.alerts.id, id));
    await audit({ actorId: user.id, action: "alert.reassign_merge", entity: "alert", entityId: id, before });
  }
  await notify(userId, { kind: "alert", severity: before.severity, title: `${user.name} assigned you an alert: ${before.title}`, body: before.detail, href: alertHref(before.entity, before.entityId), sensitive: await isSensitiveEntity(before.entity, before.entityId) });
  revalidate();
  return { id };
});

/** Admin-only "Run sweep now". */
export const runSweepNow = action(z.object({}), async (_input, user) => {
  await assertCan(user, "admin", "configure", "all");
  const stats = await runSweep();
  await recordSweep();
  await audit({ actorId: user.id, action: "alerts.sweep_manual", entity: "alerts", after: stats });
  revalidate();
  return stats;
});
