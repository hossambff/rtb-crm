/**
 * Approval SLAs (docs/V2_SPEC.md §C7) — pure, unit tested (src/lib/approvals/__tests__/sla-core.test.ts).
 * Settings live in app_settings under SLA_SETTINGS_KEY; anything missing/invalid falls back to the defaults.
 */
import { fromWall, toWall } from "@/lib/alerts/time";

export const SLA_SETTINGS_KEY = "approvals.sla";

/** Spec defaults: override 24 h, proposal 48 h, scout budget 24 h, stage gate 24 h, lead registration 72 h. */
export const DEFAULT_SLA_HOURS: Record<string, number> = {
  probability_override: 24,
  proposal: 48,
  scout_budget: 24,
  stage_gate: 24,
  lead_registration: 72,
  scout_accept: 48,
};

export type SlaSettings = {
  hours: Record<string, number>;
  /** For kinds not listed in `hours` (new modules plugging into the registry). */
  defaultHours: number;
  /** "Weekends don't count": the clock pauses Saturday–Sunday in `timezone`. */
  pauseWeekends: boolean;
  timezone: string;
};

export const DEFAULT_SLA_SETTINGS: SlaSettings = { hours: { ...DEFAULT_SLA_HOURS }, defaultHours: 24, pauseWeekends: false, timezone: "America/New_York" };

export const MIN_SLA_HOURS = 1;
export const MAX_SLA_HOURS = 24 * 30;

const validHours = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= MIN_SLA_HOURS && v <= MAX_SLA_HOURS;

function validTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Merge a stored (untrusted jsonb) value over the defaults. */
export function normalizeSlaSettings(raw: unknown): SlaSettings {
  const r = raw && typeof raw === "object" ? (raw as Partial<SlaSettings>) : {};
  const hours: Record<string, number> = { ...DEFAULT_SLA_HOURS };
  if (r.hours && typeof r.hours === "object") {
    for (const [k, v] of Object.entries(r.hours)) if (/^[a-z_]{1,40}$/.test(k) && validHours(v)) hours[k] = Math.round(v);
  }
  return {
    hours,
    defaultHours: validHours(r.defaultHours) ? Math.round(r.defaultHours) : DEFAULT_SLA_SETTINGS.defaultHours,
    pauseWeekends: r.pauseWeekends === true,
    timezone: validTz(r.timezone) ? r.timezone : DEFAULT_SLA_SETTINGS.timezone,
  };
}

export function slaHoursFor(kind: string, settings: SlaSettings): number {
  return settings.hours[kind] ?? settings.defaultHours;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * `from` + `hours`. With `pauseWeekends`, time only accrues Monday–Friday (local to `tz`): a request raised on
 * Saturday starts its clock Monday 00:00, and 24 h from Friday 15:00 is Monday 15:00.
 */
export function addSlaHours(from: Date, hours: number, opts: { pauseWeekends: boolean; tz: string }): Date {
  const ms = Math.max(0, hours) * HOUR;
  if (!opts.pauseWeekends) return new Date(from.getTime() + ms);
  let wall = toWall(from, opts.tz).getTime();
  let remaining = ms;
  // Bounded: at most ~MAX_SLA_HOURS/24 weekdays plus weekend skips.
  for (let i = 0; i < 400; i++) {
    const d = new Date(wall);
    const dow = d.getUTCDay();
    const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (dow === 0 || dow === 6) {
      wall = midnight + (dow === 6 ? 2 : 1) * DAY; // jump to Monday 00:00
      continue;
    }
    const untilMidnight = midnight + DAY - wall;
    if (remaining <= untilMidnight) {
      wall += remaining;
      remaining = 0;
      break;
    }
    remaining -= untilMidnight;
    wall = midnight + DAY;
  }
  return fromWall(new Date(wall), opts.tz);
}

export function computeDueAt(kind: string, createdAt: Date, settings: SlaSettings): Date {
  return addSlaHours(createdAt, slaHoursFor(kind, settings), { pauseWeekends: settings.pauseWeekends, tz: settings.timezone });
}

/** Compact duration: "45m", "3h", "2d 4h". */
export function fmtDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

export type SlaStatus = {
  waitingMs: number;
  waiting: string; // "3h"
  dueAt: string | null; // ISO
  state: "none" | "ok" | "due_soon" | "overdue";
  /** "due in 5h" | "overdue by 2h" | null */
  dueLabel: string | null;
};

/** Status of a pending request; `due_soon` = less than 25 % of the SLA (or < 2 h) left. */
export function slaStatus(p: { createdAt: Date; dueAt: Date | null }, now: Date = new Date()): SlaStatus {
  const waitingMs = Math.max(0, now.getTime() - p.createdAt.getTime());
  const base = { waitingMs, waiting: fmtDuration(waitingMs) };
  if (!p.dueAt) return { ...base, dueAt: null, state: "none", dueLabel: null };
  const left = p.dueAt.getTime() - now.getTime();
  const total = Math.max(1, p.dueAt.getTime() - p.createdAt.getTime());
  if (left <= 0) return { ...base, dueAt: p.dueAt.toISOString(), state: "overdue", dueLabel: `overdue by ${fmtDuration(-left)}` };
  const soon = left < Math.min(2 * HOUR, total) || left / total < 0.25;
  return { ...base, dueAt: p.dueAt.toISOString(), state: soon ? "due_soon" : "ok", dueLabel: `due in ${fmtDuration(left)}` };
}

/**
 * Backup approvers ("next role up"): who gets the one-time escalation when a request is overdue. Executive-level
 * requests escalate to super admins (the only level above), everything else to executives.
 */
export function escalationRoles(approverRole: string): string[] {
  if (approverRole === "executive") return ["super_admin"];
  if (approverRole === "super_admin") return ["super_admin"];
  return ["executive"];
}
