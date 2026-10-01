import "server-only";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db, withXactLock } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { checkClaimsWith, loadClaimRules, type LoadedClaimRules } from "@/lib/claims";
import { ingestParsedMessage, loadIngestContext, type IngestContext } from "@/lib/gmail/ingest";
import { stripQuoted } from "@/lib/gmail/parse";
import { GMAIL_SEND_SCOPE, safeErrorMessage } from "@/lib/integrations/core";
import { getGoogleAccessToken } from "@/lib/integrations/google";
import { canSeeRestricted, loadAppUserById, type AppUser } from "@/lib/rbac/server";
import { getPrefs, IntegrationAuthError } from "@/lib/integrations/store";
import { notify } from "@/lib/notifications/notify";
import { suppressedEmails } from "@/lib/scout/crm-match";
import { dateOnlyToInstant, localDateKey } from "@/lib/time";
import { dayBounds } from "@/lib/alerts/time";
import { gmailStatus } from "./access";
import {
  buildVariables,
  capDecision,
  continuesThread,
  evaluateExit,
  failuresFor,
  intentFor,
  isBounceSender,
  isUnsubscribeReply,
  isWithinWindow,
  jitterMinutes,
  looksLikeOutOfOffice,
  mailboxCap,
  makeMessageId,
  MAX_ATTEMPTS,
  nextWindowStart,
  normalizeWindow,
  referencesHeader,
  renderTemplate,
  retryDelayMs,
  scheduleAfter,
  sentMessageIds,
  stepsForEnrollment,
  subjectForStep,
  type ExitFacts,
  type ExitReason,
  type ExitRules,
  type HistoryEntry,
  type Step,
  type WorkWindow,
} from "./core";
import { checkThread, findSentMessage, searchRepliesFrom, sendSequenceEmail, storedMessageIdHeader } from "./gmail";

/**
 * Sequence runner (V2 §A2 / PRD ACT-5). Called by the 5-minute tick; never throws.
 *
 * Concurrency & idempotency:
 * - Rows are CLAIMED atomically: one UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) pushes next_run_at out by a
 *   lease (10 min > the tick budget), so overlapping ticks never pick the same enrollment. Statement-level only — no
 *   session state (Supavisor transaction pooler).
 * - Before calling Gmail, a send INTENT (our own Message-ID) is appended to the enrollment's history in a transaction
 *   that also enforces the mailbox's daily cap (pg_advisory_xact_lock per sender). The append is conditional
 *   ("no intent for this step yet"), so only one worker can ever hold the right to send step N.
 * - If a worker dies between intent and bookkeeping, the next run finds the intent and RECONCILES via Gmail search
 *   (rfc822msgid / Sent + subject) before anything is sent again. Unverifiable → no send.
 * - Every exit rule (DNC, suppression, unsubscribe, bounce, reply, meeting, stage) is re-checked right before each step,
 *   including a live Gmail thread check, so a reply that sync hasn't ingested yet still stops the follow-up.
 */
const LEASE_MS = 10 * 60_000;
const TASK_RECHECK_MS = 2 * 60 * 60_000;
const SAFETY_MS = 20_000;

type Enrollment = typeof s.sequenceEnrollments.$inferSelect;
type Sequence = typeof s.sequences.$inferSelect;
/** `app` is the session-equivalent user (loadAppUserById): null when banned, expired, out of the domain allowlist, a dev
 * account in production, or pending — SEC M-5: such a sender's enrollments pause instead of emailing prospects. */
type Sender = { id: string; name: string; email: string; window: WorkWindow; app: AppUser | null };
type Outcome = "sent" | "exited" | "failed" | "deferred" | "waiting" | "completed" | "paused";
export type RunResult = { processed: number; sent: number; exited: number; failed: number };

export async function runDueSequences(opts: { limit: number; deadlineMs: number }): Promise<RunResult> {
  const out: RunResult = { processed: 0, sent: 0, exited: 0, failed: 0 };
  let rows: Enrollment[] = [];
  try {
    rows = await claimDue(Math.max(1, Math.min(100, opts.limit)));
  } catch (e) {
    console.error("[sequences] claim failed", safeErrorMessage(e, 160));
    return out;
  }
  const ctx = new RunContext();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (Date.now() > opts.deadlineMs - SAFETY_MS) {
      // out of time: hand the rest back immediately instead of waiting for the lease to expire
      await db
        .update(s.sequenceEnrollments)
        .set({ nextRunAt: new Date() })
        .where(and(inArray(s.sequenceEnrollments.id, rows.slice(i).map((r) => r.id)), eq(s.sequenceEnrollments.status, "active")))
        .catch(() => undefined);
      break;
    }
    out.processed++;
    try {
      const r = await processOne(row, ctx);
      if (r === "sent") out.sent++;
      else if (r === "exited") out.exited++;
      else if (r === "failed") out.failed++;
    } catch (e) {
      out.failed++;
      console.error("[sequences] enrollment failed", row.id, safeErrorMessage(e, 160));
      // unexpected error: retry with backoff (the lease already prevents a hot loop)
      await recordFailure(row, row.currentStep, e, ctx, "task_failed").catch(() => undefined);
    }
  }
  await ctx.flush();
  return out;
}

