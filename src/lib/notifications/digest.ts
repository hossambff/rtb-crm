import "server-only";
import { and, count, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dayBounds } from "@/lib/alerts/time";
import { getMatrix } from "@/lib/rbac/server";
import { ROLES, type Role } from "@/lib/rbac/model";
import { notifyMany } from "./notify";
import { snapshotDelta, type SnapshotRow } from "./snapshot-core";
import { myDayDigestText, type DigestCounts } from "./digest-core";

const DEFAULT_TZ = "America/New_York";
const OPEN_ALERT_STATES = ["open", "acknowledged", "escalated"] as const;

/**
 * Daily "My Day" digest (NOT-2) — one digest notification per active user per day (skipped when there's nothing).
 * Cron 12:00 UTC ≈ 08:00 America/New_York. Email delivery hooks in later.
 */
export async function sendDailyDigests(now = new Date()): Promise<{ users: number; sent: number }> {
  const users = (await db.select().from(s.user)).filter(
    (u) => u.role !== "pending" && !u.banned && (!u.accessExpiresAt || u.accessExpiresAt > now),
  );
  if (!users.length) return { users: 0, sent: 0 };
  const ids = users.map((u) => u.id);
  const horizon = new Date(now.getTime() + 2 * 86_400_000);
  const since = new Date(now.getTime() - 20 * 3_600_000);

  const [tasks, meetings, alertCounts, threads, risky, already] = await Promise.all([
    db
      .select({ assigneeId: s.tasks.assigneeId, dueAt: s.tasks.dueAt, owedBy: s.tasks.owedBy, snoozedUntil: s.tasks.snoozedUntil })
      .from(s.tasks)
      .where(and(eq(s.tasks.status, "open"), inArray(s.tasks.assigneeId, ids), lt(s.tasks.dueAt, horizon))),
    db
      .select({ ownerId: s.meetings.ownerId, startsAt: s.meetings.startsAt })
      .from(s.meetings)
      .where(and(inArray(s.meetings.ownerId, ids), gte(s.meetings.startsAt, new Date(now.getTime() - 86_400_000)), lt(s.meetings.startsAt, horizon))),
    db
      .select({ recipientId: s.alerts.recipientId, severity: s.alerts.severity, n: count() })
      .from(s.alerts)
      .where(and(inArray(s.alerts.state, [...OPEN_ALERT_STATES]), inArray(s.alerts.recipientId, ids)))
      .groupBy(s.alerts.recipientId, s.alerts.severity),
    db
      .select({ userId: s.emailThreads.mailboxUserId, n: count() })
      .from(s.emailThreads)
      .where(and(eq(s.emailThreads.awaitingReplyFrom, "us"), inArray(s.emailThreads.mailboxUserId, ids)))
      .groupBy(s.emailThreads.mailboxUserId),
    db
      .select({ ownerId: s.deals.ownerId, n: count() })
      .from(s.deals)
      .where(
        and(
          isNull(s.deals.deletedAt),
          eq(s.deals.status, "open"),
          inArray(s.deals.ownerId, ids),
          or(lt(s.deals.nextStepDueAt, now), lt(s.deals.healthScore, 50)),
        ),
      )
      .groupBy(s.deals.ownerId),
    db
      .select({ userId: s.notifications.userId })
      .from(s.notifications)
      .where(and(eq(s.notifications.kind, "digest"), sql`${s.notifications.title} like 'My Day%'`, gte(s.notifications.createdAt, since))),
  ]);
  const done = new Set(already.map((r) => r.userId));
  let sent = 0;
  for (const u of users) {
    if (done.has(u.id)) continue;
    const tz = u.timezone ?? DEFAULT_TZ;
    const { start, end } = dayBounds(now, tz);
    const mine = tasks.filter((t) => t.assigneeId === u.id && t.dueAt && !(t.snoozedUntil && t.snoozedUntil > now));
    const alerts = { critical: 0, serious: 0, warning: 0, info: 0 };
    for (const a of alertCounts) if (a.recipientId === u.id) alerts[a.severity] += a.n;
    const counts: DigestCounts = {
      overdueTasks: mine.filter((t) => t.dueAt! < start).length,
      dueToday: mine.filter((t) => t.dueAt! >= start && t.dueAt! < end).length,
      commitmentsDue: mine.filter((t) => t.owedBy === "us" && t.dueAt! >= start && t.dueAt! < end).length,
      meetingsToday: meetings.filter((m) => m.ownerId === u.id && m.startsAt && m.startsAt >= start && m.startsAt < end).length,
      awaitingReply: threads.find((t) => t.userId === u.id)?.n ?? 0,
      dealsAtRisk: risky.find((r) => r.ownerId === u.id)?.n ?? 0,
      alerts,
    };
    const text = myDayDigestText(counts);
    if (!text) continue;
    await notifyMany([u.id], { kind: "digest", title: text.title, body: text.body, href: "/home" });
    sent++;
  }
  return { users: users.length, sent };
}

/**
 * Weekly manager digest (NOT-3): team pipeline changes (from pipeline_snapshots), stale deals (open NS-03 alerts),
 * rep activity (activities in the last 7 days). One per manager per week.
 */
