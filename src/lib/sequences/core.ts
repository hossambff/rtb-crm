/**
 * Sequences (PRD ACT-5 / V2 §A2), pure core: unit-tested, no server deps, safe for client import.
 *
 * - Business-day scheduling in the SENDER's time zone and working hours.
 * - Template rendering: unknown or empty variables BLOCK the send. A literal "{{first_name}}" must never reach a
 *   customer. Explicit fallbacks (`{{first_name|there}}`) count as provided.
 * - Exit-rule evaluation (reply, meeting booked, stage change, unsubscribe/do-not-contact, bounce).
 * - Daily-cap accounting per mailbox, retry backoff, and the history-entry conventions the runner relies on for
 *   idempotency ("intent" entries are written before a send and reconciled after a crash).
 */
import { z } from "zod";
import { fromWall, toWall } from "@/lib/alerts/time";

/* ───────────────────────────── Steps ───────────────────────────── */

export type StepKind = "email" | "task" | "linkedin";
export type Step = {
  kind: StepKind;
  delayDays: number;
  subject?: string;
  body?: string;
  title?: string;
  replyInThread?: boolean;
};
export type ExitRules = { reply?: boolean; meetingBooked?: boolean; stageChange?: boolean; unsubscribe?: boolean };

export const MAX_STEPS = 12;
export const MAX_DELAY_DAYS = 60;
export const MAX_ENROLL_BATCH = 100;
export const MAX_ATTEMPTS = 3;

export const stepSchema = z
  .object({
    kind: z.enum(["email", "task", "linkedin"]),
    delayDays: z.number().int().min(0).max(MAX_DELAY_DAYS),
    subject: z.string().trim().max(300).optional(),
    body: z.string().max(20_000).optional(),
    title: z.string().trim().max(200).optional(),
    replyInThread: z.boolean().optional(),
  })
  .superRefine((s, ctx) => {
    if (s.kind === "email") {
      if (!s.body?.trim()) ctx.addIssue({ code: "custom", message: "Write the email body", path: ["body"] });
    } else if (!s.title?.trim()) ctx.addIssue({ code: "custom", message: "Give the task a title", path: ["title"] });
  });

/** Steps as stored: email subjects only matter for the first email in a thread (follow-ups reply in-thread). */
export function normalizeSteps(steps: Step[]): Step[] {
  let seenEmail = false;
  return steps.map((s) => {
    if (s.kind !== "email") return { kind: s.kind, delayDays: s.delayDays, title: s.title?.trim() ?? "", body: s.body?.trim() || undefined };
    const first = !seenEmail;
    seenEmail = true;
    const replyInThread = first ? false : s.replyInThread !== false;
    return { kind: "email", delayDays: s.delayDays, subject: s.subject?.trim() ?? "", body: s.body ?? "", replyInThread };
  });
}

/** Problems that make a sequence unusable (shown in the builder; enrollment refuses while any exist). */
export function validateSequence(steps: Step[]): string[] {
  const out: string[] = [];
  if (!steps.length) out.push("Add at least one step.");
  if (steps.length > MAX_STEPS) out.push(`At most ${MAX_STEPS} steps.`);
  let firstEmail = true;
  steps.forEach((s, i) => {
    if (s.kind === "email") {
      const needsSubject = firstEmail || s.replyInThread === false;
      if (needsSubject && !s.subject?.trim()) out.push(`Step ${i + 1}: the first email (or a new-thread email) needs a subject.`);
      if (!s.body?.trim()) out.push(`Step ${i + 1}: the email body is empty.`);
      firstEmail = false;
    } else if (!s.title?.trim()) out.push(`Step ${i + 1}: the task needs a title.`);
    for (const t of [s.subject, s.body, s.title]) {
      for (const v of templateVariables(t ?? "")) if (!KNOWN_VARIABLES.includes(v.name as KnownVariable)) out.push(`Step ${i + 1}: unknown variable {{${v.name}}}.`);
      if (hasBrokenBraces(t ?? "")) out.push(`Step ${i + 1}: unbalanced {{ }} braces.`);
    }
  });
  return [...new Set(out)];
}

