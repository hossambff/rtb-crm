/** Pure Today-queue logic (docs/V2_SPEC.md §B1): ranking, snooze presets, snooze filtering. Unit tested; client-safe. */
import { snoozePreset } from "@/lib/tasks/core";
import type { QueueItem, QueueKind, SnoozePreset } from "./types";

const HOUR = 3_600_000;

/** Small nudges per kind so equally-urgent items keep a sensible order (people waiting on you before paperwork). */
export const KIND_WEIGHT: Record<QueueKind, number> = {
  meeting: 10,
  approval: 6,
  handoff: 6,
  help: 6,
  reply: 4,
  signal: 3,
  sequence: 2,
  task: 0,
  alert: 0,
  deal: 0,
  forecast: 0,
  story: -5,
  setup: -10,
};

export const SEVERITY_WEIGHT: Record<NonNullable<QueueItem["severity"]>, number> = { critical: 40, serious: 25, warning: 10, info: 0 };

/** Urgency score of one item at `now` (higher = earlier in the list). */
export function queueScore(item: QueueItem, now: Date): number {
  let score = Math.max(0, Math.min(100, Number.isFinite(item.urgency) ? item.urgency : 0));
  if (item.severity) score += SEVERITY_WEIGHT[item.severity] ?? 0;
  score += KIND_WEIGHT[item.kind] ?? 0;
  const due = item.dueAt ? new Date(item.dueAt).getTime() : NaN;
  if (Number.isFinite(due)) {
    const delta = due - now.getTime();
    if (delta < 0) score += 20 + Math.min(20, -delta / (6 * HOUR)); // overdue: +20, growing to +40 after 5 days
    else if (delta <= 2 * HOUR) score += 15; // due within 2 hours
    else if (delta <= 12 * HOUR) score += 8; // due later today-ish
  }
  return score;
}

/**
 * Rank queue items: score desc, then earliest due first (undated last), then the original order (stable).
 * Duplicate keys keep the first occurrence (providers may overlap, e.g. a task that is also an alert target).
 */
export function rankQueue(items: QueueItem[], now: Date): QueueItem[] {
  const seen = new Set<string>();
  const unique = items.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
  return unique
    .map((item, idx) => ({ item, idx, score: queueScore(item, now), due: item.dueAt ? new Date(item.dueAt).getTime() : Infinity }))
    .sort((a, b) => b.score - a.score || (Number.isNaN(a.due) ? Infinity : a.due) - (Number.isNaN(b.due) ? Infinity : b.due) || a.idx - b.idx)
    .map((x) => x.item);
}

/** When a snooze preset ends: 1 h from now, tomorrow 9:00 or next Monday 9:00 in the user's time zone. */
export function snoozeUntil(preset: SnoozePreset, now: Date, tz: string): Date {
  if (preset === "1h") return new Date(now.getTime() + HOUR);
  return snoozePreset(preset === "tomorrow" ? "tomorrow" : "nextweek", now, tz);
}

export const SNOOZE_LABELS: Record<SnoozePreset, string> = { "1h": "For 1 hour", tomorrow: "Tomorrow 9 am", monday: "Next Monday 9 am" };

/** Drop items the user snoozed (until in the future) or dismissed (until = null). */
export function applySnoozes<T extends { key: string }>(items: T[], snoozes: { itemKey: string; until: Date | string | null }[], now: Date): T[] {
  const hidden = new Set(snoozes.filter((s) => s.until == null || new Date(s.until).getTime() > now.getTime()).map((s) => s.itemKey));
  return items.filter((i) => !hidden.has(i.key));
}

/** Parse "<kind>:<id>" (ids may contain ":"). */
export function parseQueueKey(key: string): { kind: string; id: string } | null {
  const i = key.indexOf(":");
  if (i <= 0 || i === key.length - 1) return null;
  return { kind: key.slice(0, i), id: key.slice(i + 1) };
}

/* ───────────── Copilot front door: suggested questions (B7) ───────────── */

export type SuggestionSignals = {
  noNextStep: number;
  overdueTasks: number;
  dueToday: number;
  openAlerts: number;
  awaitingReply: number;
  meetingsToday: number;
  isLeader: boolean;
};

/**
 * Up to 3 questions grounded in the user's own data, rotated daily (`daySeed` = e.g. day-of-year) so the bar stays
 * fresh without being random on every render. Data-backed prompts come first; generic ones fill the gaps.
 */
export function suggestQuestions(sig: SuggestionSignals, daySeed: number, max = 3): string[] {
  const grounded: string[] = [];
  if (sig.noNextStep) grounded.push("Which of my deals have no next step?");
  if (sig.overdueTasks || sig.dueToday) grounded.push("What do I owe people today?");
  if (sig.meetingsToday) grounded.push("Prep me for my next meeting");
  if (sig.awaitingReply) grounded.push("Which emails should I answer first?");
  if (sig.openAlerts) grounded.push("What's at risk in my pipeline this week?");
  if (sig.isLeader) grounded.push("Which deals on my team slipped this week?");
  const generic = [
    "Summarize my pipeline by stage",
    "Which deals are closest to closing?",
    "Who haven't I talked to in two weeks?",
    "Draft a follow-up for my most recent call",
  ];
  const rot = <T,>(a: T[]) => (a.length ? a.map((_, i) => a[(i + Math.abs(daySeed)) % a.length]!) : a);
  const out: string[] = [];
  for (const q of [...rot(grounded), ...rot(generic)]) if (!out.includes(q) && out.length < max) out.push(q);
  return out;
}

/* ───────────── Hygiene: soft-deleted records, reply keys, grouping (QA MAJ-21 / MIN-41, CR M6) ───────────── */

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DEAL_HREF = new RegExp(`^/deals/(${UUID_RE})(?:[/?#]|$)`, "i");
const ACCOUNT_HREF = new RegExp(`^/accounts/(${UUID_RE})(?:[/?#]|$)`, "i");

