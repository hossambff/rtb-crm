"use server";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { checkClaims, type ClaimHit } from "@/lib/claims";
import { contactVisibilityWhere } from "@/lib/contacts/queries";
import { notify } from "@/lib/notifications/notify";
import { assertCan, ForbiddenError, type AppUser } from "@/lib/rbac/server";
import { canEditSequence, GMAIL_CONNECT_HREF, isSequenceAdmin, sequenceVisibleWhere } from "./access";
import { buildVariables, canApplyNewSteps, MAX_ENROLL_BATCH, MAX_STEPS, missingForSteps, normalizeSteps, OPT_OUT_HINT, renderTemplate, stepSchema, stepsEqual, subjectForStep, validateSequence, type HistoryEntry, type Step } from "./core";
import { enrollContacts } from "./enroll";
import { manageableEnrollments, resumeSystemPaused, setEnrollmentState } from "./manage";
import { enrollReadiness, listEnrollableSequences, searchEnrollableContacts, senderOptions } from "./queries";

const uuid = z.uuid();

function revalidate(id?: string) {
  revalidatePath("/sequences");
  if (id) revalidatePath(`/sequences/${id}`);
}

async function editable(user: AppUser, id: string) {
  await assertCan(user, "email", "view");
  const [seq] = await db.select().from(s.sequences).where(and(eq(s.sequences.id, id), await sequenceVisibleWhere(user)));
  if (!seq) throw new UserError("Sequence not found.");
  if (!canEditSequence(user, await isSequenceAdmin(user), seq)) throw new ForbiddenError("Only the owner (or an admin) can change this sequence.");
  return seq;
}

const DEFAULT_STEPS: Step[] = [
  { kind: "email", delayDays: 0, subject: "Idea for {{company}}", body: `Hi {{first_name}},\n\n{{opener|I've been following your coverage and had an idea worth sharing.}}\n\nRTB helps independent publishers grow revenue with a full-stack media platform on a revenue share. Worth a 20-minute look?\n\nBest,\n{{sender_first_name}}\n\n${OPT_OUT_HINT}`, replyInThread: false },
  { kind: "email", delayDays: 3, body: "Hi {{first_name}}, bumping this in case it got buried. Happy to share how similar publishers set it up.\n\n{{sender_first_name}}", replyInThread: true },
  { kind: "linkedin", delayDays: 2, title: "Connect with {{full_name}} on LinkedIn" },
  { kind: "email", delayDays: 4, body: "Hi {{first_name}}, last note from me. If timing is off, just say so and I'll circle back next quarter.\n\n{{sender_first_name}}", replyInThread: true },
];

export const createSequence = action(z.object({ name: z.string().trim().min(2, "Name the sequence").max(120), duplicateOf: uuid.optional() }), async (input, user) => {
  await assertCan(user, "email", "view");
  let steps = DEFAULT_STEPS;
  let exitOn = { reply: true, meetingBooked: true, stageChange: true, unsubscribe: true };
  let dailyCap = 40;
  let description: string | null = null;
  let pipelineKeys: string[] = [];
  if (input.duplicateOf) {
    const [src] = await db.select().from(s.sequences).where(and(eq(s.sequences.id, input.duplicateOf), await sequenceVisibleWhere(user)));
    if (!src) throw new UserError("Sequence not found.");
    steps = src.steps as Step[];
    exitOn = { ...exitOn, ...(src.exitOn as typeof exitOn) };
    dailyCap = src.dailyCap;
    description = src.description;
    pipelineKeys = src.pipelineKeys;
  }
  const [row] = await db
    .insert(s.sequences)
    .values({ name: input.name, description, ownerId: user.id, shared: true, steps: normalizeSteps(steps), exitOn, dailyCap, pipelineKeys, active: true })
    .returning({ id: s.sequences.id });
  await audit({ actorId: user.id, action: "sequence.create", entity: "sequence", entityId: row!.id, after: { name: input.name, duplicateOf: input.duplicateOf ?? null } });
  revalidate();
  return { id: row!.id };
});

const saveInput = z.object({
  id: uuid,
  name: z.string().trim().min(2, "Name the sequence").max(120),
  description: z.string().trim().max(500).nullable().optional(),
  steps: z.array(stepSchema).min(1, "Add at least one step").max(MAX_STEPS),
  exitOn: z.object({ reply: z.boolean(), meetingBooked: z.boolean(), stageChange: z.boolean(), unsubscribe: z.boolean() }),
  dailyCap: z.number().int().min(1).max(200),
  shared: z.boolean(),
  pipelineKeys: z.array(z.string().max(10)).max(10).default([]),
  confirmed: z.boolean().default(false),
});

