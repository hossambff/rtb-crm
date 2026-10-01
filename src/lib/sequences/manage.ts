import "server-only";
import { and, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { isUniqueViolation } from "@/lib/admin/config-schemas";
import { audit } from "@/lib/audit";
import { contactVisibilityWhere } from "@/lib/contacts/queries";
import { ForbiddenError, type AppUser } from "@/lib/rbac/server";
import { isSequenceAdmin } from "./access";
import { isSystemPause, jitterMinutes, normalizeWindow, scheduleAfter, stepsForEnrollment, type HistoryEntry } from "./core";

type Row = typeof s.sequenceEnrollments.$inferSelect;

/**
 * Enrollments the user may pause/resume/stop/retry: the mailbox owner, whoever enrolled them, or an admin — and the
 * contact must be visible to the user. By default any id outside that set fails the whole request (no partial
 * surprises); `lenient` (bulk "resume all") just skips them.
 */
export async function manageableEnrollments(user: AppUser, ids: string[], opts: { lenient?: boolean } = {}): Promise<Row[]> {
  const admin = await isSequenceAdmin(user);
  const visible = await contactVisibilityWhere(user);
  const rows = await db
    .select({ e: s.sequenceEnrollments })
    .from(s.sequenceEnrollments)
    .innerJoin(s.contacts, eq(s.contacts.id, s.sequenceEnrollments.contactId))
    .where(and(inArray(s.sequenceEnrollments.id, [...new Set(ids)]), visible, admin ? sql`true` : or(eq(s.sequenceEnrollments.senderId, user.id), eq(s.sequenceEnrollments.enrolledBy, user.id))));
  if (opts.lenient) return rows.map((r) => r.e);
  if (!rows.length) throw new UserError("Enrollment not found.");
  if (rows.length !== new Set(ids).size) throw new ForbiddenError("You can only manage enrollments from your own mailbox (or that you enrolled).");
  return rows.map((r) => r.e);
}

export type EnrollmentOp = "pause" | "resume" | "stop" | "retry" | "skip";

const FROM: Record<EnrollmentOp, string[]> = {
  pause: ["active"],
  resume: ["paused"],
  stop: ["active", "paused", "failed"],
  retry: ["failed", "paused"],
  skip: ["active", "paused", "failed"],
};

const hist = (e: HistoryEntry) => sql`${s.sequenceEnrollments.history} || ${JSON.stringify([e])}::jsonb`;

/** When the step after `currentStep` should run after a manual skip: its own delay in the sender's window (QA MIN-26). */
async function nextRunAfterSkip(r: Row, delayDays: number, now: Date): Promise<Date> {
  const [u] = await db.select({ tz: s.user.timezone, start: s.user.workStartHour, end: s.user.workEndHour }).from(s.user).where(eq(s.user.id, r.senderId));
  const w = normalizeWindow({ tz: u?.tz, startHour: u?.start, endHour: u?.end });
  return scheduleAfter(now, delayDays, w, jitterMinutes(`${r.id}:${r.currentStep + 1}`));
}

/**
 * Apply a manual state change; every change is guarded by the current status (races with the runner are no-ops).
 * Re-activating a row whose contact was re-enrolled meanwhile hits the (sequence, contact) unique index — reported as
 * a clear error instead of "Something went wrong" (CR L14).
 */
export async function setEnrollmentState(user: AppUser, rows: Row[], op: EnrollmentOp): Promise<number> {
  const now = new Date();
  const at = now.toISOString();
  const changed: string[] = [];
  let conflicts = 0;
  for (const r of rows) {
    if (!FROM[op].includes(r.status)) continue;
    const guard = and(eq(s.sequenceEnrollments.id, r.id), eq(s.sequenceEnrollments.status, r.status), eq(s.sequenceEnrollments.currentStep, r.currentStep));
    let set: Parameters<ReturnType<typeof db.update<typeof s.sequenceEnrollments>>["set"]>[0];
    switch (op) {
      case "pause":
        // ok=true + by: a person paused on purpose — "Resume all" never lifts it (QA MAJ-12)
        set = { status: "paused", lastError: null, history: hist({ step: r.currentStep, at, kind: "paused", ok: true, note: "manual", by: user.id }) };
        break;
      case "resume":
        set = { status: "active", lastError: null, nextRunAt: sql`greatest(coalesce(${s.sequenceEnrollments.nextRunAt}, now()), now())`, history: hist({ step: r.currentStep, at, kind: "resumed", ok: true, by: user.id }) };
        break;
      case "retry":
        set = { status: "active", exitReason: null, lastError: null, nextRunAt: now, history: hist({ step: r.currentStep, at, kind: "retry", ok: true, by: user.id }) };
        break;
      case "stop":
        set = { status: "exited", exitReason: "manual", nextRunAt: null, history: hist({ step: r.currentStep, at, kind: "exit", ok: true, note: "manual", by: user.id }) };
        break;
      case "skip": {
        const [seq] = await db.select({ steps: s.sequences.steps, version: s.sequences.version }).from(s.sequences).where(eq(s.sequences.id, r.sequenceId));
        const steps = (seq ? stepsForEnrollment(r, seq) : null) ?? [];
        const next = r.currentStep + 1;
        const entry = hist({ step: r.currentStep, at, kind: "skipped", ok: true, note: "manual", by: user.id });
        set =
          next >= steps.length
            ? { status: "completed", currentStep: next, exitReason: null, lastError: null, nextRunAt: null, history: entry }
            : { status: "active", currentStep: next, exitReason: null, lastError: null, nextRunAt: await nextRunAfterSkip(r, steps[next]!.delayDays, now), history: entry };
        break;
      }
    }
    let u: { id: string } | undefined;
    try {
      [u] = await db.update(s.sequenceEnrollments).set(set).where(guard).returning({ id: s.sequenceEnrollments.id });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      conflicts++;
      continue;
    }
    if (!u) continue;
    changed.push(r.id);
    if (op === "stop" || op === "skip") {
      const pattern = op === "stop" ? `sequence:${r.id}:%` : `sequence:${r.id}:${r.currentStep}`;
      await db
        .update(s.tasks)
        .set({ status: "cancelled" })
        .where(and(eq(s.tasks.origin, "sequence"), eq(s.tasks.status, "open"), like(s.tasks.evidenceSource, pattern)));
    }
  }
  if (changed.length) await audit({ actorId: user.id, action: `sequence_enrollment.${op}`, entity: "sequence_enrollment", entityId: changed.length === 1 ? changed[0] : undefined, after: { ids: changed, count: changed.length } });
  if (conflicts && !changed.length) {
    throw new UserError(
      conflicts === 1
        ? "This contact was enrolled in the sequence again since — manage the newer enrollment instead."
        : `${conflicts} contacts were enrolled in the sequence again since — manage the newer enrollments instead.`,
    );
  }
  return changed.length;
}

/**
 * "Resume all" (Today queue + sequences page): resumes enrollments in MY mailbox that the SYSTEM paused (Gmail
 * disconnected, sender inactive, edited sequence…). Enrollments a person paused on purpose stay paused (QA MAJ-12).
 */
export async function resumeSystemPaused(user: AppUser, sequenceId?: string): Promise<{ changed: number; keptManual: number }> {
  const rows = await db
    .select({ id: s.sequenceEnrollments.id, history: s.sequenceEnrollments.history, lastError: s.sequenceEnrollments.lastError })
    .from(s.sequenceEnrollments)
    .innerJoin(s.sequences, eq(s.sequences.id, s.sequenceEnrollments.sequenceId))
    .where(
      and(
        eq(s.sequenceEnrollments.senderId, user.id),
        eq(s.sequenceEnrollments.status, "paused"),
        isNotNull(s.sequenceEnrollments.lastError),
        isNull(s.sequences.deletedAt),
        sequenceId ? eq(s.sequenceEnrollments.sequenceId, sequenceId) : undefined,
      ),
    )
    .limit(500);
  const system = rows.filter((r) => isSystemPause(r.history as HistoryEntry[], r.lastError));
  const [{ n: totalPaused } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.sequenceEnrollments)
    .where(and(eq(s.sequenceEnrollments.senderId, user.id), eq(s.sequenceEnrollments.status, "paused"), sequenceId ? eq(s.sequenceEnrollments.sequenceId, sequenceId) : undefined));
  if (!system.length) return { changed: 0, keptManual: Number(totalPaused) };
  const manageable = await manageableEnrollments(
    user,
    system.map((r) => r.id),
    { lenient: true },
  );
  const changed = manageable.length ? await setEnrollmentState(user, manageable, "resume").catch((e) => (e instanceof UserError ? 0 : Promise.reject(e))) : 0;
  return { changed, keptManual: Math.max(0, Number(totalPaused) - system.length) };
}
