/**
 * Pure due-date extraction for commitments found in emails and transcripts (unit-tested).
 *
 * Returns the first date expression found in `text`, resolved against `ref` (the message/call time).
 * Dates are resolved in UTC calendar days and pinned to 17:00 UTC ("end of business") unless a time is implied
 * ("today", "tonight"). Vague expressions ("soon", "after the board meeting") return null — never guess.
 */

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const WEEKDAY_ABBR: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, couple: 2, few: 3 };

export type DueMatch = { date: Date; phrase: string };

function atEod(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 17, 0, 0));
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
/** Next occurrence of weekday (0=Sun) strictly after ref's day (or the same week if `allowToday`). */
function nextWeekday(ref: Date, wd: number, allowToday = false): Date {
  const cur = ref.getUTCDay();
  let diff = (wd - cur + 7) % 7;
  if (diff === 0 && !allowToday) diff = 7;
  return addDays(ref, diff);
}
function monthIndex(token: string): number {
  const t = token.toLowerCase().replace(/\.$/, "");
  return MONTHS.findIndex((m) => m === t || (t.length >= 3 && m.startsWith(t)));
}
/** Resolve month/day to the next occurrence on/after ref (dates up to 7 days in the past are kept in the current year). */
function resolveMonthDay(ref: Date, month: number, day: number, year?: number): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  let y = year ?? ref.getUTCFullYear();
  if (year != null && year < 100) y = 2000 + year;
  let d = new Date(Date.UTC(y, month, day, 17));
  if (d.getUTCMonth() !== month) return null; // e.g. Feb 31
  if (year == null && d.getTime() < ref.getTime() - 7 * 86_400_000) d = new Date(Date.UTC(y + 1, month, day, 17));
  return d;
}

type Rule = { re: RegExp; resolve: (m: RegExpMatchArray, ref: Date) => Date | null };

const RULES: Rule[] = [
  // ISO date
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/, resolve: (m) => resolveMonthDayStrict(Number(m[1]), Number(m[2]) - 1, Number(m[3])) },
  // end of day / today / tonight / COB
  { re: /\b(today|tonight|end of (?:the )?day|eod|cob|close of business)\b/i, resolve: (_m, ref) => atEod(ref) },
  { re: /\b(tomorrow|tmrw)\b/i, resolve: (_m, ref) => atEod(addDays(ref, 1)) },
  // end of week / EOW
  { re: /\b(end of (?:the |this )?week|eow)\b/i, resolve: (_m, ref) => atEod(nextWeekday(ref, 5, true)) },
  // end of month / EOM
  {
    re: /\b(end of (?:the |this )?month|eom)\b/i,
    resolve: (_m, ref) => new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0, 17)),
  },
  // next week → Monday of next week
  { re: /\bnext week\b/i, resolve: (_m, ref) => atEod(nextWeekday(ref, 1)) },
  // "next month" → first business-ish day next month
  { re: /\bnext month\b/i, resolve: (_m, ref) => new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1, 17)) },
  // in N days/weeks
  {
    re: /\bin (?:the next )?(\d+|a|an|one|two|three|four|five|six|seven|ten|a couple of|a few|couple of|few) (business days?|days?|weeks?)\b/i,
    resolve: (m, ref) => {
      const raw = m[1]!.toLowerCase().replace(/^a (couple|few) of$/, "$1").replace(/ of$/, "");
      const n = /^\d+$/.test(raw) ? Number(raw) : (NUMBER_WORDS[raw] ?? NaN);
      if (!Number.isFinite(n) || n <= 0 || n > 365) return null;
      const unit = m[2]!.toLowerCase();
      if (unit.startsWith("week")) return atEod(addDays(ref, n * 7));
      if (unit.startsWith("business")) return atEod(addBusinessDays(ref, n));
      return atEod(addDays(ref, n));
    },
  },
  // next Tuesday / this Friday / by Friday / on Monday / Friday
  { re: /\b(?:(next|this|by|on|before|until|coming)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i, resolve: (m, ref) => resolveWeekday(m[1], m[2]!, ref) },
  // abbreviations only with a modifier ("by Fri", "on Tues") to avoid "we sat down"
  { re: /\b(next|this|by|on|before|until)\s+(mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\b\.?/i, resolve: (m, ref) => resolveWeekday(m[1], m[2]!, ref) },
  // 5 October / 5th of Oct
  {
    re: /\b(\d{1,2})(?:st|nd|rd|th)?(?: of)? (jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:,? (\d{4}))?/i,
    resolve: (m, ref) => resolveMonthDay(ref, monthIndex(m[2]!), Number(m[1]), m[3] ? Number(m[3]) : undefined),
  },
  // October 5 / Oct. 5th, 2026
  {
    re: /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.? (\d{1,2})(?:st|nd|rd|th)?\b(?:,? (\d{4}))?/i,
    resolve: (m, ref) => resolveMonthDay(ref, monthIndex(m[1]!), Number(m[2]), m[3] ? Number(m[3]) : undefined),
  },
  // 10/5 or 10/5/2026 (US month/day)
  {
    re: /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/,
    resolve: (m, ref) => resolveMonthDay(ref, Number(m[1]) - 1, Number(m[2]), m[3] ? Number(m[3]) : undefined),
  },
];

function resolveWeekday(modifier: string | undefined, word: string, ref: Date): Date | null {
  const w = word.toLowerCase();
  const full = WEEKDAYS.indexOf(w as (typeof WEEKDAYS)[number]);
  const wd = full >= 0 ? full : WEEKDAY_ABBR[w];
  if (wd == null) return null;
  const mod = (modifier ?? "").toLowerCase();
  let d = nextWeekday(ref, wd, mod === "this");
  // "next Friday" said earlier in the same week means the Friday of the following week.
  if (mod === "next" && ref.getUTCDay() !== 0 && wd > ref.getUTCDay()) d = addDays(d, 7);
  return atEod(d);
}

function resolveMonthDayStrict(y: number, month: number, day: number): Date | null {
  const d = new Date(Date.UTC(y, month, day, 17));
  return d.getUTCMonth() === month && d.getUTCDate() === day ? d : null;
}

export function addBusinessDays(ref: Date, n: number): Date {
  let d = new Date(ref.getTime());
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

/** Find the earliest-positioned date expression in text. */
export function parseDue(text: string | null | undefined, ref: Date): DueMatch | null {
  if (!text) return null;
  let best: { index: number; match: DueMatch } | null = null;
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (!m || m.index == null) continue;
    // avoid treating "may" (verb) as a month: require a digit adjacent, which the rules already do.
    const date = rule.resolve(m, ref);
    if (!date || Number.isNaN(date.getTime())) continue;
    if (!best || m.index < best.index) best = { index: m.index, match: { date, phrase: m[0].trim() } };
  }
  return best?.match ?? null;
}

/** Parse an ISO-ish string from AI output; returns null for invalid/absurd dates. */
export function parseIsoDue(value: string | null | undefined, ref: Date): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return parseDue(value, ref)?.date ?? null;
  const yearsOff = Math.abs(d.getTime() - ref.getTime()) / (365 * 86_400_000);
  return yearsOff > 3 ? null : d;
}