/** Opt-out line (SCOUT-24 good practice): the builder warns when the first email lacks one. */
export const OPT_OUT_HINT = "If this isn't relevant, just reply \"unsubscribe\" and I won't follow up.";
export function hasOptOutLine(text: string): boolean {
  return /unsubscribe|opt[- ]?out|not interested|won'?t follow up|no longer (?:hear|receive)|let me know if you'?d rather not/i.test(text);
}

/* ───────────────────────────── Step versions (SEC H-3 / CR H-3) ───────────────────────────── */

export type StepsSource = { stepsSnapshot?: unknown; stepsVersion?: number | null };

/**
 * The steps an enrollment runs: its own snapshot (taken at enrollment), so edits to a shared sequence never change
 * what goes out from someone else's mailbox, and never shift indexes under a live enrollment. Legacy rows without a
 * snapshot fall back to the live steps ONLY while the sequence is still at version 1 (never edited since); otherwise
 * null = the runner pauses and asks a human to apply the new version explicitly.
 */
export function stepsForEnrollment(row: StepsSource, seq: { steps: unknown; version?: number | null }): Step[] | null {
  if (Array.isArray(row.stepsSnapshot) && row.stepsSnapshot.length) return row.stepsSnapshot as Step[];
  const seqVersion = seq.version ?? 1;
  const rowVersion = row.stepsVersion ?? 1;
  if (rowVersion !== seqVersion) return null;
  return Array.isArray(seq.steps) ? (seq.steps as Step[]) : [];
}

/** Is the enrollment running an older version of the sequence than the current one? */
export function isOnOlderVersion(row: StepsSource, seqVersion: number): boolean {
  return (row.stepsVersion ?? 1) < seqVersion;
}

export function stepsEqual(a: Step[], b: Step[]): boolean {
  return JSON.stringify(normalizeSteps(a)) === JSON.stringify(normalizeSteps(b));
}

/**
 * Can an enrollment that already ran `currentStep` steps switch to `next` safely? The steps it already completed must
 * line up 1:1 (same kind, same thread behaviour), otherwise switching would re-send an earlier email or skip one.
 */
export function canApplyNewSteps(prev: Step[], next: Step[], currentStep: number): boolean {
  if (currentStep <= 0) return true;
  if (currentStep > prev.length || currentStep > next.length) return false;
  for (let i = 0; i < currentStep; i++) {
    const a = prev[i]!;
    const b = next[i]!;
    if (a.kind !== b.kind) return false;
    if (a.kind === "email" && continuesThread(prev, i) !== continuesThread(next, i)) return false;
  }
  return true;
}

/* ───────────────────────────── Templates ───────────────────────────── */

export const KNOWN_VARIABLES = ["first_name", "last_name", "full_name", "company", "title", "sender_first_name", "sender_name", "opener"] as const;
export type KnownVariable = (typeof KNOWN_VARIABLES)[number];
export const VARIABLE_HELP: Record<KnownVariable, string> = {
  first_name: "Contact first name",
  last_name: "Contact last name",
  full_name: "Contact full name",
  company: "Account name",
  title: "Contact job title",
  sender_first_name: "Your first name",
  sender_name: "Your full name",
  opener: "Personal opener (Lead Scout batch)",
};

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\|([^{}]*))?\}\}/g;

export function templateVariables(t: string): { name: string; fallback: string | null }[] {
  const out: { name: string; fallback: string | null }[] = [];
  for (const m of t.matchAll(VAR_RE)) out.push({ name: m[1]!.toLowerCase(), fallback: m[2] != null ? m[2].trim() : null });
  return out;
}

function hasBrokenBraces(t: string): boolean {
  return /\{\{|\}\}/.test(t.replace(VAR_RE, ""));
}

export type RenderResult = { text: string; missing: string[] };

/**
 * Substitute `{{var}}` / `{{var|fallback}}`. A variable that is unknown, or empty with no fallback, is reported in
 * `missing` (and left out of the text). Callers must refuse to send when `missing` is non-empty.
 */