export type SaveSequenceResult = { status: "saved"; problems: string[] } | { status: "confirm"; hits: ClaimHit[] };

export const saveSequence = action(saveInput, async (input, user): Promise<SaveSequenceResult> => {
  const before = await editable(user, input.id);
  const steps = normalizeSteps(input.steps as Step[]);
  const problems = validateSequence(steps);
  // claims guardrail (PRD §11.5) on every template: banned claims in block mode refuse; other hits need a confirm
  const text = steps.map((st) => [st.subject, st.body, st.title].filter(Boolean).join("\n")).join("\n\n");
  const claims = await checkClaims(text);
  if (claims.blocked) {
    const banned = claims.hits.filter((h) => h.status === "banned");
    throw new UserError(`Blocked by the claims policy: ${banned.map((h) => `“${h.match}”${h.alternative ? ` → use “${h.alternative}”` : ""}`).join("; ")}.`);
  }
  if (claims.hits.length && !input.confirmed) return { status: "confirm", hits: claims.hits };
  const after = {
    name: input.name,
    description: input.description ?? null,
    steps,
    exitOn: { ...input.exitOn, unsubscribe: true }, // CON-6: always honored
    dailyCap: input.dailyCap,
    shared: input.shared,
    pipelineKeys: input.pipelineKeys,
  };
  // SEC H-3 / CR H-3: a step change creates a new VERSION. Active enrollments keep the snapshot they were enrolled
  // with (the runner never reads the live steps for them); the owner can apply the new steps explicitly.
  const stepsChanged = !stepsEqual(before.steps as Step[], steps);
  const [saved] = await db
    .update(s.sequences)
    .set({ ...after, ...(stepsChanged ? { version: sql`${s.sequences.version} + 1` } : {}) })
    .where(eq(s.sequences.id, input.id))
    .returning({ version: s.sequences.version });
  await audit({
    actorId: user.id,
    action: "sequence.update",
    entity: "sequence",
    entityId: input.id,
    before: { name: before.name, steps: before.steps, exitOn: before.exitOn, dailyCap: before.dailyCap, shared: before.shared, version: before.version },
    after: { ...after, version: saved?.version ?? before.version, stepsChanged, claimsConfirmed: claims.hits.length > 0 },
  });
  revalidate(input.id);
  return { status: "saved", problems };
});

/**
 * Explicit, confirmed "apply the new steps to people already in this sequence" (owner or admin). Only enrollments whose
 * completed steps line up with the new version switch (otherwise an earlier email could go out again, or a step be
 * skipped); the rest keep their snapshot. Every affected sender is notified — the content now leaving their mailbox
 * changed.
 */
export const applyNewStepsToEnrollments = action(z.object({ id: uuid, confirmed: z.literal(true) }), async ({ id }, user) => {
  const seq = await editable(user, id);
  const latest = normalizeSteps(seq.steps as Step[]);
  const problems = validateSequence(latest);
  if (problems.length) throw new UserError(`Fix the sequence first: ${problems[0]}`);
  const rows = await db
    .select()
    .from(s.sequenceEnrollments)
    .where(
      and(
        eq(s.sequenceEnrollments.sequenceId, id),
        inArray(s.sequenceEnrollments.status, ["active", "paused"]),
        sql`coalesce(${s.sequenceEnrollments.stepsVersion}, 1) < ${seq.version}`,
      ),
    )
    .limit(2000);
  const at = new Date().toISOString();
  const applied: { id: string; senderId: string }[] = [];
  let skipped = 0;
  for (const r of rows) {
    const prev = Array.isArray(r.stepsSnapshot) && r.stepsSnapshot.length ? (r.stepsSnapshot as Step[]) : null;
    // legacy rows without a snapshot: we can't prove what they already sent, so only switch the ones that haven't started
    const ok = prev ? canApplyNewSteps(prev, latest, r.currentStep) : r.currentStep === 0;
    if (!ok) {
      skipped++;
      continue;
    }
    const entry: HistoryEntry = { step: r.currentStep, at, kind: "steps_updated", ok: true, note: `v${r.stepsVersion ?? 1} → v${seq.version}`, by: user.id };
    const [u] = await db
      .update(s.sequenceEnrollments)
      .set({ stepsSnapshot: latest, stepsVersion: seq.version, history: sql`${s.sequenceEnrollments.history} || ${JSON.stringify([entry])}::jsonb` })
      .where(and(eq(s.sequenceEnrollments.id, r.id), eq(s.sequenceEnrollments.currentStep, r.currentStep), inArray(s.sequenceEnrollments.status, ["active", "paused"])))
      .returning({ id: s.sequenceEnrollments.id });
    if (u) applied.push({ id: r.id, senderId: r.senderId });
    else skipped++;
  }
  const bySender = new Map<string, number>();
  for (const a of applied) bySender.set(a.senderId, (bySender.get(a.senderId) ?? 0) + 1);
  for (const [senderId, n] of bySender) {
    if (senderId === user.id) continue;
    await notify(senderId, {
      kind: "task",
      title: `${user.name} updated “${seq.name}” for ${n} of your enrollment${n === 1 ? "" : "s"}`,
      body: "The next emails from your mailbox use the new steps. Review them, or pause the enrollments on the sequence page.",
      href: `/sequences/${seq.id}`,
    });
  }
  if (applied.length || skipped)
    await audit({ actorId: user.id, action: "sequence.apply_version", entity: "sequence", entityId: id, after: { version: seq.version, applied: applied.length, skipped, senders: [...bySender.keys()], enrollmentIds: applied.map((a) => a.id).slice(0, 500) } });
  revalidate(id);
  return { applied: applied.length, skipped };
});

