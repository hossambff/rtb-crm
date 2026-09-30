import "server-only";
import { and, asc, count, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { can, dealAccessWhere, type AppUser } from "@/lib/rbac/server";
import { dayBounds } from "@/lib/alerts/time";
import { alertCountsBySeverity, listMyAlerts } from "@/lib/alerts/queries";
import { listApprovals } from "@/lib/approvals/service";
import { assignableUsers, listMyTasks } from "./queries";
import { bucketTasks } from "./core";

export type AttentionDeal = {
  id: string;
  name: string;
  pipelineKey: string;
  stageName: string;
  healthScore: number | null;
  nextStep: string | null;
  nextStepDueAt: string | null;
  reasons: ("no_next_step" | "overdue" | "stale" | "health")[];
};

/** Everything for /home (PRD §8.1), loaded in parallel and permission-scoped. */
export async function loadMyDay(user: AppUser) {
  const now = new Date();
  const { start, end } = dayBounds(now, user.timezone);
  const [canEmail, canTasks, dealWhere] = await Promise.all([can(user, "email", "view"), can(user, "tasks", "view"), dealAccessWhere(user, "view")]);
  const mineWhere = and(dealWhere, eq(s.deals.ownerId, user.id), eq(s.deals.status, "open"), eq(s.stages.category, "open"))!;
  const idle = sql`greatest(${s.deals.stageEnteredAt}, coalesce(${s.deals.lastActivityAt}, ${s.deals.stageEnteredAt}))`;
  const staleCond = sql`${s.stages.slaDays} is not null and ${idle} < now() - make_interval(days => ${s.stages.slaDays})`;
  const noNext = or(isNull(s.deals.nextStep), sql`trim(${s.deals.nextStep}) = ''`, isNull(s.deals.nextStepDueAt))!;
  const approverRole = ["executive", "admin", "super_admin", "sales_leader", "finance"].includes(user.role);

  // Parallel in small waves: the DB pool is small (max 5) and over-subscribing it pipelines queries on pooled
  // connections, which the Supabase transaction pooler handles poorly under load.
  const [tasks, alertCounts, alerts] = await Promise.all([
    canTasks ? listMyTasks(user) : Promise.resolve({ open: [], done: [] }),
    alertCountsBySeverity(user),
    listMyAlerts(user, { limit: 6 }),
  ]);
  const [meetings, attention, needNext] = await Promise.all([
    db
      .select({ id: s.meetings.id, title: s.meetings.title, startsAt: s.meetings.startsAt, endsAt: s.meetings.endsAt, attendees: s.meetings.attendees, dealId: s.meetings.dealId, prepBrief: s.meetings.prepBrief })
      .from(s.meetings)
      .where(and(eq(s.meetings.ownerId, user.id), gte(s.meetings.startsAt, start), lt(s.meetings.startsAt, end)))
      .orderBy(asc(s.meetings.startsAt))
      .limit(12),
    db
      .select({
        id: s.deals.id,
        name: s.deals.name,
        pipelineKey: s.pipelines.key,
        stageName: s.stages.name,
        healthScore: s.deals.healthScore,
        nextStep: s.deals.nextStep,
        nextStepDueAt: s.deals.nextStepDueAt,
        noNext: sql<boolean>`${noNext}`,
        overdue: sql<boolean>`coalesce(${s.deals.nextStepDueAt} < now(), false)`,
        stale: sql<boolean>`coalesce(${staleCond}, false)`,
      })
      .from(s.deals)
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .where(and(mineWhere, or(noNext, lt(s.deals.nextStepDueAt, now), lt(s.deals.healthScore, 50), staleCond)))
      .orderBy(asc(s.deals.nextStepDueAt))
      .limit(8),
    db
      .select({ n: count() })
      .from(s.deals)
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
      .where(and(mineWhere, or(noNext, lt(s.deals.nextStepDueAt, now)))),
  ]);
  const [threads, approvals, users] = await Promise.all([
    canEmail
      ? db
          .select({ id: s.emailThreads.id, subject: s.emailThreads.subject, snippet: s.emailThreads.snippet, participants: s.emailThreads.participants, lastMessageAt: s.emailThreads.lastMessageAt, private: s.emailThreads.private })
          .from(s.emailThreads)
          .where(and(eq(s.emailThreads.mailboxUserId, user.id), eq(s.emailThreads.awaitingReplyFrom, "us")))
          .orderBy(asc(s.emailThreads.lastMessageAt))
          .limit(6)
      : Promise.resolve([]),
    approverRole ? listApprovals(user) : Promise.resolve(null),
    assignableUsers(user),
  ]);

  const buckets = bucketTasks(tasks.open, now, user.timezone);
  const attentionDeals: AttentionDeal[] = attention.map((d) => ({
    id: d.id,
    name: d.name,
    pipelineKey: d.pipelineKey,
    stageName: d.stageName,
    healthScore: d.healthScore,
    nextStep: d.nextStep,
    nextStepDueAt: d.nextStepDueAt?.toISOString() ?? null,
    reasons: [
      ...(d.noNext ? (["no_next_step"] as const) : []),
      ...(d.overdue ? (["overdue"] as const) : []),
      ...(d.stale ? (["stale"] as const) : []),
      ...(d.healthScore != null && d.healthScore < 50 ? (["health"] as const) : []),
    ],
  }));

  return {
    now,
    canTasks,
    canEmail,
    buckets,
    alertCounts,
    alerts,
    meetings: meetings.map((m) => ({ ...m, startsAt: m.startsAt?.toISOString() ?? null, endsAt: m.endsAt?.toISOString() ?? null })),
    attentionDeals,
    needNextStep: needNext[0]?.n ?? 0,
    threads: threads.map((t) => ({ ...t, lastMessageAt: t.lastMessageAt?.toISOString() ?? null })),
    approvals: approvals?.pending ?? [],
    showApprovals: Boolean(approvals && (approvals.pending.length || approvals.isApprover)),
    users,
  };
}
