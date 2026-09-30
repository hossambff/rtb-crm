/**
 * Nothing Slips (PRD §12) — pure rule predicates. No DB, no server-only deps (unit tested in __tests__/rules.test.ts).
 * The engine (engine.ts) loads rows, calls these predicates and upserts alerts.
 */
import {
  businessDaysBetween,
  businessDaysPassed,
  businessHoursBetween,
  daysBetween,
  daysLeftInMonth,
  isBusinessDay,
  localDateKey,
} from "./time";
import { participationMonthIndex } from "../r100/calc";

export type Severity = "info" | "warning" | "serious" | "critical";
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };

export type RuleParams = Record<string, unknown>;

export function num(params: RuleParams | null | undefined, key: string, fallback: number): number {
  const v = params?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
export function numList(params: RuleParams | null | undefined, key: string, fallback: number[]): number[] {
  const v = params?.[key];
  return Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : fallback;
}

/* ───────────── Deals ───────────── */

export type DealLike = {
  nextStep?: string | null;
  nextStepDueAt?: Date | null;
  expectedCloseDate?: Date | null;
  stageEnteredAt: Date;
  lastActivityAt?: Date | null;
};

/** NS-01: every open deal needs a next step AND a due date. */
export function missingNextStep(d: Pick<DealLike, "nextStep" | "nextStepDueAt">): boolean {
  return !d.nextStep?.trim() || d.nextStepDueAt == null;
}

/** NS-02: next-step due date passed. */
export function nextStepOverdue(d: Pick<DealLike, "nextStepDueAt">, now: Date): boolean {
  return d.nextStepDueAt != null && d.nextStepDueAt.getTime() < now.getTime();
}

/** Reference time for "no activity in stage": the later of stage entry and last activity. */
export function lastTouch(d: Pick<DealLike, "stageEnteredAt" | "lastActivityAt">): Date {
  const a = d.stageEnteredAt;
  const b = d.lastActivityAt;
  return b && b > a ? b : a;
}

/**
 * NS-03: idle longer than the stage SLA. mode "calendar" (default — matches AT-06: 6 idle days in Hot/SLA 5 fires) or
 * "business" (weekdays only, in the owner's timezone).
 */
export function staleBeyondSla(
  d: Pick<DealLike, "stageEnteredAt" | "lastActivityAt">,
  slaDays: number | null | undefined,
  now: Date,
  opts: { tz?: string; mode?: "calendar" | "business" } = {},
): { stale: boolean; idleDays: number } {
  const ref = lastTouch(d);
  const idleDays = opts.mode === "business" ? businessDaysBetween(ref, now, opts.tz ?? "UTC") : daysBetween(ref, now);
  return { stale: slaDays != null && slaDays > 0 && idleDays > slaDays, idleDays };
}

/** NS-09: expected close date passed by ≥ graceDays (default 1). */
export function closeDatePassed(d: Pick<DealLike, "expectedCloseDate">, now: Date, graceDays = 1): boolean {
  return d.expectedCloseDate != null && daysBetween(d.expectedCloseDate, now) >= graceDays;
}

/** NS-12 (best effort): no health history table, so fire when health is below a floor. */
export function healthCritical(score: number | null | undefined, floor = 40): boolean {
  return score != null && score < floor;
}

/** NS-15: high-value lead without an owner for ≥ hours. */
export function highValueUnassigned(
  d: { ownerId?: string | null; muu?: number | null; priority?: string | null; createdAt: Date },
  now: Date,
  opts: { muuMin: number; hours: number; tz?: string },
): boolean {
  if (d.ownerId) return false;
  const high = (d.muu ?? 0) >= opts.muuMin || d.priority === "top10" || d.priority === "high";
  return high && businessHoursBetween(d.createdAt, now, opts.tz ?? "America/New_York") >= opts.hours;
}

/** NS-27: data-quality gaps on an engaged deal. Returns human-readable gaps (empty = clean). */
export function dataQualityGaps(d: {
  unit: string;
  muu?: number | null;
  primaryContactId?: string | null;
  primaryContactEmailStatus?: string | null;
  contractValueCents?: number | null;
  annualizedValueCents?: number | null;
}): string[] {
  const gaps: string[] = [];
  if (d.unit === "muu" && !(d.muu && d.muu > 0)) gaps.push("MUU");
  if (d.unit === "usd" && !(d.contractValueCents || d.annualizedValueCents)) gaps.push("deal value");
  if (!d.primaryContactId) gaps.push("primary contact");
  else if (d.primaryContactEmailStatus === "invalid") gaps.push("valid email for primary contact");
  return gaps;
}

/* ───────────── Email / meetings / tasks ───────────── */

/** NS-04: inbound email awaiting our reply for ≥ hours of working time (recipient's timezone/work hours). */
export function emailUnanswered(
  t: { awaitingReplyFrom?: string | null; lastMessageAt?: Date | null },
  now: Date,
  opts: { hours: number; tz: string; startHour?: number; endHour?: number },
): boolean {
  if (t.awaitingReplyFrom !== "us" || !t.lastMessageAt) return false;
  return businessHoursBetween(t.lastMessageAt, now, opts.tz, opts.startHour ?? 9, opts.endHour ?? 18) >= opts.hours;
}

export type TaskLike = {
  status: string;
  owedBy?: string | null;
  dueAt?: Date | null;
  snoozedUntil?: Date | null;
  snoozeCount?: number;
};

function isSnoozed(t: TaskLike, now: Date) {
  return t.snoozedUntil != null && t.snoozedUntil > now;
}

/** NS-05: our commitment due within reminder window (default 1 day) → "due_soon"; past due → "overdue". */
export function ourCommitmentState(t: TaskLike, now: Date, reminderDays = 1): "overdue" | "due_soon" | null {
  if (t.status !== "open" || t.owedBy !== "us" || !t.dueAt || isSnoozed(t, now)) return null;
  if (t.dueAt < now) return "overdue";
  return t.dueAt.getTime() - now.getTime() <= reminderDays * 86_400_000 ? "due_soon" : null;
}

/** NS-06: their commitment passed by ≥ graceDays with the task still open. */
export function theirCommitmentPassed(t: TaskLike, now: Date, graceDays = 2): boolean {
  if (t.status !== "open" || t.owedBy !== "them" || !t.dueAt || isSnoozed(t, now)) return false;
  return now.getTime() - t.dueAt.getTime() >= graceDays * 86_400_000;
}

/** NS-26: snoozed repeatedly. */
export function snoozedTooOften(t: TaskLike, threshold = 3): boolean {
  return t.status === "open" && (t.snoozeCount ?? 0) >= threshold;
}

/** Attendee list contains at least one address outside our own domains. */
export function hasExternalAttendee(attendees: string[], internalDomains: string[]): boolean {
  const internal = new Set(internalDomains.map((d) => d.toLowerCase()));
  return attendees.some((a) => {
    const m = a.toLowerCase().match(/@([^>\s]+)/);
    return m ? !internal.has(m[1]!.replace(/[>.]+$/, "")) : false;
  });
}

/** NS-07: external meeting ended ≥ hours ago with no transcript and no logged notes/activity. Looks back 14 days. */
export function meetingNeedsNotes(
  m: { endsAt?: Date | null; attendees: string[]; transcriptId?: string | null; hasNotes: boolean },
  now: Date,
  opts: { hours: number; internalDomains: string[]; lookbackDays?: number },
): boolean {
  if (!m.endsAt || m.transcriptId || m.hasNotes) return false;
  const since = now.getTime() - m.endsAt.getTime();
  if (since < opts.hours * 3_600_000 || since > (opts.lookbackDays ?? 14) * 86_400_000) return false;
  return hasExternalAttendee(m.attendees, opts.internalDomains);
}

/* ───────────── Documents ───────────── */

/** NS-10: document sent and not signed after N business days (createdAt is the send proxy). */
export function docUnsigned(
  doc: { type: string; status: string; createdAt: Date },
  now: Date,
  opts: { businessDays: number; tz: string },
): boolean {
  if (doc.status !== "sent") return false;
  if (!["nda", "contract", "io", "proposal", "pro_forma"].includes(doc.type)) return false;
  return businessDaysPassed(doc.createdAt, now, opts.businessDays, opts.tz);
}

/** NS-11: signed NDA/contract expiring within N days. */
export function docExpiring(doc: { type: string; status: string; expiresAt?: Date | null }, now: Date, days = 30): boolean {
  if (!doc.expiresAt || !["nda", "contract", "io"].includes(doc.type)) return false;
  if (doc.status === "expired") return false;
  const left = doc.expiresAt.getTime() - now.getTime();
  return left > 0 && left <= days * 86_400_000;
}

/* ───────────── Onboarding ───────────── */

export function migrationStalled(
  p: { stage: string; launched: boolean; stageEnteredAt: Date },
  now: Date,
  days = 10,
): boolean {
  if (p.launched || ["live", "paused", "launched"].includes(p.stage)) return false;
  return daysBetween(p.stageEnteredAt, now) >= days;
}

export function goLiveSlipped(p: { launched: boolean; targetGoLive?: Date | null; actualGoLive?: Date | null }, now: Date): boolean {
  return !p.launched && !p.actualGoLive && p.targetGoLive != null && p.targetGoLive < now;
}

/* ───────────── Escalation ───────────── */

/**
 * Escalation recipients (QA-04): the manager (user.managerId, else the team lead — resolved by the caller), else every
 * active sales leader, else every active executive; never the user themselves.
 */
export function escalationChain(p: { self: string; manager: string | null; salesLeaders: string[]; executives: string[] }): string[] {
  if (p.manager && p.manager !== p.self) return [p.manager];
  for (const tier of [p.salesLeaders, p.executives]) {
    const ids = tier.filter((id) => id !== p.self);
    if (ids.length) return ids;
  }
  return [];
}

/* ───────────── R100 ───────────── */

/**
 * NS-21: live RTB100 company hasn't posted this month. participation[i] = month i+1 since firstPostDate, using the
 * SAME calendar-month index as the R100 page (`participationMonthIndex`, H-06). Participation is only expected for
 * months 1..`months` (default 3 = the program's participation slots); after that the rule never fires, and it clears
 * as soon as the month is ticked. Fires only in the last `windowDays` days of the month (PRD: month end −7 days).
 */
export function r100ParticipationLapsing(
  r100: { firstPostDate?: string | null; participation?: boolean[] } | null | undefined,
  now: Date,
  opts: { tz: string; windowDays?: number; months?: number },
): boolean {
  const idx = participationMonthIndex(r100?.firstPostDate, now);
  if (idx == null || idx < 0 || idx >= (opts.months ?? 3)) return false;
  if (daysLeftInMonth(now, opts.tz) > (opts.windowDays ?? 7)) return false;
  return r100?.participation?.[idx] !== true;
}

export type Interview = { key: string; guest?: string; filmedAt: Date };

/** NS-22: interviews (deal.customFields.interviews) filmed ≥ days ago without a publish date. */
export function unpublishedInterviews(customFields: Record<string, unknown> | null | undefined, now: Date, days = 14): Interview[] {
  const raw = customFields?.interviews ?? customFields?.interview;
  const list: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const out: Interview[] = [];
  list.forEach((it, i) => {
    if (!it || typeof it !== "object") return;
    const o = it as Record<string, unknown>;
    const filmedRaw = o.filmedAt ?? o.filmedDate ?? o.filmed_date;
    const pubRaw = o.publishedAt ?? o.publishDate ?? o.publish_date;
    const status = typeof o.status === "string" ? o.status.toLowerCase() : "";
    if (status === "published") return;
    const filmed = typeof filmedRaw === "string" || filmedRaw instanceof Date ? new Date(filmedRaw) : null;
    if (!filmed || Number.isNaN(filmed.getTime())) return;
    const pub = typeof pubRaw === "string" && pubRaw.trim() && !/tbd/i.test(pubRaw) ? new Date(pubRaw) : null;
    if (pub && !Number.isNaN(pub.getTime())) return;
    if (daysBetween(filmed, now) < days) return;
    out.push({ key: String(o.id ?? i), guest: typeof o.guest === "string" ? o.guest : undefined, filmedAt: filmed });
  });
  return out;
}

/* ───────────── Revenue ───────────── */

/**
 * NS-23: highest overdue tier reached (e.g. [1,7,14] → 14 when 20 days late), or null. Days late are CALENDAR days in
 * `tz` (M-07): due Oct 1 is 1 day late all of Oct 2, matching the revenue page, not "24 h after the due instant".
 */
export function invoiceOverdueTier(
  inv: { status: string; dueAt: Date; paidAt?: Date | null },
  now: Date,
  tiers: number[] = [1, 7, 14],
  tz = "America/New_York",
): number | null {
  if (inv.paidAt || ["paid", "written_off"].includes(inv.status)) return null;
  const late = Math.round((Date.parse(localDateKey(now, tz)) - Date.parse(localDateKey(inv.dueAt, tz))) / 86_400_000);
  const hit = [...tiers].sort((a, b) => a - b).filter((t) => late >= t);
  return hit.length ? hit[hit.length - 1]! : null;
}

/** NS-24: nearest renewal tier the renewal date falls within (e.g. 20 days out with [60,30,14] → 30), or null. */
export function renewalTier(renewalAt: Date | null | undefined, now: Date, tiers: number[] = [60, 30, 14]): number | null {
  if (!renewalAt || renewalAt <= now) return null;
  const left = (renewalAt.getTime() - now.getTime()) / 86_400_000;
  const hit = [...tiers].sort((a, b) => a - b).find((t) => left <= t);
  return hit ?? null;
}

/* ───────────── People / system ───────────── */

/** NS-25: no logged activity in ≥ N business days (baseline = last activity or account creation). */
export function repInactive(lastActivityAt: Date | null | undefined, createdAt: Date, now: Date, opts: { businessDays: number; tz: string }): boolean {
  const ref = lastActivityAt && lastActivityAt > createdAt ? lastActivityAt : createdAt;
  return businessDaysPassed(ref, now, opts.businessDays, opts.tz);
}

/** NS-33: highest budget threshold (fraction) reached, or null. */
export function budgetThreshold(spentCents: number, budgetCents: number, thresholds: number[] = [0.5, 0.8, 1]): number | null {
  if (!(budgetCents > 0)) return null;
  const ratio = spentCents / budgetCents;
  const hit = [...thresholds].sort((a, b) => a - b).filter((t) => ratio >= t);
  return hit.length ? hit[hit.length - 1]! : null;
}

/** NS-16 (expiring branch): approved registration protection ends within N days. */
export function registrationExpiring(r: { status: string; protectedUntil?: Date | null }, now: Date, days = 7): boolean {
  if (r.status !== "approved" || !r.protectedUntil) return false;
  const left = r.protectedUntil.getTime() - now.getTime();
  return left > 0 && left <= days * 86_400_000;
}

/**
 * Escalation (PRD §12.2): only on business days, after `afterHours` of working time since the alert opened.
 */
export function escalationDue(
  a: { createdAt: Date; state: string; escalatedAt?: Date | null },
  afterHours: number | null | undefined,
  now: Date,
  opts: { tz: string; startHour?: number; endHour?: number },
): boolean {
  if (!afterHours || afterHours <= 0 || a.escalatedAt) return false;
  if (!["open", "acknowledged"].includes(a.state)) return false;
  if (!isBusinessDay(now, opts.tz)) return false;
  // escalateAfterHours is expressed in wall hours (24 = one business day); convert to business days when ≥ 24.
  if (afterHours >= 24) return businessDaysPassed(a.createdAt, now, Math.round(afterHours / 24), opts.tz);
  return businessHoursBetween(a.createdAt, now, opts.tz, opts.startHour ?? 9, opts.endHour ?? 18) >= afterHours;
}

/* ───────────── Rule catalogue metadata ───────────── */

/** Rules that are evaluated by the engine today. Others are no-ops pending data (see NOOP_RULES). */
export const IMPLEMENTED_RULES = [
  "NS-01", "NS-02", "NS-03", "NS-04", "NS-05", "NS-06", "NS-07", "NS-09", "NS-10", "NS-11", "NS-12", "NS-15", "NS-16",
  "NS-18", "NS-19", "NS-20", "NS-21", "NS-22", "NS-23", "NS-24", "NS-25", "NS-26", "NS-27", "NS-29", "NS-30", "NS-31",
  "NS-32", "NS-33",
] as const;

/** TODO(data): rules waiting on signals not yet captured anywhere in the schema/integrations. */
export const NOOP_RULES: Record<string, string> = {
  "NS-08": "Needs a 'prep viewed' signal (meeting prep open events) — Copilot/meeting prep module to record views.",
  "NS-13": "Needs per-contact touch/reply tracking from Gmail (email module): last 2 outbound touches without inbound reply.",
  "NS-14": "Needs bounce / 'left company' signals from Gmail bounces or enrichment (contacts.status = left_company changes).",
  "NS-17": "Duplicate detection needs fuzzy name/alt-domain matching (import/accounts module); exact domain dupes are blocked by a unique index.",
  "NS-28": "Sequences (ACT-5, P1) are not built yet — no enrollment table.",
  "NS-34": "Needs email bounce events mapped to enriched_contacts (email + enrichment modules).",
  "NS-35": "Needs weekly re-scan trigger events from Lead Scout (leadership change, traffic drop, CMS migration, ownership change).",
};

/** Stable dedupe key. Tiered rules put the tier in entityId (e.g. `<id>#t7`) so each tier re-notifies. */
export function alertKey(a: { ruleCode: string; entity: string; entityId: string; recipientId: string | null }) {
  return `${a.ruleCode}|${a.entity}|${a.entityId}|${a.recipientId ?? ""}`;
}
export function alertTriple(a: { ruleCode: string; entity: string; entityId: string }) {
  return `${a.ruleCode}|${a.entity}|${a.entityId}`;
}

/** Deep link for an alert's subject record. */
export function alertHref(entity: string, entityId: string): string {
  const id = entityId.split("#")[0]!;
  switch (entity) {
    case "deal":
      return `/deals/${id}`;
    case "account":
      return `/accounts/${id}`;
    case "task":
      return `/tasks?task=${id}`;
    case "email_thread":
      return `/inbox?thread=${id}`;
    case "meeting":
      return `/calls?meeting=${id}`;
    case "invoice":
      return `/revenue?invoice=${id}`;
    case "migration":
      return `/onboarding?project=${id}`;
    case "integration":
      return "/settings";
    case "proposal":
      return `/proposals/${id}`;
    case "scout_search":
      return `/scout/searches/${id}`;
    case "lead_registration":
      return "/commissions?tab=registrations";
    case "user":
      return "/tasks?tab=team";
    case "org":
      return id === "probability_overrides" ? "/tasks?tab=approvals" : "/scout";
    default:
      return "/tasks?tab=alerts";
  }
}