/* ───────────────────────────── claim ───────────────────────────── */

async function claimDue(limit: number): Promise<Enrollment[]> {
  // FOR UPDATE OF needs the unqualified alias, hence raw SQL. One statement = atomic under the transaction pooler.
  const claimed = (await db.execute(sql`
    update ${s.sequenceEnrollments}
    set next_run_at = now() + make_interval(secs => ${LEASE_MS / 1000}), updated_at = now()
    where status = 'active' and id in (
      select e.id
      from ${s.sequenceEnrollments} e
      join ${s.sequences} q on q.id = e.sequence_id
      where e.status = 'active' and e.next_run_at <= now() and q.active and q.deleted_at is null
      order by e.next_run_at
      limit ${limit}
      for update of e skip locked
    )
    returning id
  `)) as unknown as { id: string }[];
  if (!claimed.length) return [];
  const rows = await db.select().from(s.sequenceEnrollments).where(inArray(s.sequenceEnrollments.id, claimed.map((r) => r.id)));
  return rows.sort((x, y) => (x.nextRunAt?.getTime() ?? 0) - (y.nextRunAt?.getTime() ?? 0));
}

/* ───────────────────────────── per-run caches ───────────────────────────── */

class RunContext {
  private seqs = new Map<string, Promise<Sequence | null>>();
  private senders = new Map<string, Promise<Sender | null>>();
  private tokens = new Map<string, Promise<string>>();
  private gmail = new Map<string, Promise<{ canSend: boolean; canRead: boolean }>>();
  private ingest = new Map<string, Promise<IngestContext>>();
  private sigs = new Map<string, Promise<string>>();
  private claimRules: Promise<LoadedClaimRules> | null = null;
  private notes = new Map<string, { userId: string; title: string; body: string; href: string }>();

  sequence(id: string) {
    if (!this.seqs.has(id)) this.seqs.set(id, db.select().from(s.sequences).where(eq(s.sequences.id, id)).then((r) => r[0] ?? null));
    return this.seqs.get(id)!;
  }
  sender(id: string) {
    if (!this.senders.has(id))
      this.senders.set(
        id,
        Promise.all([db.select().from(s.user).where(eq(s.user.id, id)), loadAppUserById(id)]).then(([r, app]) => {
          const u = r[0];
          if (!u) return null;
          return { id: u.id, name: u.name, email: u.email.toLowerCase(), app, window: normalizeWindow({ tz: u.timezone, startHour: u.workStartHour, endHour: u.workEndHour }) };
        }),
      );
    return this.senders.get(id)!;
  }
  token(userId: string) {
    if (!this.tokens.has(userId)) {
      // CR M-8: never cache a rejected token promise — a transient refresh failure must not poison the whole tick
      const p = getGoogleAccessToken(userId, GMAIL_SEND_SCOPE).catch((e: unknown) => {
        this.tokens.delete(userId);
        throw e;
      });
      this.tokens.set(userId, p);
    }
    return this.tokens.get(userId)!;
  }
  gmailStatus(userId: string) {
    if (!this.gmail.has(userId)) this.gmail.set(userId, gmailStatus(userId));
    return this.gmail.get(userId)!;
  }
  ingestCtx(userId: string) {
    if (!this.ingest.has(userId)) this.ingest.set(userId, loadIngestContext(userId));
    return this.ingest.get(userId)!;
  }
  signature(userId: string) {
    if (!this.sigs.has(userId)) this.sigs.set(userId, getPrefs(userId).then((p) => p.signature.trim()).catch(() => ""));
    return this.sigs.get(userId)!;
  }
  claims() {
    if (!this.claimRules) this.claimRules = loadClaimRules();
    return this.claimRules;
  }
  /** One notification per (user, topic) per tick. */
  note(userId: string, topic: string, n: { title: string; body: string; href: string }) {
    const k = `${userId}:${topic}`;
    if (!this.notes.has(k)) this.notes.set(k, { userId, ...n });
  }
  async flush() {
    for (const n of this.notes.values()) await notify(n.userId, { kind: "alert", title: n.title, body: n.body, href: n.href });
  }
}

/* ───────────────────────────── one enrollment ───────────────────────────── */

type ContactRow = {
  id: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  altEmails: string[];
  emailStatus: string | null;
  status: string;
  dnc: boolean;
  deletedAt: Date | null;
  linkedinUrl: string | null;
  accountId: string | null;
  accountName: string | null;
  accountDnc: boolean | null;
  accountRestricted: boolean | null;
};

