/**
 * Shared time-zone helpers (M-06, QA-12). Pure — no server deps; safe in server and client components.
 *
 * Conventions:
 * - Every instant is stored in UTC (timestamptz). "Local" means the USER's profile time zone (`user.timezone`,
 *   default America/New_York) — never the server's (UTC on Vercel) or the browser's.
 * - DATE-ONLY inputs (next-step due, task due, close date, renewal, invoice/payment dates, …) are stored as 17:00
 *   ("close of business") on that day in the user's zone — clamped so the instant stays on the same UTC calendar day
 *   (e.g. 16:00 in Los Angeles) — so a date-only value reads back as the same YYYY-MM-DD both in the user's zone and in
 *   UTC (`toISOString().slice(0, 10)`), and "overdue" starts after that business day, not at 00:00 UTC (8 pm ET the
 *   evening before).
 * - Commission periods are UTC calendar months (accepted simplification, documented in CODE_REVIEW.md); invoice
 *   ageing counts calendar days.
 * - Server components format with the user's zone (`formatInTz`); client components receive the zone as a prop or
 *   render relative times through a client-only component, so server and browser render the same text.
 */
import { addBusinessDays, dayBounds, fromWall, localDateKey, toWall, tzOffsetMs } from "./alerts/time";

export { addBusinessDays, businessDaysBetween, dayBounds, isBusinessDay, localDateKey, toWall, fromWall, tzOffsetMs } from "./alerts/time";

export const DEFAULT_TZ = "America/New_York";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/; // <input type="datetime-local">, no zone

/** A valid IANA zone, else the default. */
export function safeTz(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/** Instant of wall-clock `hour:minute` on local date `YYYY-MM-DD` in `tz`. */
export function atLocalTime(dateOnly: string, hour: number, minute: number, tz: string): Date {
  const [y, m, d] = dateOnly.split("-").map(Number);
  return fromWall(new Date(Date.UTC(y!, m! - 1, d!, hour, minute)), safeTz(tz));
}

/**
 * Storage instant for a date-only value: 17:00 local on that day, moved earlier when needed so it stays on the same
 * UTC date (west of UTC−7) — see the module comment.
 */
export function dateOnlyToInstant(dateOnly: string, tz: string, hour = 17): Date {
  const at = atLocalTime(dateOnly, hour, 0, tz);
  const utcDay = Date.UTC(Number(dateOnly.slice(0, 4)), Number(dateOnly.slice(5, 7)) - 1, Number(dateOnly.slice(8, 10)));
  const lastSameUtcDay = utcDay + 86_400_000 - 60_000; // 23:59 UTC
  return at.getTime() > lastSameUtcDay ? new Date(lastSameUtcDay) : at;
}

/**
 * Parse a form date value in the user's zone: `YYYY-MM-DD` → `dateOnlyToInstant`; `YYYY-MM-DDTHH:mm` (no zone) →
 * that wall time in `tz`; anything with an explicit zone / `Z` → as given. Returns null for empty, undefined when
 * invalid (callers turn that into a field error).
 */
export function parseUserDate(v: string | null | undefined, tz: string, opts: { dateOnlyHour?: number } = {}): Date | null | undefined {
  if (v == null || v.trim() === "") return null;
  const s = v.trim();
  if (DATE_ONLY.test(s)) return validDate(dateOnlyToInstant(s, tz, opts.dateOnlyHour ?? 17));
  if (LOCAL_DATETIME.test(s)) {
    const [date, time] = s.split("T") as [string, string];
    const [hh, mm] = time.split(":").map(Number);
    return validDate(atLocalTime(date, hh!, mm!, tz));
  }
  return validDate(new Date(s));
}

function validDate(d: Date): Date | undefined {
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Local `YYYY-MM-DD` of an instant in `tz` (value for `<input type="date">`). */
export function toDateInput(d: Date | string | null | undefined, tz: string): string {
  if (!d) return "";
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? "" : localDateKey(date, safeTz(tz));
}

/** Local `YYYY-MM-DDTHH:mm` of an instant in `tz` (value for `<input type="datetime-local">`). */
export function toDateTimeInput(d: Date | string | null | undefined, tz: string): string {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return toWall(date, safeTz(tz)).toISOString().slice(0, 16);
}

/** Format an instant in `tz` via Intl (identical output on server and client for the same zone). */
export function formatInTz(d: Date | string | null | undefined, tz: string, style: "date" | "datetime" | "time" | "short" = "date"): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  const opts: Intl.DateTimeFormatOptions =
    style === "date"
      ? { day: "numeric", month: "short", year: "numeric" }
      : style === "short"
        ? { day: "numeric", month: "short" }
        : style === "time"
          ? { hour: "numeric", minute: "2-digit" }
          : { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: safeTz(tz) }).format(date);
}

/** "3 days ago" / "in 2 hours" relative to `now` (zone-independent; pass the server's `now` to avoid drift). */
export function formatRelative(d: Date | string | null | undefined, now: Date = new Date()): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 86_400_000],
    ["month", 30 * 86_400_000],
    ["week", 7 * 86_400_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, ms] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  return "just now";
}

/** Is a date-only deadline (stored per `dateOnlyToInstant`) past? Compares instants — correct in every zone. */
export function isPast(d: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!d) return false;
  const t = new Date(d).getTime();
  return !Number.isNaN(t) && t < now.getTime();
}

/** Business-day deadline: `n` business days after `from` in `tz`, keeping the wall-clock time (M-09). */
export function businessDeadline(from: Date, n: number, tz: string): Date {
  return addBusinessDays(from, n, safeTz(tz));
}

/** Start of the local day in `tz` (e.g. "today" buckets). */
export function startOfLocalDay(d: Date, tz: string): Date {
  return dayBounds(d, safeTz(tz)).start;
}

/** Offset label like "GMT-4" for UI hints. */
export function tzOffsetLabel(d: Date, tz: string): string {
  const h = tzOffsetMs(d, safeTz(tz)) / 3_600_000;
  return `GMT${h >= 0 ? "+" : "−"}${Math.abs(h)}`;
}