export async function sendWeeklyManagerDigests(now = new Date()): Promise<{ managers: number; sent: number }> {
  const users = (await db.select().from(s.user)).filter((u) => u.role !== "pending" && !u.banned);
  const teams = await db.select().from(s.teams);
  const byId = new Map(users.map((u) => [u.id, u]));
  const reportsOf = new Map<string, Set<string>>();
  const add = (mgr: string | null, rep: string) => {
    if (!mgr || mgr === rep || !byId.has(mgr)) return;
    reportsOf.set(mgr, (reportsOf.get(mgr) ?? new Set()).add(rep));
  };
  for (const u of users) add(u.managerId, u.id);
  for (const t of teams) for (const u of users) if (u.teamId === t.id) add(t.leadId, u.id);
  if (!reportsOf.size) return { managers: 0, sent: 0 };

  const today = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const weekAgoKey = weekAgo.toISOString().slice(0, 10);
  const [latestRow] = await db.select({ d: s.pipelineSnapshots.takenOn }).from(s.pipelineSnapshots).where(lte(s.pipelineSnapshots.takenOn, today)).orderBy(desc(s.pipelineSnapshots.takenOn)).limit(1);
  const [prevRow] = await db.select({ d: s.pipelineSnapshots.takenOn }).from(s.pipelineSnapshots).where(lte(s.pipelineSnapshots.takenOn, weekAgoKey)).orderBy(desc(s.pipelineSnapshots.takenOn)).limit(1);
  const [cur, prev] = await Promise.all([
    latestRow ? db.select().from(s.pipelineSnapshots).where(eq(s.pipelineSnapshots.takenOn, latestRow.d)) : Promise.resolve([] as SnapshotRow[]),
    prevRow ? db.select().from(s.pipelineSnapshots).where(eq(s.pipelineSnapshots.takenOn, prevRow.d)) : Promise.resolve([] as SnapshotRow[]),
  ]);
  const delta = snapshotDelta(cur, prev);

  const allReps = Array.from(new Set([...reportsOf.values()].flatMap((x) => [...x])));
  const [acts, stale, already] = await Promise.all([
    db
      .select({ actorId: s.activities.actorId, n: count() })
      .from(s.activities)
      .where(and(inArray(s.activities.actorId, allReps), gte(s.activities.occurredAt, weekAgo)))
      .groupBy(s.activities.actorId),
    db
      .select({ recipientId: s.alerts.recipientId, n: count() })
      .from(s.alerts)
      .where(and(eq(s.alerts.ruleCode, "NS-03"), inArray(s.alerts.state, [...OPEN_ALERT_STATES]), inArray(s.alerts.recipientId, allReps)))
      .groupBy(s.alerts.recipientId),
    db
      .select({ userId: s.notifications.userId })
      .from(s.notifications)
      .where(and(eq(s.notifications.kind, "digest"), sql`${s.notifications.title} like 'Weekly team digest%'`, gte(s.notifications.createdAt, new Date(now.getTime() - 6 * 86_400_000)))),
  ]);
  const done = new Set(already.map((r) => r.userId));
  const leadPipelines = new Map<string, string[]>();
  for (const t of teams) if (t.leadId) leadPipelines.set(t.leadId, [...(leadPipelines.get(t.leadId) ?? []), ...t.pipelineTypes]);

  let sent = 0;
  for (const [mgr, reps] of reportsOf) {
    if (done.has(mgr)) continue;
    const pipes = leadPipelines.get(mgr);
    const lines: string[] = [];
    // SEC H-4: company-wide pipeline totals only go to recipients who may see org-wide analytics (the executive
    // dashboard audience). Snapshots already exclude restricted deals.
    const role = byId.get(mgr)?.role ?? "pending";
    const orgWide = (ROLES as readonly string[]).includes(role) && (await getMatrix(role as Role)).analytics?.view === "all";
    const moves = orgWide ? delta.filter((d) => !pipes?.length || pipes.includes(d.pipelineKey)) : [];
    if (!orgWide) lines.push("Pipeline: see Analytics for your team's pipeline changes.");
    else if (moves.length && prevRow) {
      lines.push("Pipeline (week over week):");
      for (const m of moves)
        lines.push(
          `• ${m.pipelineKey}: ${m.count} deals (${m.countDelta >= 0 ? "+" : ""}${m.countDelta}), weighted $${Math.round(m.weightedCents / 100).toLocaleString("en-US")} (${m.weightedDeltaCents >= 0 ? "+" : "−"}$${Math.abs(Math.round(m.weightedDeltaCents / 100)).toLocaleString("en-US")})`,
        );
    } else lines.push("Pipeline: not enough snapshot history yet for week-over-week changes.");
    const staleTotal = stale.filter((x) => x.recipientId && reps.has(x.recipientId)).reduce((a, x) => a + x.n, 0);
    lines.push(`Stale deals beyond stage SLA: ${staleTotal}`);
    lines.push("Rep activity (7 days):");
    for (const r of reps) {
      const u = byId.get(r);
      if (!u) continue;
      lines.push(`• ${u.name}: ${acts.find((a) => a.actorId === r)?.n ?? 0} activities`);
    }
    await notifyMany([mgr], { kind: "digest", title: `Weekly team digest — ${reps.size} rep${reps.size === 1 ? "" : "s"}`, body: lines.join("\n"), href: "/analytics" });
    sent++;
  }
  return { managers: reportsOf.size, sent };
}
