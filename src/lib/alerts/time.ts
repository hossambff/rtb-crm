/**
 * Timezone + business-time helpers (pure, no deps). "Roughly" correct across DST: the offset is sampled at the
 * instant being converted, which is exact except inside the skipped/repeated DST hour.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      f = formatter("UTC");
    }
    fmtCache.set(tz, f);
  }
  return f;
}

/** Offset (ms) of `tz` from UTC at instant `d` (e.g. New York in summer → -4h). */
export function tzOffsetMs(d: Date, tz: string): number {
  const parts = formatter(tz).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** A Date whose UTC fields equal the wall-clock time in `tz` (use only with getUTC* accessors). */
export function toWall(d: Date, tz: string): Date {
  return new Date(d.getTime() + tzOffsetMs(d, tz));
}

/** Convert a wall-clock (UTC-field) date in `tz` back to a real instant. */
export function fromWall(wall: Date, tz: string): Date {
  const guess = new Date(wall.getTime() - tzOffsetMs(wall, tz));
  return new Date(wall.getTime() - tzOffsetMs(guess, tz));
}

export function isWeekendWall(wall: Date): boolean {
  const dow = wall.getUTCDay();
  return dow === 0 || dow === 6;
}

export function isBusinessDay(d: Date, tz: string): boolean {
  return !isWeekendWall(toWall(d, tz));
}

/** Start/end (exclusive) instants of the local calendar day containing `d` in `tz`. */
export function dayBounds(d: Date, tz: string): { start: Date; end: Date } {
  const wall = toWall(d, tz);
  const midnight = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()));
  return { start: fromWall(midnight, tz), end: fromWall(new Date(midnight.getTime() + DAY), tz) };
}

/** Local YYYY-MM-DD for `d` in `tz`. */
export function localDateKey(d: Date, tz: string): string {
  return toWall(d, tz).toISOString().slice(0, 10);
}

/**
 * Number of business days elapsed between two instants in `tz`: counts weekday midnights crossed after `from`
 * up to `to`. Mon 10:00 → Tue 09:00 = 1; Fri 17:00 → Mon 09:00 = 1; same day = 0.
 */
export function businessDaysBetween(from: Date, to: Date, tz: string): number {
  if (to <= from) return 0;
  const a = toWall(from, tz);
  const b = toWall(to, tz);
  let day = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()) + DAY;
  const last = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  let n = 0;
  // cap iterations (~3 years) — beyond that the answer is "a lot" anyway
  for (let i = 0; day <= last && i < 1100; i++, day += DAY) {
    const dow = new Date(day).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/**
 * Working hours elapsed between two instants, counting only weekday hours inside [startHour, endHour) local time.
 */
export function businessHoursBetween(from: Date, to: Date, tz: string, startHour = 9, endHour = 18): number {
  if (to <= from) return 0;
  const s = Math.max(0, Math.min(23, startHour));
  const e = Math.max(s + 1, Math.min(24, endHour));
  const a = toWall(from, tz).getTime();
  const b = toWall(to, tz).getTime();
  let dayStart = Math.floor(a / DAY) * DAY;
  let ms = 0;
  for (let i = 0; dayStart < b && i < 1100; i++, dayStart += DAY) {
    const dow = new Date(dayStart).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const winStart = Math.max(a, dayStart + s * HOUR);
    const winEnd = Math.min(b, dayStart + e * HOUR);
    if (winEnd > winStart) ms += winEnd - winStart;
  }
  return ms / HOUR;
}

/** Whole calendar days between two instants (floor). */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY);
}

/** Add n business days (in tz) to an instant, keeping the wall-clock time. */
export function addBusinessDays(d: Date, n: number, tz: string): Date {
  let wall = toWall(d, tz);
  let added = 0;
  while (added < n) {
    wall = new Date(wall.getTime() + DAY);
    if (!isWeekendWall(wall)) added++;
  }
  return fromWall(wall, tz);
}

/**
 * Have `n` business days passed since `from` (in tz), keeping the wall-clock time? (M-09) — "created Mon 23:30,
 * 1 business day" is due Tue 23:30, not at Tue 00:00 like counting midnights would say. n ≤ 0 → true.
 */
export function businessDaysPassed(from: Date, to: Date, n: number, tz: string): boolean {
  if (n <= 0) return to >= from;
  return addBusinessDays(from, n, tz).getTime() <= to.getTime();
}

/** Days left in the local calendar month of `d` (the last day of the month → 0). */
export function daysLeftInMonth(d: Date, tz: string): number {
  const w = toWall(d, tz);
  const lastDay = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth() + 1, 0)).getUTCDate();
  return lastDay - w.getUTCDate();
}

/** Whole months between a start date and `d` (0 during the first month). */
export function monthIndexSince(start: Date, d: Date): number {
  const m = (d.getUTCFullYear() - start.getUTCFullYear()) * 12 + (d.getUTCMonth() - start.getUTCMonth());
  return d.getUTCDate() < start.getUTCDate() ? m - 1 : m;
}