async function processOne(row: Enrollment, ctx: RunContext): Promise<Outcome> {
  const seq = await ctx.sequence(row.sequenceId);
  if (!seq || seq.deletedAt || !seq.active) {
    await setNext(row, new Date(Date.now() + 60 * 60_000));
    return "deferred";
  }
  // SEC H-3 / CR H-3: run the steps the sender enrolled with, never the live (possibly edited) template
  const steps = stepsForEnrollment(row, seq);
  if (!steps) return pause(row, `“${seq.name}” was edited after this person was enrolled. Review the new steps and apply them (or stop the enrollment).`, ctx);
  const stepIdx = row.currentStep;
  const step = steps[stepIdx];
  if (!step) return complete(row);

  const sender = await ctx.sender(row.senderId);
  if (!sender?.app || sender.app.role === "pending") return pause(row, "The sending user can no longer send email (access ended or was suspended).", ctx);

  const contact = await loadContact(row.contactId);
  const facts = await dbFacts(row, contact, sender);
  const exit = evaluateExit(seq.exitOn as ExitRules, { ...facts, noEmail: step.kind === "email" && !contact?.email });
  if (exit) return doExit(row, exit, contact, facts, sender);

  // SEC M-5: an account/deal that became restricted (MNPI) after enrollment stops automated outreach unless the
  // sending user is on its access list
  const restrictedReason = await restrictedBlock(sender.app, contact, facts.dealRestricted ? row.dealId : null);
  if (restrictedReason) return pause(row, restrictedReason, ctx);

  const now = new Date();
  if (!isWithinWindow(now, sender.window)) {
    await setNext(row, nextWindowStart(now, sender.window));
    return "deferred";
  }
  if (step.kind !== "email") return handleTaskStep(row, seq, steps, step, contact!, sender);
  return handleEmailStep(row, seq, steps, step, contact!, sender, ctx);
}

async function loadContact(id: string): Promise<ContactRow | null> {
  const [c] = await db
    .select({
      id: s.contacts.id,
      fullName: s.contacts.fullName,
      firstName: s.contacts.firstName,
      lastName: s.contacts.lastName,
      title: s.contacts.title,
      email: s.contacts.email,
      altEmails: s.contacts.altEmails,
      emailStatus: s.contacts.emailStatus,
      status: s.contacts.status,
      dnc: s.contacts.doNotContact,
      deletedAt: s.contacts.deletedAt,
      linkedinUrl: s.contacts.linkedinUrl,
      accountId: s.contacts.accountId,
      accountName: s.accounts.name,
      accountDnc: s.accounts.doNotContact,
      accountRestricted: s.accounts.restricted,
    })
    .from(s.contacts)
    .leftJoin(s.accounts, eq(s.accounts.id, s.contacts.accountId))
    .where(eq(s.contacts.id, id));
  return c ?? null;
}

async function restrictedBlock(app: AppUser, c: ContactRow | null, restrictedDealId: string | null): Promise<string | null> {
  const msg = "Restricted (MNPI) record — automated outreach is paused. Review in Roundtable before resuming.";
  if (c?.accountRestricted && c.accountId && !(await canSeeRestricted(app, "account", c.accountId))) return msg;
  if (restrictedDealId && !(await canSeeRestricted(app, "deal", restrictedDealId))) return msg;
  return null;
}

function contactEmails(c: ContactRow | null): string[] {
  if (!c) return [];
  return [...new Set([c.email, ...(c.altEmails ?? [])].filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase()))];
}

