import "server-only";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, withXactLock, type Executor } from "@/db";
import * as s from "@/db/schema";
import { notifyMany } from "@/lib/notifications/notify";
import { checkBudget, monthStart, userCapCents, type BudgetDecision } from "./budget-core";
import { getScoutSettings, type ScoutSettings } from "./settings";

/**
 * The spend a queued/running run has RESERVED (H-04): the most it may spend — the plan step's `maxAllowedCents`
 * (the per-run / user / org / search cap the step runner enforces), never less than its estimate.
 */
const reservedExpr = sql<number>`greatest(${s.enrichmentRuns.estimatedCostCents}, coalesce((
  select (e->'output'->>'maxAllowedCents')::int from jsonb_array_elements(${s.enrichmentRuns.actors}) e where e->>'key' = 'plan' limit 1), 0))`;

/**
 * Month-to-date Apify spend. Actual cost for finished runs (reconciled: the reservation is released as soon as the
 * run finishes); queued/running runs count the larger of cost so far and their full reservation, so concurrent
 * runs can't jointly overshoot the org cap. A run stuck "running" for over a day counts its actual cost only.
 * Blocked runs cost nothing.
 */
const spendExpr = sql<number>`coalesce(sum(case
  when ${s.enrichmentRuns.status} in ('queued','running') and ${s.enrichmentRuns.createdAt} > now() - interval '1 day' then greatest(${s.enrichmentRuns.costCents}, ${reservedExpr})
  when ${s.enrichmentRuns.status} = 'blocked' then 0
  else ${s.enrichmentRuns.costCents} end), 0)::int`;

export async function orgSpendCents(now = new Date(), q: Executor = db): Promise<number> {
  const [r] = await q.select({ c: spendExpr }).from(s.enrichmentRuns).where(gte(s.enrichmentRuns.createdAt, monthStart(now)));
  return r?.c ?? 0;
}

export async function userSpendCents(userId: string, now = new Date(), q: Executor = db): Promise<number> {
  const [r] = await q
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
async function approvedOverride(userId: string, entity: string, entityId: string, q: Executor = db): Promise<{ id: string; cents: number } | null> {
  const rows = await q
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

export async function consumeOverride(approvalId: string, runId: string, q: Executor = db) {
  await q
    .update(s.approvals)
    .set({ payload: sql`${s.approvals.payload} || ${JSON.stringify({ consumedRunId: runId })}::jsonb` })
    .where(eq(s.approvals.id, approvalId));
}

export type BudgetCheck = BudgetDecision & { estimateCents: number; overrideApprovalId: string | null; userCapCents: number; orgCapCents: number; userSpentCents: number; orgSpentCents: number };

/** Budget check for a preview (no reservation). Starting a run must go through `reserveRun`. */
export async function checkRunBudget(subject: BudgetSubject, estimateCents: number, entity: { entity: string; entityId: string }): Promise<BudgetCheck> {
  return checkRunBudgetWith(db, await getScoutSettings(), subject, estimateCents, entity);
}

async function checkRunBudgetWith(q: Executor, settings: ScoutSettings, subject: BudgetSubject, estimateCents: number, entity: { entity: string; entityId: string }): Promise<BudgetCheck> {
  // sequential: inside reserveRun this runs on one transaction connection
  const orgSpent = await orgSpendCents(new Date(), q);
  const userSpent = await userSpendCents(subject.id, new Date(), q);
  const [u] = await q.select({ cap: s.user.monthlyScoutBudgetCents }).from(s.user).where(eq(s.user.id, subject.id));
  const override = await approvedOverride(subject.id, entity.entity, entity.entityId, q);
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

/**
 * Check the budget AND record the run in one serialized step (H-04): a transaction holding
 * pg_advisory_xact_lock('rso.scout.budget') (pooler-safe) reads month-to-date spend incl. every open reservation,
 * decides, inserts the run (queued with its reservation in the plan step, or blocked) and consumes a one-time
 * override. Two concurrent starts can't both see the same headroom. `make` builds the row from the decision; a
 * queued row's plan step must carry `output.maxAllowedCents` (the reservation).
 */
export async function reserveRun(
  subject: BudgetSubject,
  estimateCents: number,
  entity: { entity: string; entityId: string },
  make: (d: BudgetCheck) => typeof s.enrichmentRuns.$inferInsert,
): Promise<{ decision: BudgetCheck; runId: string }> {
  const settings = await getScoutSettings();
  const res = await withXactLock("rso.scout.budget", async (tx) => {
    const decision = await checkRunBudgetWith(tx, settings, subject, estimateCents, entity);
    const [run] = await tx.insert(s.enrichmentRuns).values(make(decision)).returning({ id: s.enrichmentRuns.id });
    if (decision.allowed && decision.overrideApprovalId) await consumeOverride(decision.overrideApprovalId, run!.id, tx);
    return { decision, runId: run!.id };
  });
  if (!res.locked) throw new Error("budget lock not acquired"); // unreachable in "wait" mode
  return res.value;
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
  await notifyMany(users.map((u) => u.id), { kind: "approval", title, body, href });
}
