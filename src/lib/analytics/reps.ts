import "server-only";
import { limited, limitedAll } from "./limit";
import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealScopeWhere, ownerFilter, type AnalyticsContext } from "./scope";
import { commitmentsKept, hygieneScore } from "./transforms";
import { countInt, grossUsd, money, sumF, ts } from "./value-sql";

export const ACTIVITY_TYPES = ["email", "call", "meeting", "linkedin", "note"] as const;
export const ACTIVITY_LABELS: Record<(typeof ACTIVITY_TYPES)[number], string> = {
  email: "Emails",
  call: "Calls",
  meeting: "Meetings",
  linkedin: "LinkedIn",
  note: "Notes",
};

export type RepRow = {
  userId: string;
  name: string;
  activities: Record<(typeof ACTIVITY_TYPES)[number], number>;
  totalActivities: number;
  meetingsHeld: number;
  dealsAdvanced: number;
  won: number;
  wonValue: number;
  created: number;
  createdValue: number;
  openDeals: number;
  hygiene: number | null;
  commitmentsDue: number;
  commitmentsKept: number;
  commitmentsRate: number | null;
};

const prevStage = alias(s.stages, "prev_stage");

/** Rep scorecard (PRD §14.2): activities, meetings, advanced, won, hygiene, commitments kept, pipeline created. */
export async function repScorecard(ctx: AnalyticsContext, now: Date): Promise<RepRow[]> {
  const { from, to } = ctx.filters;
  const dealWhere = await dealScopeWhere(ctx);
  const m = money(ctx.filters.basis);

  const [acts, meetings, advanced, wonRows, createdRows, openRows, commitments] = await limitedAll([
    db
      .select({ userId: s.activities.actorId, type: s.activities.type, n: countInt })
      .from(s.activities)
      .where(
        and(
          ownerFilter(ctx, s.activities.actorId),
          isNotNull(s.activities.actorId),
          gte(s.activities.occurredAt, from),
          lte(s.activities.occurredAt, to),
          inArray(s.activities.type, [...ACTIVITY_TYPES]),
        ),
      )
      .groupBy(s.activities.actorId, s.activities.type),
    // Meetings held = calendar meetings that already happened (owner) in range.
    db
      .select({ userId: s.meetings.ownerId, n: countInt })
      .from(s.meetings)
      .where(and(ownerFilter(ctx, s.meetings.ownerId), gte(s.meetings.startsAt, from), lte(s.meetings.startsAt, sql`least(${ts(to)}, now())`)))
      .groupBy(s.meetings.ownerId),
    // Deals advanced: forward stage moves (or wins) in range on deals the rep owns.
    db
      .select({ userId: s.deals.ownerId, n: sql<number>`count(distinct ${s.deals.id})::int` })
      .from(s.dealStageHistory)
      .innerJoin(s.deals, eq(s.dealStageHistory.dealId, s.deals.id))
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .innerJoin(s.stages, eq(s.dealStageHistory.toStageId, s.stages.id))
      .leftJoin(prevStage, eq(s.dealStageHistory.fromStageId, prevStage.id))
      .where(
        and(
          dealWhere,
          gte(s.dealStageHistory.changedAt, from),
          lte(s.dealStageHistory.changedAt, to),
          sql`(${s.stages.category} = 'won' or (${s.stages.category} = 'open' and ${s.stages.key} !~* 'cold|nurture|lapsed' and ${prevStage.category} = 'open' and ${s.stages.sortOrder} > ${prevStage.sortOrder}))`,
        ),
      )
      .groupBy(s.deals.ownerId),
    db
      .select({ userId: s.deals.ownerId, n: countInt, value: sumF(m) })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .where(and(dealWhere, eq(s.deals.status, "won"), gte(s.deals.wonAt, from), lte(s.deals.wonAt, to)))
      .groupBy(s.deals.ownerId),
    db
      .select({ userId: s.deals.ownerId, n: countInt, value: sumF(grossUsd) })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .where(and(dealWhere, gte(s.deals.createdAt, from), lte(s.deals.createdAt, to)))
      .groupBy(s.deals.ownerId),
    db
      .select({ userId: s.deals.ownerId, nextStep: s.deals.nextStep, nextStepDueAt: s.deals.nextStepDueAt })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.deals.pipelineId, s.pipelines.id))
      .innerJoin(s.stages, eq(s.deals.stageId, s.stages.id))
      .where(and(dealWhere, eq(s.stages.category, "open"))),
    db
      .select({ userId: s.tasks.assigneeId, status: s.tasks.status, dueAt: s.tasks.dueAt, completedAt: s.tasks.completedAt })
      .from(s.tasks)
      .where(and(ownerFilter(ctx, s.tasks.assigneeId), eq(s.tasks.owedBy, "us"), gte(s.tasks.dueAt, from), lte(s.tasks.dueAt, to))),
  ]);

  const ids = new Set<string>();
  for (const r of [...acts, ...meetings, ...advanced, ...wonRows, ...createdRows, ...openRows, ...commitments]) if (r.userId) ids.add(r.userId);
  if (ctx.filters.owner) ids.add(ctx.filters.owner);
  if (ctx.scope === "own") ids.add(ctx.user.id);
  if (!ids.size) return [];
  const users = await limited(db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(inArray(s.user.id, [...ids])));
  const allowed = ctx.ownerIds ? new Set(ctx.ownerIds) : null;

  return users
    .filter((u) => !allowed || allowed.has(u.id))
    .map((u) => {
      const activities = Object.fromEntries(ACTIVITY_TYPES.map((t) => [t, acts.find((a) => a.userId === u.id && a.type === t)?.n ?? 0])) as RepRow["activities"];
      const open = openRows.filter((r) => r.userId === u.id);
      const c = commitmentsKept(
        commitments.filter((t) => t.userId === u.id),
        now,
      );
      const won = wonRows.find((r) => r.userId === u.id);
      const created = createdRows.find((r) => r.userId === u.id);
      return {
        userId: u.id,
        name: u.name,
        activities,
        totalActivities: Object.values(activities).reduce((a, n) => a + n, 0),
        meetingsHeld: meetings.find((r) => r.userId === u.id)?.n ?? 0,
        dealsAdvanced: advanced.find((r) => r.userId === u.id)?.n ?? 0,
        won: won?.n ?? 0,
        wonValue: won?.value ?? 0,
        created: created?.n ?? 0,
        createdValue: created?.value ?? 0,
        openDeals: open.length,
        hygiene: hygieneScore(open, now),
        commitmentsDue: c.due,
        commitmentsKept: c.kept,
        commitmentsRate: c.rate,
      };
    })
    .sort((a, b) => b.totalActivities + b.won * 10 - (a.totalActivities + a.won * 10) || a.name.localeCompare(b.name));
}