/** Exit facts from the database (cheap, indexed): contact flags, suppression, ingested replies, meetings, deal stage. */
async function dbFacts(row: Enrollment, c: ContactRow | null, sender: Sender): Promise<ExitFacts & { dealRestricted?: boolean }> {
  if (!c || c.deletedAt) return { contactMissing: true };
  const emails = contactEmails(c);
  const since = row.createdAt;
  const [supp, inbound, meeting, deal] = await Promise.all([
    emails.length ? suppressedEmails(emails) : Promise.resolve(new Set<string>()),
    emails.length || row.gmailThreadId
      ? db
          .select({ from: s.emailMessages.fromAddr, body: s.emailMessages.bodyText })
          .from(s.emailMessages)
          .innerJoin(s.emailThreads, eq(s.emailThreads.id, s.emailMessages.threadId))
          .where(
            and(
              eq(s.emailThreads.mailboxUserId, sender.id),
              eq(s.emailMessages.direction, "inbound"),
              sql`${s.emailMessages.sentAt} > ${since.toISOString()}::timestamptz`,
              sql`(${emails.length ? sql`lower(${s.emailMessages.fromAddr}) in (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})` : sql`false`} or ${row.gmailThreadId ? sql`${s.emailThreads.gmailThreadId} = ${row.gmailThreadId}` : sql`false`})`,
            ),
          )
          .limit(5)
      : Promise.resolve([]),
    emails.length
      ? db
          .select({ id: s.meetings.id })
          .from(s.meetings)
          .where(
            and(
              // attendees are stored lower-cased; `&&` uses the GIN index (CR L8) instead of unnesting every meeting
              sql`${s.meetings.attendees} && array[${sql.join(emails.map((e) => sql`${e}`), sql`, `)}]::text[]`,
              sql`(${s.meetings.createdAt} > ${since.toISOString()}::timestamptz or ${s.meetings.startsAt} > ${since.toISOString()}::timestamptz)`,
            ),
          )
          .limit(1)
      : Promise.resolve([]),
    row.dealId
      ? db.select({ status: s.deals.status, entered: s.deals.stageEnteredAt, deletedAt: s.deals.deletedAt, restricted: s.deals.restricted }).from(s.deals).where(eq(s.deals.id, row.dealId)).then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);
  const bounced = inbound.some((m) => isBounceSender(m.from));
  // an out-of-office isn't a reply (CR L15); the live Gmail check below also inspects Auto-Submitted headers
  const replies = inbound.filter((m) => !isBounceSender(m.from) && !looksLikeOutOfOffice(stripQuoted(m.body ?? "")));
  return {
    doNotContact: c.dnc || Boolean(c.accountDnc),
    suppressed: emails.some((e) => supp.has(e)),
    leftCompany: c.status === "left_company",
    emailInvalid: c.emailStatus === "invalid",
    bounced,
    replied: replies.length > 0,
    unsubscribeReply: replies.some((m) => isUnsubscribeReply(stripQuoted(m.body ?? ""))),
    meetingBooked: meeting.length > 0,
    stageChanged: Boolean(deal && !deal.deletedAt && deal.entered > since),
    dealClosed: Boolean(deal && !deal.deletedAt && deal.status !== "open"),
    dealRestricted: Boolean(deal && !deal.deletedAt && deal.restricted),
  };
}

/* ───────────────────────────── state transitions ───────────────────────────── */

const append = (entries: HistoryEntry[]) => sql`${s.sequenceEnrollments.history} || ${JSON.stringify(entries)}::jsonb`;
const entry = (step: number, kind: string, ok: boolean, note?: string): HistoryEntry => ({ step, at: new Date().toISOString(), kind, ok, ...(note ? { note: note.slice(0, 300) } : {}) });

async function setNext(row: Enrollment, at: Date) {
  await db.update(s.sequenceEnrollments).set({ nextRunAt: at }).where(and(eq(s.sequenceEnrollments.id, row.id), eq(s.sequenceEnrollments.status, "active")));
}

async function complete(row: Enrollment): Promise<Outcome> {
  await db
    .update(s.sequenceEnrollments)
    .set({ status: "completed", nextRunAt: null, lastError: null, history: append([entry(row.currentStep, "completed", true)]) })
    .where(and(eq(s.sequenceEnrollments.id, row.id), eq(s.sequenceEnrollments.status, "active")));
  return "completed";
}

/** Move past `stepIdx` (sent / task done): schedule the next step from `from`, or complete. Guarded by current_step. */
async function advance(row: Enrollment, steps: Step[], stepIdx: number, from: Date, sender: Sender, extra: Partial<typeof s.sequenceEnrollments.$inferInsert>, entries: HistoryEntry[]) {
  const next = stepIdx + 1;
  const done = next >= steps.length;
  const [r] = await db
    .update(s.sequenceEnrollments)
    .set({
      ...extra,
      currentStep: next,
      // keep a concurrent manual pause; only completion changes the status here
      ...(done ? { status: "completed" } : {}),
      nextRunAt: done ? null : scheduleAfter(from, steps[next]!.delayDays, sender.window, jitterMinutes(`${row.id}:${next}`)),
      lastError: null,
      history: append(done ? [...entries, entry(next, "completed", true)] : entries),
    })
    .where(and(eq(s.sequenceEnrollments.id, row.id), eq(s.sequenceEnrollments.currentStep, stepIdx)))
    .returning({ id: s.sequenceEnrollments.id });
  return Boolean(r);
}

async function pause(row: Enrollment, reason: string, ctx: RunContext): Promise<Outcome> {
  await db
    .update(s.sequenceEnrollments)
    .set({ status: "paused", nextRunAt: new Date(), lastError: reason, history: append([entry(row.currentStep, "paused", false, reason)]) })
    .where(and(eq(s.sequenceEnrollments.id, row.id), eq(s.sequenceEnrollments.status, "active")));
  ctx.note(row.senderId, "paused", { title: "Sequence emails paused", body: reason, href: "/sequences?view=attention" });
  return "paused";
}