export function renderTemplate(t: string, vars: Record<string, string | null | undefined>): RenderResult {
  const missing = new Set<string>();
  const text = t.replace(VAR_RE, (_m, rawName: string, fb: string | undefined) => {
    const name = rawName.toLowerCase();
    const v = (vars[name] ?? "").toString().trim();
    if (v) return v;
    const fallback = fb?.trim();
    if (fallback) return fallback;
    missing.add(name);
    return "";
  });
  if (hasBrokenBraces(text)) missing.add("{{…}}");
  return { text, missing: [...missing] };
}

export type ContactVars = { firstName?: string | null; lastName?: string | null; fullName?: string | null; title?: string | null; company?: string | null };
export type SenderVars = { name?: string | null };

export function firstNameOf(full: string | null | undefined): string {
  return (full ?? "").trim().split(/\s+/)[0] ?? "";
}

/** The variable map for one enrollment; enrollment-level variables (e.g. opener) win over contact fields. */
export function buildVariables(contact: ContactVars, sender: SenderVars, extra: Record<string, string> = {}): Record<string, string> {
  const vars: Record<string, string> = {
    first_name: contact.firstName?.trim() ?? "",
    last_name: contact.lastName?.trim() ?? "",
    full_name: contact.fullName?.trim() ?? "",
    company: contact.company?.trim() ?? "",
    title: contact.title?.trim() ?? "",
    sender_first_name: firstNameOf(sender.name),
    sender_name: sender.name?.trim() ?? "",
  };
  for (const [k, v] of Object.entries(extra)) if (typeof v === "string" && v.trim()) vars[k.toLowerCase()] = v.trim();
  return vars;
}

/** Render every email/task step for a contact; returns the variables each step is missing (empty = sendable). */
export function missingForSteps(steps: Step[], vars: Record<string, string>, fromStep = 0): { step: number; missing: string[] }[] {
  const out: { step: number; missing: string[] }[] = [];
  steps.forEach((s, i) => {
    if (i < fromStep) return;
    const parts = s.kind === "email" ? [s.subject ?? "", s.body ?? ""] : [s.title ?? "", s.body ?? ""];
    const missing = [...new Set(parts.flatMap((p) => renderTemplate(p, vars).missing))];
    if (missing.length) out.push({ step: i, missing });
  });
  return out;
}

export function replySubjectOf(subject: string): string {
  const s = subject.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** Subject for email step `index`: in-thread follow-ups reuse the thread's subject as "Re: …". */
export function subjectForStep(steps: Step[], index: number): string {
  const step = steps[index];
  if (!step || step.kind !== "email") return "";
  const firstEmail = steps.findIndex((s) => s.kind === "email");
  const startsThread = (i: number) => i === firstEmail || (steps[i]?.kind === "email" && steps[i]!.replyInThread === false);
  if (startsThread(index)) return step.subject ?? "";
  for (let i = index - 1; i >= 0; i--) if (startsThread(i)) return replySubjectOf(steps[i]!.subject ?? "");
  return step.subject ?? "";
}

/** Does email step `index` continue the previous thread (vs. start a new one)? */
export function continuesThread(steps: Step[], index: number): boolean {
  const firstEmail = steps.findIndex((s) => s.kind === "email");
  const step = steps[index];
  return Boolean(step && step.kind === "email" && index !== firstEmail && step.replyInThread !== false);
}

/* ───────────────────────────── Scheduling (sender's working hours) ───────────────────────────── */

export type WorkWindow = { tz: string; startHour: number; endHour: number };

const HOUR = 3_600_000;
const DAY = 86_400_000;

export function normalizeWindow(w: { tz?: string | null; startHour?: number | null; endHour?: number | null }): WorkWindow {
  let tz = w.tz || "America/New_York";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = "America/New_York";
  }
  let s = Number.isFinite(w.startHour) ? Math.round(w.startHour as number) : 9;
  let e = Number.isFinite(w.endHour) ? Math.round(w.endHour as number) : 18;
  s = Math.max(0, Math.min(23, s));
  e = Math.max(1, Math.min(24, e));
  if (e <= s) {
    s = 9;
    e = 18;
  }
  return { tz, startHour: s, endHour: e };
}

