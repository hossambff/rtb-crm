import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { accountVisibilityWhere } from "@/lib/accounts/queries";
import { contactVisibilityWhere } from "@/lib/contacts/queries";
import { notify } from "@/lib/notifications/notify";
import { assertCan, dealAccessWhere, ForbiddenError, loadAppUserById, type AppUser } from "@/lib/rbac/server";
import { suppressedEmails } from "@/lib/scout/crm-match";
import { gmailStatus, GMAIL_REQUIRED_MESSAGE, isSequenceAdmin, sequenceVisibleWhere } from "./access";
import { buildVariables, jitterMinutes, MAX_ENROLL_BATCH, missingForSteps, normalizeSteps, normalizeWindow, scheduleAfter, validateSequence, type Step } from "./core";

export type EnrollTarget = { contactIds?: string[]; dealIds?: string[]; accountIds?: string[] };
export type EnrollSource = "contact" | "deal" | "account" | "list" | "scout" | "sequence_page" | "command";
export type EnrollOptions = {
  sequenceId: string;
  senderId?: string | null;
  /** Variables for every contact (e.g. a shared opener). */
  variables?: Record<string, string>;
  /** Per-contact variables (Lead Scout openers), keyed by contact id; win over `variables`. */
  perContact?: Record<string, Record<string, string>>;
  /** Link every enrolled contact to this deal (stage-change exit, deal activity). Must be visible to the caller. */
  dealId?: string | null;
  source: EnrollSource;
};
export type EnrollSkip = { id: string; name: string; reason: string };
export type EnrollResult = { enrolled: number; enrollmentIds: string[]; skipped: EnrollSkip[]; sequenceName: string };

const VAR_KEY = /^[a-z_][a-z0-9_]{0,40}$/;
function cleanVars(v: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v ?? {})) {
    const key = k.toLowerCase();
    if (VAR_KEY.test(key) && typeof val === "string" && val.trim()) out[key] = val.trim().slice(0, 1000);
  }
  return out;
}

/** Load a sequence the user may enroll into (visible, not deleted). Throws a user-facing error otherwise. */
export async function loadEnrollableSequence(user: AppUser, sequenceId: string) {
  const [seq] = await db.select().from(s.sequences).where(and(eq(s.sequences.id, sequenceId), await sequenceVisibleWhere(user)));
  if (!seq) throw new UserError("That sequence isn't available.");
  if (!seq.active) throw new UserError("That sequence is paused. Resume it before enrolling.");
  const problems = validateSequence(seq.steps as Step[]);
  if (problems.length) throw new UserError(`Fix the sequence first: ${problems[0]}`);
  return seq;
}

/**
 * THE enrollment path (contact, deal, account, list, Lead Scout, ⌘K). Permission rules:
 * - caller needs `email.view`; contacts must be visible to the caller (scope + restricted accounts); deals via
 *   dealAccessWhere (MNPI access lists) and accounts via accountVisibilityWhere;
 * - the sender is the caller unless the caller is an admin; a sender without Gmail send permission cannot enroll;
 * - do-not-contact (contact or account), suppression list, left company, missing/invalid email, missing template
 *   variables and existing active enrollments are skipped with a reason (never silently).
 */