async function failPermanently(row: Enrollment, stepIdx: number, reason: string, ctx: RunContext): Promise<Outcome> {
  await db
    .update(s.sequenceEnrollments)
    .set({ status: "failed", exitReason: "error", nextRunAt: null, lastError: reason.slice(0, 500), history: append([entry(stepIdx, "email_failed", false, reason)]) })
    .where(and(eq(s.sequenceEnrollments.id, row.id), eq(s.sequenceEnrollments.status, "active")));
  ctx.note(row.senderId, "failed", { title: "A sequence step needs you", body: reason, href: "/sequences?view=attention" });
  return "failed";
}

/** Transient failure: back off 15 m / 1 h / 4 h, then `failed` (+ NS-28 notification and Today item). */
async function recordFailure(row: Enrollment, stepIdx: number, e: unknown, ctx: RunContext, kind = "email_failed"): Promise<Outcome> {
  const msg = safeErrorMessage(e, 300);
  const [fresh] = await db.select({ history: s.sequenceEnrollments.history }).from(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.id, row.id));
  const attempts = failuresFor((fresh?.history ?? row.history) as HistoryEntry[], stepIdx) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await db
      .update(s.sequenceEnrollments)
      .set({ status: "failed", exitReason: "error", nextRunAt: null, lastError: msg, history: append([entry(stepIdx, kind, false, msg)]) })
      .where(and(eq(s.sequenceEnrollments.id, row.id), eq(s.sequenceEnrollments.status, "active")));
    ctx.note(row.senderId, "failed", { title: "A sequence step failed 3 times", body: msg, href: "/sequences?view=attention" });
    return "failed";
  }
  await db
    .update(s.sequenceEnrollments)
    .set({ nextRunAt: new Date(Date.now() + retryDelayMs(attempts)), lastError: msg, history: append([entry(stepIdx, kind, false, msg)]) })
    .where(and(eq(s.sequenceEnrollments.id, row.id), eq(s.sequenceEnrollments.status, "active")));
  return "deferred";
}

async function doExit(row: Enrollment, reason: ExitReason, c: ContactRow | null, facts: ExitFacts, sender: Sender): Promise<Outcome> {
  const [r] = await db
    .update(s.sequenceEnrollments)
    .set({ status: "exited", exitReason: reason, nextRunAt: null, history: append([entry(row.currentStep, "exit", true, reason)]) })
    .where(and(eq(s.sequenceEnrollments.id, row.id), eq(s.sequenceEnrollments.status, "active")))
    .returning({ id: s.sequenceEnrollments.id });
  if (!r) return "deferred";
  // a pending task/LinkedIn step is moot once the person replied / opted out
  await db
    .update(s.tasks)
    .set({ status: "cancelled" })
    .where(and(eq(s.tasks.origin, "sequence"), eq(s.tasks.status, "open"), like(s.tasks.evidenceSource, `sequence:${row.id}:%`)))
    .catch(() => undefined);
  if (c && !c.deletedAt) {
    if (reason === "unsubscribed" && c.email) {
      // CON-6 / SCOUT-23: an opt-out reply suppresses the address everywhere and flags the contact
      await db.insert(s.suppressionList).values({ value: c.email.toLowerCase(), kind: "email", reason: "Unsubscribed (sequence reply)" }).onConflictDoNothing().catch(() => undefined);
      await db.update(s.contacts).set({ doNotContact: true }).where(eq(s.contacts.id, c.id));
      await audit({ actorId: null, actorKind: "system", action: "contact.unsubscribed", entity: "contact", entityId: c.id, before: { doNotContact: c.dnc }, after: { doNotContact: true, suppressed: c.email.toLowerCase(), enrollmentId: row.id } }).catch(() => undefined);
    } else if (reason === "bounced" && facts.bounced && c.emailStatus !== "invalid") {
      // SCOUT-18: a DSN marks the address invalid (re-enrichment is suggested on the contact)
      await db.update(s.contacts).set({ emailStatus: "invalid" }).where(eq(s.contacts.id, c.id));
      await audit({ actorId: null, actorKind: "system", action: "contact.email_bounced", entity: "contact", entityId: c.id, before: { emailStatus: c.emailStatus }, after: { emailStatus: "invalid", enrollmentId: row.id } }).catch(() => undefined);
    }
  }
  await audit({ actorId: null, actorKind: "system", action: "sequence.exit", entity: "sequence_enrollment", entityId: row.id, after: { reason, step: row.currentStep, senderId: sender.id } }).catch(() => undefined);
  return "exited";
}

/* ───────────────────────────── task / LinkedIn steps ───────────────────────────── */