const isWeekend = (wall: Date) => wall.getUTCDay() === 0 || wall.getUTCDay() === 6;

export function isWithinWindow(at: Date, w: WorkWindow): boolean {
  const wall = toWall(at, w.tz);
  if (isWeekend(wall)) return false;
  const h = wall.getUTCHours() + wall.getUTCMinutes() / 60;
  return h >= w.startHour && h < w.endHour;
}

/** `at` if it is inside working hours, else the start of the next working window (business days only). */
export function nextWindowStart(at: Date, w: WorkWindow): Date {
  if (isWithinWindow(at, w)) return at;
  const wall = toWall(at, w.tz);
  let day = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  const hourOfDay = (wall.getTime() - day) / HOUR;
  if (isWeekend(wall) || hourOfDay >= w.endHour) day += DAY;
  for (let i = 0; i < 14; i++, day += DAY) {
    const d = new Date(day);
    if (!isWeekend(d)) return fromWall(new Date(day + w.startHour * HOUR), w.tz);
  }
  return at;
}

/** Add n business days in the window's zone keeping the wall-clock time; then clamp into working hours. */
export function scheduleAfter(from: Date, delayDays: number, w: WorkWindow, jitterMin = 0): Date {
  let wall = toWall(from, w.tz);
  let added = 0;
  const n = Math.max(0, Math.floor(delayDays));
  while (added < n) {
    wall = new Date(wall.getTime() + DAY);
    if (!isWeekend(wall)) added++;
  }
  const base = new Date(fromWall(wall, w.tz).getTime() + Math.max(0, jitterMin) * 60_000);
  return nextWindowStart(base, w);
}

/** Deterministic 0..max minute spread per enrollment+step, so a batch doesn't leave the mailbox in one burst. */
export function jitterMinutes(seed: string, max = 25): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return Math.abs(h) % (max + 1);
}

/* ───────────────────────────── Caps & retries ───────────────────────────── */

export const DEFAULT_DAILY_CAP = 40;
export const HARD_DAILY_CAP = 200;

export function effectiveCap(cap: number | null | undefined): number {
  const n = Number.isFinite(cap) ? Math.round(cap as number) : DEFAULT_DAILY_CAP;
  return Math.max(1, Math.min(HARD_DAILY_CAP, n));
}

/**
 * One cap per MAILBOX (QA MIN-25): the strictest daily cap among the sequences the mailbox is sending today (incl. the
 * one about to send). Mixing a mailbox-wide count with one sequence's cap let a 200/day sequence push a mailbox whose
 * other sequence promised 20/day far past it.
 */
export function mailboxCap(caps: (number | null | undefined)[]): number {
  const valid = caps.filter((c): c is number => Number.isFinite(c));
  return valid.length ? Math.min(...valid.map(effectiveCap)) : DEFAULT_DAILY_CAP;
}

/** Per-mailbox daily cap: `usedToday` counts send intents (incl. in-flight) in the sender's local day. */
export function capDecision(usedToday: number, cap: number): { allowed: boolean; remaining: number } {
  const c = effectiveCap(cap);
  const remaining = Math.max(0, c - usedToday);
  return { allowed: remaining > 0, remaining };
}

/** Backoff after the n-th failed attempt (1-based): 15 min, 1 h, 4 h. */
export function retryDelayMs(attempt: number): number {
  return [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000][Math.max(0, Math.min(2, attempt - 1))]!;
}

/* ───────────────────────────── History (idempotency ledger) ───────────────────────────── */

export type HistoryEntry = { step: number; at: string; kind: string; ok: boolean; note?: string; by?: string };