/** The deal / account a row is about: explicit ids first, else its `/deals/<id>` / `/accounts/<id>` link. */
export function itemSubjects(item: Pick<QueueItem, "href" | "dealId" | "accountId">): { dealId: string | null; accountId: string | null } {
  return {
    dealId: item.dealId ?? DEAL_HREF.exec(item.href ?? "")?.[1]?.toLowerCase() ?? null,
    accountId: item.accountId ?? ACCOUNT_HREF.exec(item.href ?? "")?.[1]?.toLowerCase() ?? null,
  };
}

/** Drop rows about soft-deleted deals or accounts (any source: tasks, alerts, providers). */
export function dropDeleted<T extends Pick<QueueItem, "href" | "dealId" | "accountId">>(items: T[], deleted: { deals: Set<string>; accounts: Set<string> }): T[] {
  if (!deleted.deals.size && !deleted.accounts.size) return items;
  return items.filter((i) => {
    const { dealId, accountId } = itemSubjects(i);
    return !(dealId && deleted.deals.has(dealId.toLowerCase())) && !(accountId && deleted.accounts.has(accountId.toLowerCase()));
  });
}

/**
 * Queue key for an "awaiting our reply" thread, versioned by its latest message: "Done" (or a snooze) hides this
 * version only — a new inbound message produces a new key, so the thread comes back (code review M6).
 */
export function replyKey(threadId: string, lastMessageAt: Date | string | null | undefined): string {
  const t = lastMessageAt ? new Date(lastMessageAt).getTime() : NaN;
  return Number.isFinite(t) ? `thread:${threadId}#${t}` : `thread:${threadId}`;
}

/** Thread id of a reply-row key (with or without the message version). */
export function threadIdOfKey(key: string): string | null {
  const k = parseQueueKey(key);
  return k?.kind === "thread" ? (k.id.split("#")[0] ?? null) : null;
}

export type GroupSpec = {
  /** Title for N rows, e.g. n => `${n} unassigned high-value leads`. */
  title: (n: number) => string;
  /** Where the pre-filtered list lives. */
  href: string;
  /** Primary button label. */
  cta?: string;
};

export const GROUP_MIN = 3;

/**
 * Collapse ≥ GROUP_MIN rows that share `group` into one row ("9 unassigned high-value leads → Assign owners"), keeping
 * the most severe / urgent values. Order of first appearance is kept; singletons and small groups pass through.
 */
export function collapseGroups(items: QueueItem[], specFor: (group: string, sample: QueueItem) => GroupSpec, min = GROUP_MIN): QueueItem[] {
  const byGroup = new Map<string, QueueItem[]>();
  for (const i of items) if (i.group) byGroup.set(i.group, [...(byGroup.get(i.group) ?? []), i]);
  const out: QueueItem[] = [];
  const emitted = new Set<string>();
  for (const i of items) {
    const members = i.group ? byGroup.get(i.group)! : null;
    if (!members || members.length < min) {
      out.push(i);
      continue;
    }
    if (emitted.has(i.group!)) continue;
    emitted.add(i.group!);
    const spec = specFor(i.group!, i);
    const sev = members.map((m) => m.severity).filter(Boolean) as NonNullable<QueueItem["severity"]>[];
    const severity = sev.sort((a, b) => SEVERITY_WEIGHT[b] - SEVERITY_WEIGHT[a])[0] ?? null;
    const names = members.map((m) => (m.title.includes(": ") ? m.title.slice(m.title.indexOf(": ") + 2) : m.title).trim()).filter(Boolean);
    const shownNames = names.slice(0, 3).join(", ");
    out.push({
      key: `group:${i.group}`,
      kind: i.kind,
      title: spec.title(members.length),
      detail: names.length > 3 ? `${shownNames} +${names.length - 3} more` : shownNames,
      context: i.context ?? null,
      href: spec.href,
      dueAt: members.map((m) => m.dueAt).filter(Boolean).sort()[0] ?? null,
      urgency: Math.min(100, Math.max(...members.map((m) => m.urgency)) + 5),
      severity,
      actions: [{ kind: "link", label: spec.cta ?? "Open list", href: spec.href }, { kind: "snooze" }],
      group: null,
    });
  }
  return out;
}

/** Approval row copy: a bulk request is ONE decision covering many deals — say so (QA MAJ-21). */
export function approvalCopy(label: string, kind: string, requesterName: string | null): { title: string; detail: string } {
  const what = kind.replace(/_/g, " ");
  const from = requesterName ? ` · from ${requesterName}` : "";
  const bulk = /^(\d+) deals \(bulk\)$/.exec(label.trim());
  if (bulk) return { title: `Approve one bulk ${what} (${bulk[1]} deals)`, detail: `One decision covers all ${bulk[1]} deals${from}` };
  return { title: `Approve: ${label}`, detail: `${what}${from}` };
}

/** Does a meeting have anyone outside our own domains? (No brief / "Prep" for internal-only meetings — QA MIN-24.) */
export function hasExternalAttendee(attendees: readonly string[], internalDomains: readonly string[]): boolean {
  const internal = new Set(internalDomains.map((d) => d.toLowerCase()));
  return attendees.some((a) => {
    const at = a.lastIndexOf("@");
    if (at < 0) return false;
    const domain = a.slice(at + 1).trim().toLowerCase();
    return Boolean(domain) && ![...internal].some((d) => domain === d || domain.endsWith(`.${d}`));
  });
}

/** Dismissals older than this are pruned (code review L11). */
export const DISMISSAL_TTL_DAYS = 90;
