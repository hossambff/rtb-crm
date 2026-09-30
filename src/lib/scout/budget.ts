import "server-only";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { checkBudget, monthStart, userCapCents, type BudgetDecision } from "./budget-core";
import { getScoutSettings } from "./settings";

/**
 * Month-to-date Apify spend. Actual cost for finished runs; for queued/running runs the larger of cost so far and
 * the estimate is reserved so concurrent runs can't jointly overshoot the cap. Blocked runs cost nothing.
 */
const spendExpr = sql<number>`coalesce(sum(case when ${s.enrichmentRuns.status} in ('queued','running') then greatest(${s.enrichmentRuns.costCents}, ${s.enrichmentRuns.estimatedCostCents}) when ${s.enrichmentRuns.status} = 'blocked' then 0 else ${s.enrichmentRuns.costCents} end), 0)::int`;

export async function orgSpendCents(now = new Date()): Promise<number> {
  const [r] = await db.select({ c: spendExpr }).from(s.enrichmentRuns).where(gte(s.enrichmentRuns.createdAt, monthStart(now)));
  return r?.c ?? 0;
}

export async function userSpendCents(userId: string, now = new Date()): Promise<number> {
  const [r] = await db
    .select({ c: spendExpr })
    .from(s.enrichmentRuns)
    .where(and(gte(s.enrichmentRuns.createdAt, monthStart(now)), eq(s.enrichmentRuns.requestedBy, userId)));
  return r?.c ?? 0;
}

export async function spendByUser(now = new Date()) {
  return db
    .select({ userId: s.enrichmentRuns.requestedBy, name: s.user.name, role: s.user.role, override: s.user.monthlyScoutBudgetCents, cents: spendExpr, runs: sql<number>`count(*)::int` })
    .from(s.enrichmentRuns)
    .leftJoin(s.user, eq(s.user.id, s.enrichmentRuns.requestedBy))
    .where(gte(s.enrichmentRuns.createdAt, monthStart(now)))
    .groupBy(s.enrichmentRuns.requestedBy, s.user.name, s.user.role, s.user.monthlyScoutBudgetCents)
    .orderBy(desc(spendExpr));
}

export type BudgetSubject = { id: string; role: string };

/** Approved, unconsumed "request more budget" for this user + entity (lifts per-run/user caps once). */
async function approvedOverride(userId: string, entity: string, entityId: string): Promise<{ id: string; cents: number } | null> {
  const rows = await db
    .select()
    .from(s.approvals)
    .where(and(eq(s.approvals.kind, "scout_budget"), eq(s.approvals.status, "approved"), eq(s.approvals.requestedBy, userId), eq(s.approvals.entity, entity), eq(s.approvals.entityId, entityId)))
    .orderBy(desc(s.approvals.createdAt))
    .limit(5);
  for (const r of rows) {
    const p = r.payload as { amountCents?: number; consumedRunId?: string };
    if (!p.consumedRunId && typeof p.amountCents === "number") return { id: r.id, cents: p.amountCents };
  }
  return null;
}

export async function consumeOverride(approvalId: string, runId: string) {
  await db
    .update(s.approvals)
    .set({ payload: sql`${s.approvals.payload} || ${JSON.stringify({ consumedRunId: runId })}::jsonb` })
    .where(eq(s.approvals.id, approvalId));
}

export type BudgetCheck = BudgetDecision & { estimateCents: number; overrideApprovalId: string | null; userCapCents: number; orgCapCents: number; userSpentCents: number; orgSpentCents: number };

export async function checkRunBudget(subject: BudgetSubject, estimateCents: number, entity: { entity: string; entityId: string }): Promise<BudgetCheck> {
  const [settings, orgSpent, userSpent, [u], override] = await Promise.all([
    getScoutSettings(),
    orgSpendCents(),
    userSpendCents(subject.id),
    db.select({ cap: s.user.monthlyScoutBudgetCents }).from(s.user).where(eq(s.user.id, subject.id)),
    approvedOverride(subject.id, entity.entity, entity.entityId),
  ]);
  const cap = userCapCents(subject.role, u?.cap ?? null, settings.budget);
  const d = checkBudget({
    estimateCents,
    orgSpentCents: orgSpent,
    userSpentCents: userSpent,
    userCapCents: cap,
    settings: settings.budget,
    approvedOverrideCents: override?.cents ?? null,
  });
  return {
    ...d,
    estimateCents,
    overrideApprovalId: d.allowed && override && override.cents >= estimateCents ? override.id : null,
    userCapCents: cap,
    orgCapCents: settings.budget.orgMonthlyCents,
    userSpentCents: userSpent,
    orgSpentCents: orgSpent,
  };
}

export async function pendingBudgetRequest(userId: string, entity: string, entityId: string) {
  const [r] = await db
    .select({ id: s.approvals.id })
    .from(s.approvals)
    .where(and(eq(s.approvals.kind, "scout_budget"), eq(s.approvals.status, "pending"), eq(s.approvals.requestedBy, userId), eq(s.approvals.entity, entity), eq(s.approvals.entityId, entityId)));
  return r ?? null;
}

export async function notifyApprovers(role: string[], title: string, body: string, href: string) {
  const users = await db.select({ id: s.user.id }).from(s.user).where(inArray(s.user.role, role));
  if (users.length) await db.insert(s.notifications).values(users.map((u) => ({ userId: u.id, kind: "approval", title, body, href })));
}
