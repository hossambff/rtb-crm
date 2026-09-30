/** Roundtable 100 program math (PRD R100-1..7). Pure, unit tested. */

export type R100Json = {
  firstPostDate?: string | null;
  participation?: boolean[];
  postCount?: number;
  profileUrl?: string | null;
  editorialLinks?: string[];
  bonusEligible?: boolean;
  bonusCents?: number;
};

export const INTERVIEW_STATUSES = ["scheduled", "filmed", "rescheduling", "published"] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];
export type Interview = {
  id: string;
  guest: string;
  host: string;
  status: InterviewStatus;
  filmedAt: string | null;
  publishAt: string | null;
  link: string | null;
};

/** Stages that count as "live" for the goal tracker. */
export const LIVE_STAGE_KEYS = ["profile_activated", "first_post"];

export function isLive(stage: { key: string; category: string }): boolean {
  return stage.category === "won" || LIVE_STAGE_KEYS.includes(stage.key);
}

/** Parse interviews from deals.customFields.interviews (untrusted JSON). */
export function parseInterviews(customFields: Record<string, unknown> | null | undefined): Interview[] {
  const raw = customFields?.interviews;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === "object")
    .map((r, i) => ({
      id: typeof r.id === "string" ? r.id : `iv-${i}`,
      guest: String(r.guest ?? ""),
      host: String(r.host ?? ""),
      status: (INTERVIEW_STATUSES as readonly string[]).includes(r.status) ? r.status : "scheduled",
      filmedAt: typeof r.filmedAt === "string" && r.filmedAt ? r.filmedAt : null,
      publishAt: typeof r.publishAt === "string" && r.publishAt ? r.publishAt : null,
      link: typeof r.link === "string" && r.link ? r.link : null,
    }));
}

/** Most relevant interview status for the table: published > filmed > rescheduling > scheduled. */
export function interviewSummary(list: Interview[]): InterviewStatus | null {
  if (!list.length) return null;
  for (const s of ["published", "filmed", "rescheduling", "scheduled"] as const) if (list.some((i) => i.status === s)) return s;
  return null;
}

/** Filmed, not published, with no publish date (or TBD) for more than `days` (R100-4 / NS-22). */
export function interviewOverdue(iv: Interview, now: Date, days = 14): boolean {
  if (iv.status !== "filmed" || !iv.filmedAt) return false;
  if (iv.publishAt && new Date(iv.publishAt).getTime() >= now.getTime()) return false;
  return (now.getTime() - new Date(iv.filmedAt).getTime()) / 86_400_000 > days;
}

/** 0-based participation month since the first post (month 1 = index 0). null before the first post. */
export function participationMonthIndex(firstPostDate: string | null | undefined, now: Date): number | null {
  if (!firstPostDate) return null;
  const d = new Date(firstPostDate);
  if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime()) return null;
  return (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + (now.getUTCMonth() - d.getUTCMonth());
}

export type ParticipationNow = "not_live" | "posted" | "missing" | "beyond";

/** Participation this month for the indicator column. */
export function participationNow(r100: R100Json, now: Date): ParticipationNow {
  const idx = participationMonthIndex(r100.firstPostDate, now);
  if (idx == null) return "not_live";
  if (idx > 2) return "beyond";
  return r100.participation?.[idx] ? "posted" : "missing";
}

/** Burn-up: cumulative live accounts by first-post month (fallback wonAt). */
export function burnUp(items: { firstPostDate: string | null | undefined; wonAt: Date | null }[], now: Date, monthsBack = 12) {
  const dates = items
    .map((i) => (i.firstPostDate ? new Date(i.firstPostDate) : i.wonAt))
    .filter((d): d is Date => d != null && !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  const endY = now.getUTCFullYear();
  const endM = now.getUTCMonth();
  let startY = endY;
  let startM = endM - (monthsBack - 1);
  if (dates.length) {
    const first = dates[0]!;
    const fy = first.getUTCFullYear();
    const fm = first.getUTCMonth();
    if (fy * 12 + fm > startY * 12 + startM) {
      startY = fy;
      startM = fm;
    }
  }
  const points: { month: string; label: string; live: number }[] = [];
  let cursor = startY * 12 + startM;
  const end = endY * 12 + endM;
  if (end - cursor < 2) cursor = end - 2; // always draw at least 3 points
  for (; cursor <= end; cursor++) {
    const y = Math.floor(cursor / 12);
    const m = ((cursor % 12) + 12) % 12;
    const monthEnd = Date.UTC(y, m + 1, 1);
    const live = dates.filter((d) => d.getTime() < monthEnd).length;
    points.push({
      month: `${y}-${String(m + 1).padStart(2, "0")}`,
      label: new Date(Date.UTC(y, m, 1)).toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }),
      live,
    });
  }
  return points;
}

/** Normalize the r100 JSON patch coming from the table editor. */
export function mergeR100(current: R100Json, patch: Partial<R100Json>): R100Json {
  const next: R100Json = { ...current, ...patch };
  if (patch.participation) next.participation = [0, 1, 2].map((i) => Boolean(patch.participation![i]));
  if (next.postCount != null) next.postCount = Math.max(0, Math.round(next.postCount));
  if (next.bonusCents != null) next.bonusCents = Math.max(0, Math.round(next.bonusCents));
  return next;
}
