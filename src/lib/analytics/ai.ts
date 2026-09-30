import "server-only";
import { limitedAll } from "./limit";
import { and, asc, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { ownerFilter, type AnalyticsContext } from "./scope";
import { countInt, sumF } from "./value-sql";

export const AI_TASK_ORIGINS = ["email_ai", "call_ai", "agent"] as const;
export const AI_ORIGIN_LABELS: Record<(typeof AI_TASK_ORIGINS)[number], string> = {
  email_ai: "From email",
  call_ai: "From call",
  agent: "Copilot",
};

/** AI & Automation (PRD §14.2): agent runs by kind (count, latency, errors, cost), AI-task acceptance, alerts. */
export async function aiAutomation(ctx: AnalyticsContext) {
  const { from, to } = ctx.filters;
  const runsWhere = and(ownerFilter(ctx, s.agentRuns.userId), gte(s.agentRuns.createdAt, from), lte(s.agentRuns.createdAt, to));
  const day = sql<string>`to_char(${s.agentRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const [byKind, byDay, tasks, alerts] = await limitedAll([
    db
      .select({
        kind: s.agentRuns.kind,
        runs: countInt,
        errors: sql<number>`count(*) filter (where ${s.agentRuns.error} is not null)::int`,
        avgLatency: sql<number | null>`avg(${s.agentRuns.latencyMs})::float8`,
        p95Latency: sql<number | null>`percentile_cont(0.95) within group (order by ${s.agentRuns.latencyMs})::float8`,
        costUsd: sumF(sql`coalesce(${s.agentRuns.costUsd}, 0)`),
      })
      .from(s.agentRuns)
      .where(runsWhere)
      .groupBy(s.agentRuns.kind),
    db
      .select({ day, runs: countInt, errors: sql<number>`count(*) filter (where ${s.agentRuns.error} is not null)::int` })
      .from(s.agentRuns)
      .where(runsWhere)
      .groupBy(day)
      .orderBy(asc(day)),
    db
      .select({
        origin: s.tasks.origin,
        created: countInt,
        done: sql<number>`count(*) filter (where ${s.tasks.status} = 'done')::int`,
        cancelled: sql<number>`count(*) filter (where ${s.tasks.status} = 'cancelled')::int`,
        open: sql<number>`count(*) filter (where ${s.tasks.status} = 'open')::int`,
        avgHoursToDone: sql<number | null>`avg(extract(epoch from (${s.tasks.completedAt} - ${s.tasks.createdAt})) / 3600.0) filter (where ${s.tasks.status} = 'done')`,
      })
      .from(s.tasks)
      .where(and(ownerFilter(ctx, s.tasks.assigneeId), inArray(s.tasks.origin, [...AI_TASK_ORIGINS]), gte(s.tasks.createdAt, from), lte(s.tasks.createdAt, to)))
      .groupBy(s.tasks.origin),
    db
      .select({
        fired: countInt,
        resolved: sql<number>`count(*) filter (where ${s.alerts.state} in ('resolved','dismissed'))::int`,
        escalated: sql<number>`count(*) filter (where ${s.alerts.escalatedAt} is not null)::int`,
      })
      .from(s.alerts)
      .where(and(ownerFilter(ctx, s.alerts.recipientId), gte(s.alerts.createdAt, from), lte(s.alerts.createdAt, to))),
  ]);
  return {
    byKind: byKind.sort((a, b) => b.runs - a.runs),
    byDay,
    tasks: tasks.map((t) => ({ ...t, acceptance: t.done + t.cancelled ? t.done / (t.done + t.cancelled) : null, avgHoursToDone: t.avgHoursToDone == null ? null : Number(t.avgHoursToDone) })),
    alerts: alerts[0] ?? { fired: 0, resolved: 0, escalated: 0 },
  };
}
