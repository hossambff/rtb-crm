/** Pure task helpers shared by server + client (unit tested). */
import { dayBounds } from "@/lib/alerts/time";

export type Bucket = "overdue" | "today" | "upcoming" | "no_date";
export const BUCKET_LABELS: Record<Bucket, string> = { overdue: "Overdue", today: "Today", upcoming: "Upcoming", no_date: "No date" };
export const BUCKET_ORDER: Bucket[] = ["overdue", "today", "upcoming", "no_date"];

export const PRIORITIES = ["top10", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { top10: "Top 10", high: "High", medium: "Medium", low: "Low" };
const PRIORITY_RANK: Record<string, number> = { top10: 0, high: 1, medium: 2, low: 3 };

export const ORIGIN_LABELS: Record<string, string> = {
  manual: "Manual",
  email_ai: "From email",
  call_ai: "From call",
  rule: "Nothing Slips",
  sequence: "Sequence",
  agent: "Copilot",
  import: "Import",
};

/** Bucket an open task by due date relative to the user's local day. Snoozed tasks bucket by their snooze date. */
export function bucketFor(t: { dueAt: Date | string | null; snoozedUntil?: Date | string | null }, now: Date, tz: string): Bucket {
  const due = t.dueAt ? new Date(t.dueAt) : null;
  const snooze = t.snoozedUntil ? new Date(t.snoozedUntil) : null;
  const eff = snooze && snooze > now && (!due || snooze > due) ? snooze : due;
  if (!eff) return "no_date";
  const { end } = dayBounds(now, tz);
  if (eff < now) return "overdue";
  if (eff < end) return "today";
  return "upcoming";
}

export function bucketTasks<T extends { dueAt: Date | string | null; snoozedUntil?: Date | string | null; priority?: string | null }>(
  tasks: T[],
  now: Date,
  tz: string,
): Record<Bucket, T[]> {
  const out: Record<Bucket, T[]> = { overdue: [], today: [], upcoming: [], no_date: [] };
  for (const t of tasks) out[bucketFor(t, now, tz)].push(t);
  const byDue = (a: T, b: T) => {
    const da = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
    const dbb = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
    return da - dbb || (PRIORITY_RANK[a.priority ?? "medium"] ?? 2) - (PRIORITY_RANK[b.priority ?? "medium"] ?? 2);
  };
  for (const k of BUCKET_ORDER) out[k].sort(byDue);
  return out;
}

/** Format an instant in a timezone (server-safe; avoids server/browser TZ drift). */
export function fmtInTz(d: Date | string | null | undefined, tz: string, style: "date" | "datetime" | "time" = "datetime"): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  const opts: Intl.DateTimeFormatOptions =
    style === "date"
      ? { day: "numeric", month: "short", year: "numeric" }
      : style === "time"
        ? { hour: "numeric", minute: "2-digit" }
        : { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", opts).format(date);
  }
}

/** Snooze presets → instants (local 9:00 in tz). */
export function snoozePreset(preset: "tomorrow" | "in3days" | "nextweek", now: Date, tz: string): Date {
  const { start } = dayBounds(now, tz);
  const days = preset === "tomorrow" ? 1 : preset === "in3days" ? 3 : ((8 - toDow(now, tz)) % 7 || 7);
  const target = dayBounds(new Date(start.getTime() + days * 86_400_000 + 3_600_000 * 12), tz).start;
  return new Date(target.getTime() + 9 * 3_600_000);
}

function toDow(d: Date, tz: string): number {
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}