/**
 * kinds: "email" (sent; note = Message-ID header), "email_intent" (written BEFORE calling Gmail; note = the
 * Message-ID we generated), "email_failed", "task" (task created; note = task id), "task_done", "linkedin", "exit",
 * "retry" (manual retry resets the attempt counter), "paused", "resumed", "skipped", "steps_updated".
 * "paused" entries: ok=false + note=reason when the SYSTEM paused (Gmail revoked, sender inactive, restricted…);
 * ok=true + note="manual" + by=<user id> when a PERSON paused on purpose.
 */
export function intentFor(history: HistoryEntry[], step: number): HistoryEntry | null {
  return [...history].reverse().find((h) => h.step === step && h.kind === "email_intent") ?? null;
}

/** Failed attempts for a step since the last manual retry. */
export function failuresFor(history: HistoryEntry[], step: number): number {
  let n = 0;
  for (const h of history) {
    if (h.step !== step) continue;
    if (h.kind === "retry") n = 0;
    else if (h.kind === "email_failed" || h.kind === "task_failed") n++;
  }
  return n;
}

/**
 * Was this enrollment's current pause done by the system (so "Resume all" may lift it)? A person's deliberate pause is
 * never resumed in bulk (QA MAJ-12). Legacy rows without a pause entry count as system pauses only when an error is set.
 */
export function isSystemPause(history: HistoryEntry[], lastError: string | null | undefined): boolean {
  const last = [...history].reverse().find((h) => h.kind === "paused");
  if (last) return last.ok === false;
  return Boolean(lastError);
}

/** Message-IDs of sent emails, oldest first (for the References header of in-thread follow-ups). */
export function sentMessageIds(history: HistoryEntry[]): string[] {
  return history.filter((h) => h.kind === "email" && h.ok && h.note).map((h) => h.note!);
}

