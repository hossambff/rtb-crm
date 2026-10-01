import "server-only";
import { briefHref } from "@/lib/briefs/meeting-core";
import { and, asc, count, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { can, dealAccessWhere, type AppUser } from "@/lib/rbac/server";
import type { Module } from "@/lib/rbac/model";
import { internalDomains } from "@/lib/integrations/directory";
import { dayBounds } from "@/lib/alerts/time";
import { SEVERITY_RANK } from "@/lib/alerts/rules";
import { alertCountsBySeverity, listMyAlerts, type AlertView } from "@/lib/alerts/queries";
import { listApprovals } from "@/lib/approvals/service";
import { assignableUsers, listMyTasks, type TaskView, type UserOption } from "@/lib/tasks/queries";
import { bucketTasks, fmtInTz } from "@/lib/tasks/core";
import * as handoffs from "./providers/handoffs";
import * as help from "./providers/help";
import * as signals from "./providers/signals";
import * as forecast from "./providers/forecast";
import * as sequences from "./providers/sequences";
import * as stories from "./providers/stories";
import { applySnoozes, approvalCopy, collapseGroups, dropDeleted, hasExternalAttendee, itemSubjects, rankQueue, replyKey, type GroupSpec, type SuggestionSignals } from "./core";
import type { QueueItem, QueueProvider } from "./types";

/** Team-owned providers (docs/V2_SPEC.md §1). Keyed by file name — also the prefix of their server actionIds. */
export const PROVIDERS: Record<string, { load: QueueProvider }> = { handoffs, help, signals, forecast, sequences, stories };

/** Per-provider budget: a slow team provider is skipped (logged) rather than holding My Day (QA MAJ-05). */
const PROVIDER_TIMEOUT_MS = 1_200;
/** Modules whose `approve` permission makes someone an approver (QA MIN-01: from the matrix, not a role list). */
const APPROVE_MODULES: Module[] = ["deals_NET", "deals_ENT", "deals_SPT", "deals_R100", "deals_ADS", "deals_PAY", "proposals", "commissions", "revenue"];
const LEADER_ROLES = ["executive", "admin", "super_admin", "sales_leader"];
const PRIORITY_URGENCY: Record<string, number> = { top10: 50, high: 40, medium: 30, low: 20 };

/** Never let one source break or stall My Day. */
async function safe<T>(label: string, p: () => Promise<T>, fallback: T, timeoutMs?: number): Promise<T> {
  try {
    const work = p();
    if (!timeoutMs) return await work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[queue] ${label} timed out`);
        resolve(fallback);
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.error(`[queue] ${label} failed`, (e as Error).message?.split("\nparams:")[0]?.slice(0, 160));
    return fallback;
  }
}

function taskItem(t: TaskView, canDelegate: boolean): QueueItem {
  const context = t.dealName ?? t.accountName ?? t.contactName ?? null;
  const commitment = t.owedBy === "us";
  return {
    dealId: t.dealId,
    accountId: t.accountId,
    key: `task:${t.id}`,
    kind: "task",
    title: t.title,
    detail: commitment ? "You promised this" : t.origin !== "manual" && t.evidence ? t.evidence.slice(0, 140) : null,
    context,
    href: t.dealId ? `/deals/${t.dealId}` : `/tasks?task=${t.id}`,
    dueAt: t.dueAt,
    urgency: (PRIORITY_URGENCY[t.priority ?? "medium"] ?? 30) + (commitment ? 10 : 0),
    actions: [{ kind: "link", label: "Open", href: t.dealId ? `/deals/${t.dealId}` : `/tasks?task=${t.id}` }, { kind: "done" }, { kind: "snooze" }, ...(canDelegate && t.canEdit ? [{ kind: "delegate" as const }] : [])],
  };
}

function alertItem(a: AlertView, canDelegate: boolean): QueueItem {
  const id = a.entityId.split("#")[0] ?? a.entityId;
  return {
    dealId: a.entity === "deal" ? id : null,
    accountId: a.entity === "account" ? id : null,
    group: `alert:${a.ruleCode}`,
    key: `alert:${a.id}`,
    kind: "alert",
    title: a.title,
    detail: a.suggestedAction ?? a.detail,
    context: a.ruleName,
    href: a.href,
    dueAt: null,
    urgency: 35,
    severity: a.severity,
    actions: [{ kind: "link", label: "Open", href: a.href }, { kind: "done" }, { kind: "snooze" }, ...(canDelegate ? [{ kind: "delegate" as const }] : [])],
  };
}

/** Item key an alert is "about" — when that item is in the queue the alert merges into it instead of a second row. */
function coveredKey(a: AlertView): string | null {
  const id = a.entityId.split("#")[0];
  if (a.entity === "task") return `task:${id}`;
  if (a.entity === "deal") return `deal:${id}`;
  if (a.entity === "email_thread") return `thread:${id}`; // resolved to the versioned reply key by the caller
  return null;
}

/** Collapsed-row copy per alert rule (QA MAJ-21); unknown rules get a generic "N … alerts" row. */
const ALERT_GROUPS: Record<string, GroupSpec> = {
  "NS-15": { title: (n) => `${n} unassigned high-value leads`, href: "/deals?owner=none", cta: "Assign owners" },
  "NS-27": { title: (n) => `${n} deals missing a primary contact`, href: "/tasks?tab=alerts", cta: "Review" },
};
function groupSpec(group: string, sample: QueueItem): GroupSpec {
  const rule = group.startsWith("alert:") ? group.slice(6) : group;
  return ALERT_GROUPS[rule] ?? { title: (n) => `${n} alerts: ${sample.context ?? "same rule"}`, href: "/tasks?tab=alerts", cta: "Review all" };
}

/** Soft-deleted deals / accounts among the rows' subjects (one query each, only when there are candidates). */
async function deletedSubjects(items: QueueItem[]): Promise<{ deals: Set<string>; accounts: Set<string> }> {
  const dealIds = new Set<string>();
  const accountIds = new Set<string>();
  for (const i of items) {
    const sub = itemSubjects(i);
    if (sub.dealId) dealIds.add(sub.dealId);
    if (sub.accountId) accountIds.add(sub.accountId);
  }
  const [deals, accounts] = await Promise.all([
    dealIds.size
      ? db.select({ id: s.deals.id }).from(s.deals).where(and(inArray(s.deals.id, [...dealIds]), isNotNull(s.deals.deletedAt)))
      : Promise.resolve([] as { id: string }[]),
    accountIds.size
      ? db.select({ id: s.accounts.id }).from(s.accounts).where(and(inArray(s.accounts.id, [...accountIds]), isNotNull(s.accounts.deletedAt)))
      : Promise.resolve([] as { id: string }[]),
  ]);
  return { deals: new Set(deals.map((r) => r.id.toLowerCase())), accounts: new Set(accounts.map((r) => r.id.toLowerCase())) };
}

export type TodayMeeting = { id: string; title: string | null; startsAt: string | null; endsAt: string | null; attendees: number; hasBrief: boolean; external: boolean };

export type TodayData = {
  now: string;
  tz: string;
  items: QueueItem[];
  meetings: TodayMeeting[];
  stats: { overdue: number; dueToday: number; alerts: Record<"critical" | "serious" | "warning" | "info", number>; needNextStep: number };
  tomorrow: { tasks: number; meetings: number; firstMeeting: { title: string | null; at: string } | null };
  users: UserOption[];
  canTasks: boolean;
  signals: SuggestionSignals;
};

/** Everything for the Today queue (V2 §B1), permission-scoped, in small parallel waves (the DB pool is small). */
export async function loadToday(user: AppUser): Promise<TodayData> {
  const t0 = Date.now();
  const now = new Date();
  const tz = user.timezone;
  const { start, end } = dayBounds(now, tz);
  const tomorrowEnd = dayBounds(new Date(end.getTime() + 3_600_000), tz).end;

  const [canTasks, canEmail, canAssign, dealWhere, approveFlags] = await Promise.all([
    can(user, "tasks", "view"),
    can(user, "email", "view"),
    can(user, "tasks", "assign"),
    dealAccessWhere(user, "view"),
    Promise.all(APPROVE_MODULES.map((m) => can(user, m, "approve"))),
  ]);
  const isApprover = approveFlags.some(Boolean) || (await can(user, "admin", "configure", "all"));

  // Wave 1: the user's own work
  const [tasks, alerts, alertCounts, snoozes] = await Promise.all([
    canTasks ? safe("tasks", () => listMyTasks(user), { open: [], done: [] }) : Promise.resolve({ open: [] as TaskView[], done: [] as TaskView[] }),
    safe("alerts", () => listMyAlerts(user, { limit: 40 }), [] as AlertView[]),
    safe("alertCounts", () => alertCountsBySeverity(user), { critical: 0, serious: 0, warning: 0, info: 0 }),
    safe(
      "snoozes",
      () =>
        db
          .select({ itemKey: s.queueSnoozes.itemKey, until: s.queueSnoozes.until })
          .from(s.queueSnoozes)
          .where(and(eq(s.queueSnoozes.userId, user.id), or(isNull(s.queueSnoozes.until), gt(s.queueSnoozes.until, now)))),
      [] as { itemKey: string; until: Date | null }[],
    ),
  ]);

  // Wave 2: meetings (today + tomorrow), own deals without a live next step, threads awaiting our reply
  const noNext = or(isNull(s.deals.nextStep), sql`trim(${s.deals.nextStep}) = ''`, isNull(s.deals.nextStepDueAt))!;
  const mineOpen = and(dealWhere, eq(s.deals.ownerId, user.id), eq(s.deals.status, "open"), eq(s.stages.category, "open"))!;
  const [meetingRows, dealRows, needNext, threads] = await Promise.all([
    safe(
      "meetings",
      () =>
        db
          .select({ id: s.meetings.id, title: s.meetings.title, startsAt: s.meetings.startsAt, endsAt: s.meetings.endsAt, attendees: s.meetings.attendees, prepBrief: s.meetings.prepBrief })
          .from(s.meetings)
          .where(and(eq(s.meetings.ownerId, user.id), gte(s.meetings.startsAt, start), lt(s.meetings.startsAt, tomorrowEnd)))
          .orderBy(asc(s.meetings.startsAt))
          .limit(40),
      [],
    ),
    safe(
      "deals",
      () =>
        db
          .select({
            id: s.deals.id,
            name: s.deals.name,
            pipelineKey: s.pipelines.key,
            stageName: s.stages.name,
            nextStep: s.deals.nextStep,
            nextStepDueAt: s.deals.nextStepDueAt,
            noNext: sql<boolean>`${noNext}`,
          })
          .from(s.deals)
          .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
          .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
          .where(and(mineOpen, or(noNext, lt(s.deals.nextStepDueAt, now))))
          .orderBy(asc(s.deals.nextStepDueAt))
          .limit(6),
      [],
    ),
    safe(
      "needNext",
      () =>
        db
          .select({ n: count() })
          .from(s.deals)
          .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
          .where(and(mineOpen, or(noNext, lt(s.deals.nextStepDueAt, now)))),
      [{ n: 0 }],
    ),
    canEmail
      ? safe(
          "threads",
          () =>
            db
              .select({ id: s.emailThreads.id, subject: s.emailThreads.subject, participants: s.emailThreads.participants, lastMessageAt: s.emailThreads.lastMessageAt, private: s.emailThreads.private })
              .from(s.emailThreads)
              .where(and(eq(s.emailThreads.mailboxUserId, user.id), eq(s.emailThreads.awaitingReplyFrom, "us")))
              .orderBy(asc(s.emailThreads.lastMessageAt))
              .limit(8),
          [],
        )
      : Promise.resolve([]),
  ]);

  // Wave 3: approvals, delegation targets, team providers
  const [approvals, users, ...provided] = await Promise.all([
    isApprover ? safe("approvals", () => listApprovals(user), null) : Promise.resolve(null),
    canTasks ? safe("users", () => assignableUsers(user), [] as UserOption[]) : Promise.resolve([] as UserOption[]),
    ...Object.entries(PROVIDERS).map(([name, p]) => safe(`provider:${name}`, () => p.load(user), [] as QueueItem[], PROVIDER_TIMEOUT_MS)),
  ]);
  const canDelegate = canAssign && users.length > 1;

  const items: QueueItem[] = [];
  const buckets = bucketTasks(
    tasks.open.filter((t) => !(t.snoozedUntil && new Date(t.snoozedUntil) > now)),
    now,
    tz,
  );
  for (const t of [...buckets.overdue, ...buckets.today]) items.push(taskItem(t, canDelegate));

  for (const d of dealRows)
    items.push({
      dealId: d.id,
      key: `deal:${d.id}`,
      kind: "deal",
      title: d.noNext ? `Set a next step for ${d.name}` : `Next step overdue: ${d.name}`,
      detail: d.noNext ? "Every open deal needs one clear next step and a date." : d.nextStep,
      context: `${d.pipelineKey} · ${d.stageName}`,
      href: `/deals/${d.id}`,
      dueAt: d.nextStepDueAt?.toISOString() ?? null,
      urgency: d.noNext ? 25 : 30,
      actions: [{ kind: "link", label: d.noNext ? "Set next step" : "Update", href: `/deals/${d.id}` }, { kind: "snooze" }],
    });

  const replyKeys = new Map<string, string>(); // thread id → versioned reply key (alerts about a thread merge into it)
  for (const t of threads) {
    const waitingH = t.lastMessageAt ? (now.getTime() - t.lastMessageAt.getTime()) / 3_600_000 : 0;
    const key = replyKey(t.id, t.lastMessageAt);
    replyKeys.set(t.id, key);
    items.push({
      key,
      kind: "reply",
      title: `Reply: ${t.subject?.trim() || "(no subject)"}`,
      detail: `${t.participants.slice(0, 2).join(", ")}${t.lastMessageAt ? ` · waiting since ${fmtInTz(t.lastMessageAt, tz)}` : ""}`,
      context: t.private ? "Private" : null,
      href: `/inbox?thread=${t.id}`,
      dueAt: null,
      urgency: 30 + Math.min(25, waitingH / 4),
      actions: [{ kind: "link", label: "Reply", href: `/inbox?thread=${t.id}` }, { kind: "done" }, { kind: "snooze" }],
    });
  }

  const soon = new Date(now.getTime() + 2 * 3_600_000);
  const internal = meetingRows.length ? await safe("internalDomains", () => internalDomains(user.email), [] as string[]) : [];
  const isExternal = (attendees: string[]) => hasExternalAttendee(attendees, internal);
  for (const m of meetingRows) {
    if (!m.startsAt || m.startsAt > soon) continue;
    const ended = m.endsAt ? m.endsAt <= now : m.startsAt.getTime() + 3_600_000 <= now.getTime();
    if (ended) continue;
    const live = m.startsAt <= now;
    items.push({
      key: `meeting:${m.id}`,
      kind: "meeting",
      title: `${live ? "Now" : fmtInTz(m.startsAt, tz, "time")}: ${m.title?.trim() || "Untitled meeting"}`,
      detail: `${m.attendees.length} attendee${m.attendees.length === 1 ? "" : "s"}${m.prepBrief ? " · brief ready" : ""}`,
      context: null,
      href: isExternal(m.attendees) || m.prepBrief ? briefHref(m.id) : "/calls",
      dueAt: m.startsAt.toISOString(),
      urgency: live ? 60 : 45,
      // Internal-only meetings get no brief, so no "Prep" (QA MIN-24) — the row just reminds you.
      actions: isExternal(m.attendees) || m.prepBrief ? [{ kind: "link", label: m.prepBrief ? "Open brief" : "Prep", href: briefHref(m.id) }, { kind: "done" }] : [{ kind: "done" }],
    });
  }

  for (const a of approvals?.pending ?? []) {
    const waitingH = (now.getTime() - new Date(a.createdAt).getTime()) / 3_600_000;
    const copy = approvalCopy(a.label, a.kind, a.requesterName);
    items.push({
      key: `approval:${a.id}`,
      kind: "approval",
      title: copy.title,
      detail: copy.detail,
      context: null,
      href: `/tasks?tab=approvals&approval=${a.id}`,
      dueAt: null,
      urgency: 40 + Math.min(20, waitingH / 2),
      actions: [{ kind: "link", label: "Review", href: `/tasks?tab=approvals&approval=${a.id}` }, { kind: "snooze" }],
    });
  }

  for (const list of provided) for (const it of list) if (it && typeof it.key === "string" && typeof it.title === "string") items.push(it);

  // Snoozes/dismissals first, then fold alerts into the row they're about (one row per thing to do).
  const visible = applySnoozes(items, snoozes, now);
  const byKey = new Map(visible.map((i) => [i.key, i]));
  for (const a of applySnoozes(alerts.map((a) => ({ a, key: `alert:${a.id}` })), snoozes, now).map((x) => x.a)) {
    let target = coveredKey(a);
    if (target?.startsWith("thread:")) target = replyKeys.get(target.slice(7)) ?? target;
    const host = target ? byKey.get(target) : undefined;
    if (host) {
      if (!host.severity || SEVERITY_RANK[a.severity] > SEVERITY_RANK[host.severity]) host.severity = a.severity;
      continue;
    }
    const item = alertItem(a, canDelegate);
    visible.push(item);
    byKey.set(item.key, item);
  }

  // Never show rows about soft-deleted deals/accounts — whichever source produced them (QA MIN-41: open alerts on deleted
  // "ZZ" test deals reached dev.sdr's Today). Alert counts drop them too so the glance tiles agree with the list.
  const deleted = await safe("deleted", () => deletedSubjects(visible), { deals: new Set<string>(), accounts: new Set<string>() });
  const live = dropDeleted(visible, deleted);
  const alertCountsLive = { ...alertCounts };
  for (const i of visible) if (i.kind === "alert" && i.severity && !live.includes(i)) alertCountsLive[i.severity] = Math.max(0, alertCountsLive[i.severity] - 1);
  const shown = collapseGroups(live, groupSpec);

  const tomorrowTasks = buckets.upcoming.filter((t) => t.dueAt && new Date(t.dueAt) < tomorrowEnd).length;
  const tomorrowMeetings = meetingRows.filter((m) => m.startsAt && m.startsAt >= end);
  const meetings: TodayMeeting[] = meetingRows
    .filter((m) => m.startsAt && m.startsAt < end)
    .map((m) => ({
      id: m.id,
      title: m.title,
      startsAt: m.startsAt?.toISOString() ?? null,
      endsAt: m.endsAt?.toISOString() ?? null,
      attendees: m.attendees.length,
      hasBrief: Boolean(m.prepBrief),
      external: isExternal(m.attendees),
    }));
  const totalAlerts = alertCountsLive.critical + alertCountsLive.serious + alertCountsLive.warning + alertCountsLive.info;
  const ms = Date.now() - t0;
  if (ms > 1_500) console.warn(`[queue] loadToday took ${ms} ms`);

  return {
    now: now.toISOString(),
    tz,
    items: rankQueue(shown, now),
    meetings,
    stats: { overdue: buckets.overdue.length, dueToday: buckets.today.length, alerts: alertCountsLive, needNextStep: needNext[0]?.n ?? 0 },
    tomorrow: {
      tasks: tomorrowTasks,
      meetings: tomorrowMeetings.length,
      firstMeeting: tomorrowMeetings[0]?.startsAt ? { title: tomorrowMeetings[0].title, at: tomorrowMeetings[0].startsAt.toISOString() } : null,
    },
    users,
    canTasks,
    signals: {
      noNextStep: needNext[0]?.n ?? 0,
      overdueTasks: buckets.overdue.length,
      dueToday: buckets.today.length,
      openAlerts: totalAlerts,
      awaitingReply: threads.length,
      meetingsToday: meetings.length,
      isLeader: LEADER_ROLES.includes(user.role),
    },
  };
}