export const setSequenceActive = action(z.object({ id: uuid, active: z.boolean() }), async ({ id, active }, user) => {
  const before = await editable(user, id);
  await db.update(s.sequences).set({ active }).where(eq(s.sequences.id, id));
  if (active) {
    // enrollments that came due while paused run on the next tick (inside working hours)
    await db.update(s.sequenceEnrollments).set({ nextRunAt: sql`greatest(${s.sequenceEnrollments.nextRunAt}, now())` }).where(and(eq(s.sequenceEnrollments.sequenceId, id), eq(s.sequenceEnrollments.status, "active")));
  }
  await audit({ actorId: user.id, action: active ? "sequence.resume" : "sequence.pause", entity: "sequence", entityId: id, before: { active: before.active }, after: { active } });
  revalidate(id);
  return { active };
});

export const deleteSequence = action(z.object({ id: uuid }), async ({ id }, user) => {
  const before = await editable(user, id);
  await db.update(s.sequences).set({ deletedAt: new Date(), active: false }).where(eq(s.sequences.id, id));
  const stopped = await db
    .update(s.sequenceEnrollments)
    .set({ status: "exited", exitReason: "manual", nextRunAt: null, history: sql`${s.sequenceEnrollments.history} || ${JSON.stringify([{ step: -1, at: new Date().toISOString(), kind: "exit", ok: true, note: "sequence deleted" }])}::jsonb` })
    .where(and(eq(s.sequenceEnrollments.sequenceId, id), inArray(s.sequenceEnrollments.status, ["active", "paused"])))
    .returning({ id: s.sequenceEnrollments.id });
  await audit({ actorId: user.id, action: "sequence.delete", entity: "sequence", entityId: id, before: { name: before.name }, after: { stoppedEnrollments: stopped.length } });
  revalidate(id);
  return { stopped: stopped.length };
});

/** Builder preview: render every step for a real contact the user can see (sender = the current user). */
export const previewSequence = action(z.object({ steps: z.array(stepSchema).min(1).max(MAX_STEPS), contactId: uuid, variables: z.record(z.string(), z.string().max(1000)).optional() }), async (input, user) => {
  await assertCan(user, "email", "view");
  const visible = await contactVisibilityWhere(user);
  const [c] = await db
    .select({ fullName: s.contacts.fullName, firstName: s.contacts.firstName, lastName: s.contacts.lastName, title: s.contacts.title, email: s.contacts.email, company: s.accounts.name, dnc: s.contacts.doNotContact })
    .from(s.contacts)
    .leftJoin(s.accounts, eq(s.accounts.id, s.contacts.accountId))
    .where(and(eq(s.contacts.id, input.contactId), visible));
  if (!c) throw new UserError("Contact not found.");
  const steps = normalizeSteps(input.steps as Step[]);
  const vars = buildVariables(c, { name: user.name }, input.variables ?? {});
  return {
    contact: { name: c.fullName, email: c.email, dnc: c.dnc },
    steps: steps.map((st, i) => {
      const subject = st.kind === "email" ? renderTemplate(subjectForStep(steps, i), vars) : renderTemplate(st.title ?? "", vars);
      const body = renderTemplate(st.body ?? "", vars);
      return { kind: st.kind, subject: subject.text, body: body.text, missing: [...new Set([...subject.missing, ...body.missing])] };
    }),
    blocked: missingForSteps(steps, vars).length > 0,
  };
});

/* ───────────────────────────── Enrollment ───────────────────────────── */