export function referencesHeader(ids: string[]): string | null {
  const uniq = [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
  return uniq.length ? uniq.slice(-20).join(" ") : null;
}

/** Our own RFC 5322 Message-ID: lets a crashed send be found again with Gmail's `rfc822msgid:` search. */
export function makeMessageId(enrollmentId: string, step: number, nonce: string): string {
  return `<seq.${enrollmentId.replace(/[^a-z0-9-]/gi, "")}.${step}.${nonce.replace(/[^a-z0-9]/gi, "").slice(0, 16)}@rtb-sales-os>`;
}

/* ───────────────────────────── Exit rules ───────────────────────────── */

export type ExitReason = "replied" | "meeting_booked" | "stage_changed" | "unsubscribed" | "bounced" | "do_not_contact" | "no_email" | "contact_removed" | "deal_closed";

export type ExitFacts = {
  contactMissing?: boolean;
  doNotContact?: boolean; // contact or account flag
  suppressed?: boolean; // global suppression list (email or domain)
  leftCompany?: boolean;
  noEmail?: boolean; // only relevant before an email step
  emailInvalid?: boolean;
  bounced?: boolean;
  unsubscribeReply?: boolean;
  replied?: boolean;
  meetingBooked?: boolean;
  stageChanged?: boolean;
  dealClosed?: boolean;
};

/**
 * First matching exit reason, or null. Do-not-contact, suppression, unsubscribe and bounces are ALWAYS honored
 * (CON-6 / SCOUT-23, regardless of the sequence's toggles); reply / meeting / stage follow the sequence's rules.
 */
export function evaluateExit(rules: ExitRules, f: ExitFacts): ExitReason | null {
  if (f.contactMissing) return "contact_removed";
  if (f.unsubscribeReply) return "unsubscribed";
  if (f.doNotContact || f.suppressed) return "do_not_contact";
  if (f.bounced || f.emailInvalid) return "bounced";
  if (f.leftCompany) return "contact_removed";
  if (rules.reply !== false && f.replied) return "replied";
  if (rules.meetingBooked !== false && f.meetingBooked) return "meeting_booked";
  if (rules.stageChange !== false && (f.stageChanged || f.dealClosed)) return f.dealClosed ? "deal_closed" : "stage_changed";
  if (f.noEmail) return "no_email";
  return null;
}

export const EXIT_LABEL: Record<string, string> = {
  replied: "Replied",
  meeting_booked: "Meeting booked",
  stage_changed: "Deal stage changed",
  deal_closed: "Deal closed",
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
  do_not_contact: "Do not contact",
  no_email: "No email address",
  contact_removed: "Contact removed / left",
  manual: "Stopped",
  error: "Failed",
  completed: "Completed",
};

const UNSUB_RE = /\b(unsubscribe|remove me|take me off|stop (?:emailing|contacting|sending)|opt(?:\s|-)?out|do not (?:contact|email)|don'?t (?:contact|email) me)\b/i;
/** Does an inbound reply ask us to stop? Only the new text counts (quoted history is stripped by the caller). */
export function isUnsubscribeReply(text: string | null | undefined): boolean {
  if (!text) return false;
  return UNSUB_RE.test(text.slice(0, 2000));
}

/**
 * Out-of-office / auto-responder detection (CR L15): an automatic reply is not a human reply and must not end the
 * sequence. RFC 3834 `Auto-Submitted` (anything but "no"), the common X-Autoreply / X-Autorespond headers, and the
 * usual subject prefixes.
 */
const AUTO_SUBJECT_RE = /^\s*(automatic reply|auto(?:matic)?[- ]?reply|auto:|out of (?:the )?office|ooo\b|away from (?:the )?office|abwesenheit|r[ée]ponse automatique|respuesta autom[áa]tica)/i;
export function isAutoReply(h: { autoSubmitted?: string | null; xAutoreply?: string | null; xAutorespond?: string | null; precedence?: string | null; subject?: string | null }): boolean {
  const auto = (h.autoSubmitted ?? "").trim().toLowerCase();
  if (auto && auto !== "no") return true;
  if ((h.xAutoreply ?? "").trim() || (h.xAutorespond ?? "").trim()) return true;
  if (/^auto[_-]?reply$/i.test((h.precedence ?? "").trim())) return true;
  return AUTO_SUBJECT_RE.test(h.subject ?? "");
}

const OOO_TEXT_RE = /\b(out of (?:the )?office|on (?:annual |parental |sick )?leave|currently (?:away|travell?ing)|limited access to (?:my )?e-?mail|i (?:will|'ll) be back (?:on|in)|returning on|this is an automatic reply|auto(?:matic|mated)? response)\b/i;
/** Ingested replies carry no headers: a SHORT body that reads like an out-of-office counts as an auto-reply. */
export function looksLikeOutOfOffice(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > 800) return false;
  return OOO_TEXT_RE.test(t.slice(0, 400));
}

const BOUNCE_FROM_RE = /(mailer-daemon|postmaster|mail delivery (?:subsystem|system))/i;
export function isBounceSender(from: string | null | undefined): boolean {
  return Boolean(from && BOUNCE_FROM_RE.test(from));
}

/* ───────────────────────────── Metrics ───────────────────────────── */

export type MetricRow = { status: string; exitReason: string | null; n: number };
export type SequenceMetrics = { enrolled: number; active: number; paused: number; completed: number; replied: number; unsubscribed: number; meetings: number; bounced: number; failed: number; replyRate: number | null };

export function computeMetrics(rows: MetricRow[]): SequenceMetrics {
  const m: SequenceMetrics = { enrolled: 0, active: 0, paused: 0, completed: 0, replied: 0, unsubscribed: 0, meetings: 0, bounced: 0, failed: 0, replyRate: null };
  for (const r of rows) {
    m.enrolled += r.n;
    if (r.status === "active") m.active += r.n;
    else if (r.status === "paused") m.paused += r.n;
    else if (r.status === "completed") m.completed += r.n;
    else if (r.status === "failed") m.failed += r.n;
    // opt-outs are tracked separately: an "unsubscribe" reply is not engagement (QA MIN-26)
    if (r.exitReason === "replied") m.replied += r.n;
    if (r.exitReason === "unsubscribed") m.unsubscribed += r.n;
    if (r.exitReason === "meeting_booked") m.meetings += r.n;
    if (r.exitReason === "bounced") m.bounced += r.n;
  }
  m.replyRate = m.enrolled ? m.replied / m.enrolled : null;
  return m;
}