export async function enrollContacts(user: AppUser, target: EnrollTarget, opts: EnrollOptions): Promise<EnrollResult> {
  await assertCan(user, "email", "view");
  const seq = await loadEnrollableSequence(user, opts.sequenceId);
  const steps = seq.steps as Step[];
  const hasEmail = steps.some((x) => x.kind === "email");

  const senderId = opts.senderId || user.id;
  const onBehalf = senderId !== user.id;
  if (onBehalf && !(await isSequenceAdmin(user))) throw new ForbiddenError("Only admins can send a sequence from someone else's mailbox.");
  // SEC M-5: the sender must pass the same checks as a signed-in session (ban, access expiry, domain allowlist, dev
  // account in production, pending) — an expired contractor's mailbox can't be enrolled from
  const [senderApp, [sender]] = await Promise.all([
    onBehalf ? loadAppUserById(senderId) : Promise.resolve(user),
    db.select({ id: s.user.id, name: s.user.name, tz: s.user.timezone, start: s.user.workStartHour, end: s.user.workEndHour }).from(s.user).where(eq(s.user.id, senderId)),
  ]);
  if (!sender || !senderApp || senderApp.role === "pending") throw new UserError("That sender can't send email.");
  const gm = hasEmail ? await gmailStatus(senderId) : null;
  if (gm && !(gm.canSend && gm.canRead)) {
    throw new UserError(senderId === user.id ? GMAIL_REQUIRED_MESSAGE : `${sender.name} hasn't connected Gmail with send permission.`);
  }

  /* resolve targets → contact ids (+ the deal each came from) */
  // on behalf of another sender: the contact must be visible to BOTH (restricted accounts, scope) — SEC M-5 / L-13
  const visible = onBehalf ? and(await contactVisibilityWhere(user), await contactVisibilityWhere(senderApp))! : await contactVisibilityWhere(user);
  const dealFor = new Map<string, string>();
  const skipped: EnrollSkip[] = [];
  const ids = new Set<string>(target.contactIds ?? []);
  let contextDealId: string | null = null;
  if (opts.dealId) {
    const [d] = await db.select({ id: s.deals.id }).from(s.deals).where(and(eq(s.deals.id, opts.dealId), await dealAccessWhere(user, "view")));
    if (!d) throw new ForbiddenError("You can't see that deal.");
    contextDealId = d.id;
  }
  if (target.dealIds?.length) {
    const dealIds = [...new Set(target.dealIds)].slice(0, MAX_ENROLL_BATCH);
    const deals = await db
      .select({ id: s.deals.id, name: s.deals.name, primary: s.deals.primaryContactId })
      .from(s.deals)
      .where(and(inArray(s.deals.id, dealIds), await dealAccessWhere(user, "view")));
    for (const missing of dealIds.filter((d) => !deals.some((x) => x.id === d))) skipped.push({ id: missing, name: "Deal", reason: "You can't see this deal." });
    const links = deals.length
      ? await db.select({ dealId: s.dealContacts.dealId, contactId: s.dealContacts.contactId }).from(s.dealContacts).where(inArray(s.dealContacts.dealId, deals.map((d) => d.id)))
      : [];
    for (const d of deals) {
      const contacts = d.primary ? [d.primary] : links.filter((l) => l.dealId === d.id).map((l) => l.contactId);
      if (!contacts.length) skipped.push({ id: d.id, name: d.name, reason: "Deal has no contacts." });
      for (const c of contacts) {
        ids.add(c);
        if (!dealFor.has(c)) dealFor.set(c, d.id);
      }
    }
  }
  if (target.accountIds?.length) {
    const accIds = [...new Set(target.accountIds)].slice(0, MAX_ENROLL_BATCH);
    const visibleAcc = await db.select({ id: s.accounts.id }).from(s.accounts).where(and(inArray(s.accounts.id, accIds), await accountVisibilityWhere(user)));
    for (const missing of accIds.filter((a) => !visibleAcc.some((x) => x.id === a))) skipped.push({ id: missing, name: "Account", reason: "You can't see this account." });
    if (visibleAcc.length) {
      const rows = await db
        .select({ id: s.contacts.id })
        .from(s.contacts)
        .where(and(inArray(s.contacts.accountId, visibleAcc.map((a) => a.id)), eq(s.contacts.status, "active"), isNull(s.contacts.deletedAt), visible))
        .limit(MAX_ENROLL_BATCH + 1);
      for (const r of rows) ids.add(r.id);
    }
  }
  const contactIds = [...ids].filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  if (!contactIds.length) return { enrolled: 0, enrollmentIds: [], skipped, sequenceName: seq.name };
  if (contactIds.length > MAX_ENROLL_BATCH) throw new UserError(`That's ${contactIds.length} contacts — enroll at most ${MAX_ENROLL_BATCH} at a time.`);

  const contacts = await db
    .select({
      id: s.contacts.id,
      fullName: s.contacts.fullName,
      firstName: s.contacts.firstName,
      lastName: s.contacts.lastName,
      title: s.contacts.title,
      email: s.contacts.email,
      emailStatus: s.contacts.emailStatus,
      status: s.contacts.status,
      dnc: s.contacts.doNotContact,
      accountId: s.contacts.accountId,
      accountName: s.accounts.name,
      accountDnc: s.accounts.doNotContact,
    })
    .from(s.contacts)
    .leftJoin(s.accounts, eq(s.accounts.id, s.contacts.accountId))
    .where(and(inArray(s.contacts.id, contactIds), visible));
  for (const missing of contactIds.filter((c) => !contacts.some((x) => x.id === c))) skipped.push({ id: missing, name: "Contact", reason: "You can't see this contact." });

  const [suppressed, active] = await Promise.all([
    suppressedEmails(contacts.map((c) => c.email).filter((e): e is string => Boolean(e))),
    contacts.length
      ? db
          .select({ contactId: s.sequenceEnrollments.contactId, sequenceId: s.sequenceEnrollments.sequenceId, name: s.sequences.name })
          .from(s.sequenceEnrollments)
          .innerJoin(s.sequences, eq(s.sequences.id, s.sequenceEnrollments.sequenceId))
          .where(and(inArray(s.sequenceEnrollments.contactId, contacts.map((c) => c.id)), inArray(s.sequenceEnrollments.status, ["active", "paused"])))
      : Promise.resolve([]),
  ]);

  const window = normalizeWindow({ tz: sender.tz, startHour: sender.start, endHour: sender.end });
  // SEC H-3: every enrollment keeps the steps it was enrolled with; later edits never change what it sends
  const snapshot = normalizeSteps(steps);
  const now = new Date();
  const shared = cleanVars(opts.variables);
  const values: (typeof s.sequenceEnrollments.$inferInsert)[] = [];
  for (const c of contacts) {
    const skip = (reason: string) => skipped.push({ id: c.id, name: c.fullName, reason });
    const already = active.find((a) => a.contactId === c.id);
    if (already) {
      skip(already.sequenceId === seq.id ? "Already enrolled in this sequence." : `Already in “${already.name}”.`);
      continue;
    }
    if (c.dnc || c.accountDnc) {
      skip("Do not contact.");
      continue;
    }
    if (c.status === "left_company") {
      skip("Left the company.");
      continue;
    }
    if (hasEmail) {
      if (!c.email) {
        skip("No email address.");
        continue;
      }
      if (c.emailStatus === "invalid") {
        skip("Email is invalid (bounced).");
        continue;
      }
      if (suppressed.has(c.email.toLowerCase())) {
        skip("On the suppression list.");
        continue;
      }
    }
    const vars = { ...shared, ...cleanVars(opts.perContact?.[c.id]) };
    const all = buildVariables({ firstName: c.firstName, lastName: c.lastName, fullName: c.fullName, title: c.title, company: c.accountName }, { name: sender.name }, vars);
    const missing = missingForSteps(steps, all);
    if (missing.length) {
      skip(`Missing ${[...new Set(missing.flatMap((m) => m.missing))].map((m) => `{{${m}}}`).join(", ")}.`);
      continue;
    }
    values.push({
      sequenceId: seq.id,
      contactId: c.id,
      dealId: dealFor.get(c.id) ?? contextDealId,
      accountId: c.accountId,
      senderId,
      enrolledBy: user.id,
      status: "active",
      currentStep: 0,
      nextRunAt: scheduleAfter(now, steps[0]!.delayDays, window, jitterMinutes(`${seq.id}:${c.id}`)),
      variables: vars,
      stepsSnapshot: snapshot,
      stepsVersion: seq.version,
      history: [],
    });
  }

  let enrollmentIds: string[] = [];
  if (values.length) {
    // the partial unique index (sequence, contact) where status in (active, paused) makes concurrent double-enrolls a no-op
    const rows = await db.insert(s.sequenceEnrollments).values(values).onConflictDoNothing().returning({ id: s.sequenceEnrollments.id, contactId: s.sequenceEnrollments.contactId });
    enrollmentIds = rows.map((r) => r.id);
    for (const v of values) if (!rows.some((r) => r.contactId === v.contactId)) skipped.push({ id: v.contactId, name: contacts.find((c) => c.id === v.contactId)?.fullName ?? "Contact", reason: "Already enrolled in this sequence." });
    if (rows.length)
      await audit({
        actorId: user.id,
        action: "sequence.enroll",
        entity: "sequence",
        entityId: seq.id,
        after: { count: rows.length, enrollmentIds, contactIds: rows.map((r) => r.contactId), senderId, source: opts.source, stepsVersion: seq.version },
      });
    // SEC L-13: an admin enrolling from someone else's mailbox tells that person (they can pause/stop it)
    if (rows.length && onBehalf)
      await notify(senderId, {
        kind: "task",
        title: `${user.name} enrolled ${rows.length} contact${rows.length === 1 ? "" : "s"} in “${seq.name}” from your mailbox`,
        body: "Emails go out from your Gmail inside your working hours. Review, pause or stop them on the sequence page.",
        href: `/sequences/${seq.id}`,
      });
  }
  return { enrolled: enrollmentIds.length, enrollmentIds, skipped, sequenceName: seq.name };
}
