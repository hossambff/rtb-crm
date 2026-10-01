/**
 * ISO-8601 week keys ("2026-W40") in a user's time zone. Pure — safe in server and client code.
 * Used as `briefs.period_key` for 1:1 prep (one brief per manager × report × ISO week).
 */
import { fromWall, toWall } from "@/lib/alerts/time";

const DAY = 86_400_000;
const KEY_RE = /^(\d{4})-W(\d{2})$/;

/** Monday (UTC midnight of the wall date) of ISO week 1 of `year`: the week containing 4 January. */
function week1Monday(year: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  const dow = (new Date(jan4).getUTCDay() + 6) % 7; // Mon = 0
  return jan4 - dow * DAY;
}

/** Number of ISO weeks in `year` (52 or 53). */
export function isoWeeksInYear(year: number): number {
  return Math.round((week1Monday(year + 1) - week1Monday(year)) / (7 * DAY));
}

/** ISO week key of the local calendar day containing `d` in `tz` (default UTC). */
export function isoWeekKey(d: Date, tz = "UTC"): string {
  const wall = toWall(d, tz);
  const day = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  const dow = (new Date(day).getUTCDay() + 6) % 7;
  const thursday = day - dow * DAY + 3 * DAY; // the ISO year is the year of the week's Thursday
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - week1Monday(year)) / (7 * DAY));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function parseIsoWeek(key: string): { year: number; week: number } | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (year < 1970 || year > 9999 || week < 1 || week > isoWeeksInYear(year)) return null;
  return { year, week };
}

export function isValidIsoWeek(key: string): boolean {
  return parseIsoWeek(key) !== null;
}

/** Start (Monday 00:00 local in `tz`) and exclusive end (next Monday 00:00 local) of an ISO week. */
export function isoWeekBounds(key: string, tz = "UTC"): { start: Date; end: Date } | null {
  const p = parseIsoWeek(key);
  if (!p) return null;
  const monday = week1Monday(p.year) + (p.week - 1) * 7 * DAY;
  return { start: fromWall(new Date(monday), tz), end: fromWall(new Date(monday + 7 * DAY), tz) };
}

/** The key `delta` weeks before (negative) or after (positive) `key`. */
export function shiftIsoWeek(key: string, delta: number): string | null {
  const p = parseIsoWeek(key);
  if (!p) return null;
  const monday = week1Monday(p.year) + (p.week - 1 + delta) * 7 * DAY;
  return isoWeekKey(new Date(monday + 3 * DAY), "UTC");
}

/** Short human label: "Week 40 · 28 Sep – 4 Oct". */
export function isoWeekLabel(key: string): string {
  const p = parseIsoWeek(key);
  if (!p) return key;
  const monday = week1Monday(p.year) + (p.week - 1) * 7 * DAY;
  const fmt = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `Week ${p.week} · ${fmt(monday)} – ${fmt(monday + 6 * DAY)}`;
}
