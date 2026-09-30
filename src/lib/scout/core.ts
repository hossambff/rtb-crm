/** Small pure helpers for Lead Scout (dates, CRM status, seniority, title matching). Unit tested. */

/** Add N business days (Mon–Fri) to a date. */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

export const REJECT_SUPPRESS_MONTHS = 6;
export const SNOOZE_DAYS = 30;

export function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

export type CrmStatus =
  | { kind: "new" }
  | { kind: "in_crm"; accountId: string }
  | { kind: "open_deal"; accountId: string; dealId: string; ownerName: string | null; stage: string; pipelineKey: string }
  | { kind: "lost"; accountId: string; dealId: string; lostAt: string | null; lostReason: string | null };

export type CrmMatch = {
  status?: CrmStatus["kind"];
  accountId?: string;
  dealId?: string;
  ownerId?: string;
  ownerName?: string | null;
  stage?: string;
  pipelineKey?: string;
  lostAt?: string | null;
  lostReason?: string | null;
  accountOwnerId?: string | null;
};

export function monthsAgo(iso: string | null | undefined, now = new Date()): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + (now.getUTCMonth() - d.getUTCMonth()));
}

/** "New" / "In CRM, no deal" / "Open deal: owner, stage" / "Lost 6 months ago: reason" (SCOUT-12). */
export function crmStatusLabel(m: CrmMatch | null | undefined, now = new Date()): string {
  if (!m || !m.status || m.status === "new") return "New";
  if (m.status === "open_deal") return `Open deal: ${m.ownerName ?? "unassigned"}, ${m.stage ?? "—"}`;
  if (m.status === "lost") {
    const n = monthsAgo(m.lostAt, now);
    const when = n == null ? "Lost" : n === 0 ? "Lost this month" : `Lost ${n} month${n === 1 ? "" : "s"} ago`;
    return m.lostReason ? `${when}: ${m.lostReason}` : when;
  }
  return "In CRM, no deal";
}

const SENIOR = /\b(ceo|cfo|cto|coo|cro|cmo|cpo|cdo|chief|founder|co-?founder|owner|publisher|president|editor[- ]in[- ]chief|managing director|general manager|gm|head of|vp|vice president|director|partner|principal)\b/i;
export function isSeniorTitle(title: string | null | undefined): boolean {
  return Boolean(title && SENIOR.test(title));
}

export function seniorityOf(title: string | null | undefined): string | null {
  if (!title) return null;
  if (/\b(ceo|cfo|cto|coo|cro|cmo|cpo|cdo|chief|founder|owner|president|publisher)\b/i.test(title)) return "c_level";
  if (/\b(vp|vice president|head of|director|editor[- ]in[- ]chief|gm|general manager)\b/i.test(title)) return "vp_director";
  if (/\bmanager|lead|editor\b/i.test(title)) return "manager";
  return "ic";
}

/** Does a title match any target role? Tokenized, abbreviation-aware ("Chief Executive Officer" ~ "CEO"). */
export function titleMatchesRoles(title: string | null | undefined, roles: string[]): boolean {
  if (!title) return false;
  if (!roles.length) return true;
  const t = expandTitle(title);
  return roles.some((r) => {
    const rr = expandTitle(r);
    return t.includes(rr) || rr.split(" ").filter((w) => w.length > 2).every((w) => t.includes(w));
  });
}

const ABBR: Record<string, string> = {
  ceo: "chief executive officer",
  cfo: "chief financial officer",
  cto: "chief technology officer",
  cro: "chief revenue officer",
  cmo: "chief marketing officer",
  cpo: "chief product officer",
  cdo: "chief digital officer",
  coo: "chief operating officer",
  gm: "general manager",
  eic: "editor in chief",
  pr: "public relations",
  ir: "investor relations",
};
function expandTitle(s: string): string {
  return ` ${s
    .toLowerCase()
    .replace(/[-/&,.]/g, " ")
    .split(/\s+/)
    .map((w) => ABBR[w] ?? w)
    .join(" ")} `.replace(/\s+/g, " ");
}

/** Name ↔ email heuristic used to attach website emails to people (first.last@, flast@, first@). */
export function emailMatchesName(email: string, fullName: string): boolean {
  const local = email.split("@")[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  const parts = fullName.toLowerCase().normalize("NFKD").replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
  if (parts.length < 1 || !local) return false;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  return [first + last, first[0] + last, first, last + first, first + last[0]].some((p) => p.length >= 3 && local === p);
}

export function splitName(full: string): { firstName: string | null; lastName: string | null } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] ?? null, lastName: null };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

export function isGenericEmail(email: string): boolean {
  return /^(info|contact|hello|press|news|newsroom|editor|editors|editorial|tips|ads|advertising|partnerships|partner|sales|support|admin|office|media|marketing|team|jobs|careers|privacy|legal|webmaster)@/i.test(email);
}