async function handleTaskStep(row: Enrollment, seq: Sequence, steps: Step[], step: Step, c: ContactRow, sender: Sender): Promise<Outcome> {
  const stepIdx = row.currentStep;
  const evidence = `sequence:${row.id}:${stepIdx}`;
  const [existing] = await db.select({ id: s.tasks.id, status: s.tasks.status, completedAt: s.tasks.completedAt }).from(s.tasks).where(eq(s.tasks.evidenceSource, evidence)).limit(1);
  if (existing) {
    if (existing.status === "open") {
      await setNext(row, new Date(Date.now() + TASK_RECHECK_MS));
      return "waiting";
    }
    const at = existing.completedAt ?? new Date();
    const ok = await advance(row, steps, stepIdx, at, sender, {}, [entry(stepIdx, existing.status === "done" ? "task_done" : "task_skipped", existing.status === "done", existing.id)]);
    if (ok && existing.status === "done" && step.kind === "linkedin") {
      await db
        .insert(s.activities)
        .values({ type: "linkedin", source: "system", subject: `LinkedIn touch — ${c.fullName}`, direction: "outbound", occurredAt: at, actorId: sender.id, dealId: row.dealId, accountId: row.accountId ?? c.accountId, contactId: c.id, metadata: { sequenceId: seq.id, enrollmentId: row.id, step: stepIdx, taskId: existing.id } })
        .catch(() => undefined);
    }
    return ok && stepIdx + 1 >= steps.length ? "completed" : "waiting";
  }

  const vars = buildVariables({ firstName: c.firstName, lastName: c.lastName, fullName: c.fullName, title: c.title, company: c.accountName }, { name: sender.name }, row.variables);
  const rawTitle = renderTemplate(step.title ?? "", vars).text.trim() || (step.kind === "linkedin" ? "LinkedIn touch" : "Follow up");
  const title = (rawTitle.toLowerCase().includes(c.fullName.toLowerCase()) ? rawTitle : `${rawTitle} — ${c.fullName}`).slice(0, 200);
  const notes = renderTemplate(step.body ?? "", vars).text.trim();
  const description = [
    notes,
    step.kind === "linkedin" ? (c.linkedinUrl ? `LinkedIn: ${c.linkedinUrl}` : "No LinkedIn URL on the contact yet.") : "",
    `Sequence “${seq.name}”, step ${stepIdx + 1} of ${steps.length}. Mark this task done to continue the sequence.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const dueAt = dateOnlyToInstant(localDateKey(new Date(), sender.window.tz), sender.window.tz, Math.min(17, sender.window.endHour));
  const created = await withXactLock(`rso.seq.task:${evidence}`, async (tx) => {
    const [again] = await tx.select({ id: s.tasks.id }).from(s.tasks).where(eq(s.tasks.evidenceSource, evidence)).limit(1);
    if (again) return again.id;
    const [t] = await tx
      .insert(s.tasks)
      .values({ title, description, status: "open", priority: "medium", dueAt, assigneeId: sender.id, createdBy: sender.id, dealId: row.dealId, accountId: row.accountId ?? c.accountId, contactId: c.id, origin: "sequence", evidenceSource: evidence })
      .returning({ id: s.tasks.id });
    await tx
      .update(s.sequenceEnrollments)
      .set({ nextRunAt: new Date(Date.now() + TASK_RECHECK_MS), history: append([entry(stepIdx, step.kind, true, t!.id)]) })
      .where(eq(s.sequenceEnrollments.id, row.id));
    await audit({ actorId: null, actorKind: "system", action: "sequence.task_created", entity: "task", entityId: t!.id, after: { enrollmentId: row.id, step: stepIdx, kind: step.kind } }, tx);
    return t!.id;
  });
  if (!created.locked) await setNext(row, new Date(Date.now() + TASK_RECHECK_MS));
  return "waiting";
}

/* ───────────────────────────── email steps ───────────────────────────── */

async function handleEmailStep(row: Enrollment, seq: Sequence, steps: Step[], step: Step, c: ContactRow, sender: Sender, ctx: RunContext): Promise<Outcome> {
  const stepIdx = row.currentStep;
  const to = c.email!.toLowerCase();

  const gm = await ctx.gmailStatus(sender.id);
  if (!gm.canSend || !gm.canRead) return pause(row, "Gmail is disconnected or missing permissions. Reconnect your inbox in Settings → Connections, then resume.", ctx);
  let token: string;
  try {
    token = await ctx.token(sender.id);
  } catch (e) {
    if (e instanceof IntegrationAuthError) return pause(row, `${e.message} Then resume your sequences.`, ctx);
    return recordFailure(row, stepIdx, e, ctx);
  }

  // live reply / bounce check (Gmail is the source of truth; sync may lag)
  try {
    const sinceMs = row.createdAt.getTime();
    const [thread, search] = await Promise.all([
      row.gmailThreadId ? checkThread(token, row.gmailThreadId, sender.email, sinceMs) : Promise.resolve(null),
      searchRepliesFrom(token, to, sinceMs),
    ]);
    const live: ExitFacts = {
      replied: Boolean(thread?.replied || search.replied),
      bounced: Boolean(thread?.bounced),
      unsubscribeReply: Boolean(thread?.unsubscribe || search.unsubscribe),
    };
    const exit = evaluateExit(seq.exitOn as ExitRules, live);
    if (exit) return doExit(row, exit, c, live, sender);
  } catch (e) {
    if (e instanceof IntegrationAuthError) return pause(row, `${e.message} Then resume your sequences.`, ctx);
    return recordFailure(row, stepIdx, e, ctx);
  }

  // render — a missing variable never goes out as "{{first_name}}"
  const vars = buildVariables({ firstName: c.firstName, lastName: c.lastName, fullName: c.fullName, title: c.title, company: c.accountName }, { name: sender.name }, row.variables);
  const subj = renderTemplate(subjectForStep(steps, stepIdx), vars);
  const bod = renderTemplate(step.body ?? "", vars);
  const missing = [...new Set([...subj.missing, ...bod.missing])];
  if (missing.length) return failPermanently(row, stepIdx, `Step ${stepIdx + 1} for ${c.fullName} is missing ${missing.map((m) => `{{${m}}}`).join(", ")}. Fill it in on the contact (or edit the template), then retry.`, ctx);
  if (!subj.text.trim()) return failPermanently(row, stepIdx, `Step ${stepIdx + 1} has an empty subject.`, ctx);

  const claims = checkClaimsWith(`${subj.text}\n${bod.text}`, await ctx.claims());
  if (claims.blocked) {
    const banned = claims.hits.filter((h) => h.status === "banned").map((h) => `“${h.match}”`).join(", ");
    return failPermanently(row, stepIdx, `Blocked by the claims policy (${banned}). Edit the sequence template, then retry.`, ctx);
  }
  const sig = await ctx.signature(sender.id);
  const body = sig && !bod.text.includes(sig) ? `${bod.text}\n\n${sig}` : bod.text;

  const inThread = continuesThread(steps, stepIdx) && Boolean(row.gmailThreadId);
  const history = row.history as HistoryEntry[];
  const prior = intentFor(history, stepIdx);
  let messageId: string;
  if (prior?.note) {
    // a previous attempt recorded intent: find out whether Gmail already sent it before doing anything else
    let found: Awaited<ReturnType<typeof findSentMessage>>;
    try {
      found = await findSentMessage(token, { messageId: prior.note, to, subject: subj.text, afterMs: new Date(prior.at).getTime() });
    } catch (e) {
      if (e instanceof IntegrationAuthError) return pause(row, `${e.message} Then resume your sequences.`, ctx);
      return recordFailure(row, stepIdx, e, ctx);
    }
    if (found) {
      await finalizeSent(row, seq, steps, stepIdx, sender, c, { ...found, subject: subj.text, body, references: null }, ctx, true);
      return "sent";
    }
    messageId = prior.note;
  } else {
    messageId = makeMessageId(row.id, stepIdx, crypto.randomUUID());
    const reserved = await reserveSend(row, stepIdx, sender, seq.dailyCap, messageId);
    if (reserved === "cap") {
      await setNext(row, nextWindowStart(dayBounds(new Date(), sender.window.tz).end, sender.window));
      return "deferred";
    }
    if (reserved === "raced") return "deferred"; // another worker owns this step
  }

  const references = inThread ? referencesHeader(sentMessageIds(history)) : null;
  let sent: { id: string; threadId: string };
  try {
    sent = await sendSequenceEmail(token, {
      from: sender.email,
      fromName: sender.name,
      to,
      subject: subj.text,
      body,
      messageId,
      inReplyTo: inThread ? row.lastMessageIdHeader : null,
      references,
      threadId: inThread ? row.gmailThreadId : null,
    });
  } catch (e) {
    // the intent stays: the retry reconciles against Sent first, so an ambiguous failure can't double-send
    if (e instanceof IntegrationAuthError) return pause(row, `${e.message} Then resume your sequences.`, ctx);
    return recordFailure(row, stepIdx, e, ctx);
  }
  const header = (await storedMessageIdHeader(token, sent.id)) ?? messageId;
  await finalizeSent(row, seq, steps, stepIdx, sender, c, { id: sent.id, threadId: sent.threadId, messageIdHeader: header, subject: subj.text, body, references }, ctx, false);
  return "sent";
}

/**
 * Daily cap + intent in one serialized step per mailbox. Counts every intent recorded today (sender's local day),
 * including in-flight ones, so overlapping ticks can't overshoot the cap.
 */
async function reserveSend(row: Enrollment, stepIdx: number, sender: Sender, dailyCap: number, messageId: string): Promise<"ok" | "cap" | "raced"> {
  const dayStart = dayBounds(new Date(), sender.window.tz).start;
  const res = await withXactLock(`rso.seq.mailbox:${sender.id}`, async (tx) => {
    // only enrollments touched today can hold today's intents (every intent append bumps updated_at) — CR L8 / MIN-25
    const counted = (await tx.execute(sql`
      select count(*)::int as n, coalesce(array_agg(distinct q.daily_cap), '{}') as caps
      from ${s.sequenceEnrollments} e
      join ${s.sequences} q on q.id = e.sequence_id
      cross join lateral jsonb_array_elements(e.history) h
      where e.sender_id = ${sender.id} and e.updated_at >= ${dayStart.toISOString()}::timestamptz
        and h->>'kind' = 'email_intent' and (h->>'at')::timestamptz >= ${dayStart.toISOString()}::timestamptz
    `)) as unknown as { n: number; caps: number[] | null }[];
    // one cap per mailbox: the strictest cap of the sequences this mailbox sent from today, incl. this one
    const cap = mailboxCap([dailyCap, ...(counted[0]?.caps ?? []).map(Number)]);
    if (!capDecision(Number(counted[0]?.n ?? 0), cap).allowed) return "cap" as const;
    const [r] = await tx
      .update(s.sequenceEnrollments)
      .set({ history: append([entry(stepIdx, "email_intent", false, messageId)]) })
      .where(
        and(
          eq(s.sequenceEnrollments.id, row.id),
          eq(s.sequenceEnrollments.status, "active"),
          eq(s.sequenceEnrollments.currentStep, stepIdx),
          sql`not (${s.sequenceEnrollments.history} @> ${JSON.stringify([{ step: stepIdx, kind: "email_intent" }])}::jsonb)`,
        ),
      )
      .returning({ id: s.sequenceEnrollments.id });
    return r ? ("ok" as const) : ("raced" as const);
  });
  return res.locked ? res.value : "raced";
}

async function finalizeSent(
  row: Enrollment,
  seq: Sequence,
  steps: Step[],
  stepIdx: number,
  sender: Sender,
  c: ContactRow,
  sent: { id: string; threadId: string; messageIdHeader: string | null; subject: string; body: string; references: string | null },
  ctx: RunContext,
  reconciled: boolean,
) {
  const now = new Date();
  // CR L15: a reconciled step is visible in the history ("found in Sent after an interrupted send — not sent again")
  const entries = [entry(stepIdx, "email", true, sent.messageIdHeader ?? undefined), ...(reconciled ? [entry(stepIdx, "reconciled", true, "Found in Sent after an interrupted send — not sent again.")] : [])];
  const ok = await advance(row, steps, stepIdx, now, sender, { gmailThreadId: sent.threadId, lastMessageIdHeader: sent.messageIdHeader }, entries);
  if (!ok) {
    // the step changed under us (e.g. skipped manually mid-send): the email WAS sent, so record and log it anyway
    await db
      .update(s.sequenceEnrollments)
      .set({ history: append(entries), gmailThreadId: sent.threadId, lastMessageIdHeader: sent.messageIdHeader })
      .where(eq(s.sequenceEnrollments.id, row.id));
  }

  // log: email thread/message + activity (same path as the inbox composer), then tag the activity with the sequence
  try {
    const ingestCtx = await ctx.ingestCtx(sender.id);
    const r = await ingestParsedMessage(
      ingestCtx,
      {
        id: sent.id,
        threadId: sent.threadId,
        historyId: null,
        labelIds: ["SENT"],
        subject: sent.subject,
        from: sender.email,
        fromName: sender.name,
        to: [c.email!.toLowerCase()],
        cc: [],
        sentAt: now,
        messageIdHeader: sent.messageIdHeader,
        references: sent.references,
        snippet: sent.body.slice(0, 200),
        bodyText: sent.body,
      },
      { force: true, dealId: row.dealId },
    );
    const meta = { sequenceId: seq.id, sequenceName: seq.name, enrollmentId: row.id, step: stepIdx };
    if (r.status === "ingested") {
      const tagged = await db
        .update(s.activities)
        .set({ metadata: sql`${s.activities.metadata} || ${JSON.stringify(meta)}::jsonb` })
        .where(eq(s.activities.emailMessageId, r.messageRowId))
        .returning({ id: s.activities.id });
      if (!tagged.length)
        await db.insert(s.activities).values({ type: "email", source: "gmail", subject: sent.subject, body: sent.body.slice(0, 500), direction: "outbound", occurredAt: now, actorId: sender.id, dealId: r.dealId ?? row.dealId, accountId: row.accountId ?? c.accountId, contactId: c.id, emailMessageId: r.messageRowId, metadata: meta });
    }
    await db.update(s.contacts).set({ lastContactedAt: now }).where(eq(s.contacts.id, c.id));
  } catch (e) {
    console.error("[sequences] logging after send failed", safeErrorMessage(e, 160));
  }
  await audit({ actorId: sender.id, actorKind: "system", action: "sequence.send", entity: "sequence_enrollment", entityId: row.id, after: { sequenceId: seq.id, contactId: c.id, step: stepIdx, gmailMessageId: sent.id, reconciled } }).catch(() => undefined);
}