const enrollInput = z.object({
  sequenceId: uuid,
  contactIds: z.array(uuid).max(MAX_ENROLL_BATCH).optional(),
  dealIds: z.array(uuid).max(MAX_ENROLL_BATCH).optional(),
  accountIds: z.array(uuid).max(MAX_ENROLL_BATCH).optional(),
  senderId: z.string().max(80).nullable().optional(),
  dealId: uuid.nullable().optional(),
  variables: z.record(z.string(), z.string().max(1000)).optional(),
  source: z.enum(["contact", "deal", "account", "list", "scout", "sequence_page", "command"]).default("list"),
});

/**
 * Enroll contacts (directly, or resolved from deals / accounts) into a sequence. ≤ 100 contacts per call.
 * Exported for WS-F (/deals bulk bar, ⌘K). Returns { enrolled, enrollmentIds, skipped: {id, name, reason}[], sequenceName }.
 */
export const enrollInSequence = action(enrollInput, async (input, user) => {
  if (!input.contactIds?.length && !input.dealIds?.length && !input.accountIds?.length) throw new UserError("Pick at least one contact.");
  const r = await enrollContacts(user, { contactIds: input.contactIds, dealIds: input.dealIds, accountIds: input.accountIds }, { sequenceId: input.sequenceId, senderId: input.senderId, variables: input.variables, dealId: input.dealId, source: input.source });
  revalidate(input.sequenceId);
  for (const d of [...(input.dealIds ?? []), ...(input.dealId ? [input.dealId] : [])]) revalidatePath(`/deals/${d}`);
  return r;
});

/** Data for the enroll dialog: sequences I can use, whether my Gmail is ready, and senders (admins only). */
export const getEnrollOptions = action(z.object({}), async (_i, user) => {
  await assertCan(user, "email", "view");
  const [sequences, ready, senders] = await Promise.all([listEnrollableSequences(user), enrollReadiness(user), senderOptions(user)]);
  return { sequences: sequences.map((q) => ({ id: q.id, name: q.name, stepCount: q.stepCount, hasEmail: q.hasEmail })), gmailReady: ready.gmailReady, connectHref: GMAIL_CONNECT_HREF, senders, me: user.id };
});

export const searchContactsForEnroll = action(z.object({ q: z.string().max(100).default("") }), async ({ q }, user) => {
  await assertCan(user, "email", "view");
  return searchEnrollableContacts(user, q, 20);
});

/* ───────────────────────────── Enrollment controls ───────────────────────────── */

const idsInput = z.object({ ids: z.array(uuid).min(1).max(500) });

export const pauseEnrollments = action(idsInput, async ({ ids }, user) => {
  const rows = await manageableEnrollments(user, ids);
  const n = await setEnrollmentState(user, rows, "pause");
  revalidate(rows[0]?.sequenceId);
  return { changed: n };
});

export const resumeEnrollments = action(idsInput, async ({ ids }, user) => {
  const rows = await manageableEnrollments(user, ids);
  const n = await setEnrollmentState(user, rows, "resume");
  revalidate(rows[0]?.sequenceId);
  return { changed: n };
});

export const stopEnrollments = action(idsInput, async ({ ids }, user) => {
  const rows = await manageableEnrollments(user, ids);
  const n = await setEnrollmentState(user, rows, "stop");
  revalidate(rows[0]?.sequenceId);
  return { changed: n };
});

/** Failed → active again (attempt counter resets). */
export const retryEnrollment = action(z.object({ id: uuid }), async ({ id }, user) => {
  const rows = await manageableEnrollments(user, [id]);
  const n = await setEnrollmentState(user, rows, "retry");
  if (!n) throw new UserError("Only failed or paused enrollments can be retried.");
  revalidate(rows[0]?.sequenceId);
  return { changed: n };
});

/** Skip the current step (e.g. after checking Sent yourself) and continue with the next one. */
export const skipEnrollmentStep = action(z.object({ id: uuid }), async ({ id }, user) => {
  const rows = await manageableEnrollments(user, [id]);
  const n = await setEnrollmentState(user, rows, "skip");
  if (!n) throw new UserError("Nothing to skip.");
  revalidate(rows[0]?.sequenceId);
  return { changed: n };
});

/**
 * Resume enrollments in MY mailbox that the system paused (e.g. after reconnecting Gmail). Enrollments a person paused
 * on purpose stay paused (QA MAJ-12) — `keptManual` tells the UI how many.
 */
export const resumeMyPaused = action(z.object({ sequenceId: uuid.optional() }), async ({ sequenceId }, user) => {
  await assertCan(user, "email", "view");
  const r = await resumeSystemPaused(user, sequenceId);
  revalidate(sequenceId);
  return r;
});
