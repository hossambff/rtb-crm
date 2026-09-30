import "server-only";
import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealValue } from "@/lib/pipeline-math";
import { LIVE_STAGE_KEYS, type R100Json } from "@/lib/r100/calc";
import {
  clawbackDue,
  clawbackKey,
  keyFromNote,
  keyNote,
  normalizeRules,
  periodOf,
  planAccruals,
  recipientsFor,
  type AccrualDraft,
  type CommissionEvent,
  type Trigger,
} from "./calc";

export * from "./calc";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AccrualRunResult = { created: number; createdCents: number; clawbacks: number; clawbackCents: number; expiredRegistrations: number; assignments: number };

/**
 * Accrual engine (PRD COM-1..4). Idempotent: every row carries a stable key in `note`; re-runs never duplicate.
 * For each active assignment × rule: find qualifying events since effectiveFrom, credit deal splits (default owner 100%),
 * apply monthly caps, write `commission_accruals`; then write clawback offsets for deals lost within `clawbackDays`.
 * Safe to call from a cron route handler (pass actorId null) or the "Run accruals" button.
 */
export async function accrueCommissions(opts: { actorId: string | null; now?: Date } = { actorId: null }): Promise<AccrualRunResult> {
  // One run at a time: a transaction-scoped advisory lock serializes concurrent runs (button + cron).
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('rso.commission_accruals'))`);
    return runAccruals(tx, opts);
  });
}

async function runAccruals(q: Tx, opts: { actorId: string | null; now?: Date }): Promise<AccrualRunResult> {
  const now = opts.now ?? new Date();
  const result: AccrualRunResult = { created: 0, createdCents: 0, clawbacks: 0, clawbackCents: 0, expiredRegistrations: 0, assignments: 0 };

  result.expiredRegistrations = await expireRegistrationsWith(q, now);

  const assignments = await db
    .select({ a: s.commissionAssignments, plan: s.commissionPlans })
    .from(s.commissionAssignments)
    .innerJoin(s.commissionPlans, eq(s.commissionPlans.id, s.commissionAssignments.planId))
    .where(eq(s.commissionPlans.active, true));
  result.assignments = assignments.length;
  if (!assignments.length) return result;

  const triggers = new Set<Trigger>();
  let since = now;
  for (const { a, plan } of assignments) {
    for (const r of normalizeRules(plan.rules)) triggers.add(r.trigger);
    if (a.effectiveFrom < since) since = a.effectiveFrom;
  }
  const events = await collectEvents(q, triggers, since, now);

  for (const { a, plan } of assignments) {
    const rules = normalizeRules(plan.rules);
    if (!rules.length) continue;
    const existing = await db
      .select({ note: s.commissionAccruals.note, period: s.commissionAccruals.period, amountCents: s.commissionAccruals.amountCents })
      .from(s.commissionAccruals)
      .where(and(eq(s.commissionAccruals.userId, a.userId), eq(s.commissionAccruals.planId, plan.id)));
    const existingKeys = new Set<string>();
    const periodTotals = new Map<string, number>();
    for (const e of existing) {
      const key = keyFromNote(e.note);
      if (!key) continue;
      existingKeys.add(key);
      if (key.startsWith("clawback|")) continue;
      const capKey = `${key.split("|")[0]}|${e.period}`;
      periodTotals.set(capKey, (periodTotals.get(capKey) ?? 0) + e.amountCents);
    }
    const drafts = planAccruals({ userId: a.userId, planId: plan.id, planName: plan.name, effectiveFrom: a.effectiveFrom, rules, events, existingKeys, periodTotals });
    if (drafts.length) {
      await insertDrafts(q, drafts);
      result.created += drafts.length;
      result.createdCents += drafts.reduce((acc, d) => acc + d.amountCents, 0);
    }

    // Clawbacks: positive accruals on deals that were lost within the rule's window.
    const rulesWithClawback = rules.map((r, i) => ({ r, i })).filter(({ r }) => (r.clawbackDays ?? 0) > 0);
    if (!rulesWithClawback.length) continue;
    const candidates = await db
      .select({
        acc: s.commissionAccruals,
        dealStatus: s.deals.status,
        lostAt: s.deals.lostAt,
        wonAt: s.deals.wonAt,
        r100: s.deals.r100,
        paidAt: s.invoices.paidAt,
      })
      .from(s.commissionAccruals)
      .innerJoin(s.deals, eq(s.deals.id, s.commissionAccruals.dealId))
      .leftJoin(s.invoices, eq(s.invoices.id, s.commissionAccruals.invoiceId))
      .where(
        and(
          eq(s.commissionAccruals.userId, a.userId),
          eq(s.commissionAccruals.planId, plan.id),
          gt(s.commissionAccruals.amountCents, 0),
          eq(s.deals.status, "lost"),
          isNotNull(s.deals.lostAt),
        ),
      );
    const clawDrafts: AccrualDraft[] = [];
    for (const c of candidates) {
      const key = keyFromNote(c.acc.note);
      if (!key || existingKeys.has(clawbackKey(key))) continue;
      const ruleIdx = Number(key.split("|")[0]);
      const rule = rulesWithClawback.find((x) => x.i === ruleIdx)?.r;
      if (!rule) continue;
      const eventAt =
        c.acc.trigger === "invoice_paid"
          ? c.paidAt
          : c.acc.trigger === "r100_live"
            ? (c.r100 as R100Json)?.firstPostDate
              ? new Date((c.r100 as R100Json).firstPostDate!)
              : c.wonAt
            : c.wonAt;
      if (!clawbackDue({ eventAt, lostAt: c.lostAt, clawbackDays: rule.clawbackDays })) continue;
      const ck = clawbackKey(key);
      existingKeys.add(ck);
      clawDrafts.push({
        key: ck,
        userId: a.userId,
        planId: plan.id,
        dealId: c.acc.dealId,
        invoiceId: c.acc.invoiceId,
        trigger: c.acc.trigger,
        amountCents: -c.acc.amountCents,
        status: "clawed_back",
        period: periodOf(c.lostAt!),
        note: keyNote(ck, `Clawback: deal lost within ${rule.clawbackDays} days`),
      });
    }
    if (clawDrafts.length) {
      await insertDrafts(q, clawDrafts);
      result.clawbacks += clawDrafts.length;
      result.clawbackCents += clawDrafts.reduce((acc, d) => acc + d.amountCents, 0);
    }
  }

  await q.insert(s.auditLog).values({
    actorId: opts.actorId,
    actorKind: opts.actorId ? "user" : "system",
    action: "commissions.run_accruals",
    entity: "commission_accruals",
    after: result as never,
  });
  return result;
}

async function insertDrafts(q: Tx, drafts: AccrualDraft[]) {
  for (let i = 0; i < drafts.length; i += 200) {
    await q.insert(s.commissionAccruals).values(
      drafts.slice(i, i + 200).map((d) => ({
        userId: d.userId,
        planId: d.planId,
        dealId: d.dealId,
        invoiceId: d.invoiceId,
        trigger: d.trigger,
        amountCents: d.amountCents,
        status: d.status,
        period: d.period,
        note: d.note,
      })),
    );
  }
}

/** Approved registrations past protectedUntil → expired (PRD COM-6 "expires automatically"). */
export async function expireRegistrations(now = new Date()): Promise<number> {
  return expireRegistrationsWith(db, now);
}

async function expireRegistrationsWith(q: Tx | typeof db, now: Date): Promise<number> {
  const rows = await db
    .update(s.leadRegistrations)
    .set({ status: "expired" })
    .where(and(eq(s.leadRegistrations.status, "approved"), isNotNull(s.leadRegistrations.protectedUntil), lt(s.leadRegistrations.protectedUntil, now)))
    .returning({ id: s.leadRegistrations.id });
  return rows.length;
}

type DealInfo = {
  id: string;
  name: string;
  ownerId: string | null;
  pipelineKey: string;
  unit: "muu" | "usd" | "activation";
  contractCents: number;
  netCents: number;
};

async function loadDeals(q: Tx, ids: string[]): Promise<Map<string, DealInfo & { recipients: { userId: string; pct: number }[] }>> {
  const out = new Map<string, DealInfo & { recipients: { userId: string; pct: number }[] }>();
  if (!ids.length) return out;
  const unique = Array.from(new Set(ids));
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = await db
      .select({ d: s.deals, p: s.pipelines })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .where(inArray(s.deals.id, chunk));
    const splits = await q.select().from(s.dealSplits).where(inArray(s.dealSplits.dealId, chunk));
    for (const { d, p } of rows) {
      const v = dealValue({
        unit: p.unit,
        muu: d.muu,
        usdPerMuu: d.usdPerMuu,
        pipelineUsdPerMuu: p.usdPerMuu,
        revSharePct: d.revSharePct,
        pipelineRevSharePct: p.defaultRevSharePct,
        contractValueCents: d.contractValueCents,
        annualizedValueCents: d.annualizedValueCents,
        stageProbability: 1,
      });
      out.set(d.id, {
        id: d.id,
        name: d.name,
        ownerId: d.ownerId,
        pipelineKey: p.key,
        unit: p.unit,
        contractCents: d.contractValueCents ?? d.annualizedValueCents ?? Math.round(v.grossUsd * 100),
        netCents: Math.round(v.netUsd * 100),
        recipients: recipientsFor(
          d.ownerId,
          splits.filter((x) => x.dealId === d.id).map((x) => ({ userId: x.userId, pct: x.pct })),
        ),
      });
    }
  }
  return out;
}

/** Collect qualifying events for the requested triggers since `since`. */
async function collectEvents(q: Tx, triggers: Set<Trigger>, since: Date, now: Date): Promise<CommissionEvent[]> {
  const events: CommissionEvent[] = [];

  if (triggers.has("deal_won")) {
    const won = await db
      .select({ id: s.deals.id, wonAt: s.deals.wonAt })
      .from(s.deals)
      .where(and(eq(s.deals.status, "won"), isNull(s.deals.deletedAt), isNotNull(s.deals.wonAt), gte(s.deals.wonAt, since)));
    const deals = await loadDeals(q, won.map((w) => w.id));
    for (const w of won) {
      const d = deals.get(w.id);
      if (!d || d.unit === "activation") continue;
      events.push({ trigger: "deal_won", sourceId: d.id, at: w.wonAt!, pipelineKey: d.pipelineKey, dealId: d.id, contractCents: d.contractCents, netCents: d.netCents, recipients: d.recipients, label: `${d.name} won` });
    }
  }

  if (triggers.has("invoice_paid")) {
    const paid = await db
      .select({ id: s.invoices.id, dealId: s.invoices.dealId, amountCents: s.invoices.amountCents, paidAt: s.invoices.paidAt })
      .from(s.invoices)
      .where(and(eq(s.invoices.status, "paid"), isNotNull(s.invoices.paidAt), gte(s.invoices.paidAt, since)));
    const deals = await loadDeals(q, paid.map((p) => p.dealId));
    for (const p of paid) {
      const d = deals.get(p.dealId);
      if (!d) continue;
      events.push({
        trigger: "invoice_paid",
        sourceId: p.id,
        at: p.paidAt!,
        pipelineKey: d.pipelineKey,
        dealId: d.id,
        invoiceId: p.id,
        contractCents: p.amountCents,
        netCents: p.amountCents,
        recipients: d.recipients,
        label: `${d.name} invoice paid`,
      });
    }
  }

  if (triggers.has("r100_live")) {
    const rows = await db
      .select({ id: s.deals.id, r100: s.deals.r100, wonAt: s.deals.wonAt })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
      .where(and(eq(s.pipelines.key, "R100"), isNull(s.deals.deletedAt), or(eq(s.stages.category, "won"), inArray(s.stages.key, LIVE_STAGE_KEYS))));
    const eligible = rows.filter((r) => {
      const j = (r.r100 ?? {}) as R100Json;
      if (j.bonusEligible === false) return false;
      if (!j.firstPostDate) return false;
      const at = new Date(j.firstPostDate);
      return !Number.isNaN(at.getTime()) && at >= since && at <= now;
    });
    const deals = await loadDeals(q, eligible.map((r) => r.id));
    for (const r of eligible) {
      const d = deals.get(r.id);
      if (!d) continue;
      const j = r.r100 as R100Json;
      events.push({
        trigger: "r100_live",
        sourceId: d.id,
        at: new Date(j.firstPostDate!),
        pipelineKey: "R100",
        dealId: d.id,
        contractCents: j.bonusCents ?? 0,
        netCents: j.bonusCents ?? 0,
        recipients: d.recipients,
        label: `${d.name} live on RTB100`,
      });
    }
  }

  if (triggers.has("migration_launched")) {
    const rows = await db
      .select({ id: s.migrationProjects.id, dealId: s.migrationProjects.dealId, name: s.migrationProjects.name, actualGoLive: s.migrationProjects.actualGoLive, updatedAt: s.migrationProjects.updatedAt })
      .from(s.migrationProjects)
      .where(and(eq(s.migrationProjects.launched, true), isNotNull(s.migrationProjects.dealId)));
    const deals = await loadDeals(q, rows.map((r) => r.dealId!));
    for (const r of rows) {
      const at = r.actualGoLive ?? r.updatedAt;
      if (at < since) continue;
      const d = deals.get(r.dealId!);
      if (!d) continue;
      events.push({ trigger: "migration_launched", sourceId: r.id, at, pipelineKey: d.pipelineKey, dealId: d.id, contractCents: d.contractCents, netCents: d.netCents, recipients: d.recipients, label: `${r.name} launched` });
    }
  }

  if (triggers.has("meeting_held")) {
    const rows = await db
      .select({ id: s.activities.id, actorId: s.activities.actorId, dealId: s.activities.dealId, subject: s.activities.subject, occurredAt: s.activities.occurredAt, pipelineKey: s.pipelines.key })
      .from(s.activities)
      .leftJoin(s.deals, eq(s.deals.id, s.activities.dealId))
      .leftJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .where(and(eq(s.activities.type, "meeting"), sql`${s.activities.metadata}->>'held' = 'true'`, gte(s.activities.occurredAt, since), isNotNull(s.activities.actorId)));
    for (const r of rows) {
      events.push({
        trigger: "meeting_held",
        sourceId: r.id,
        at: r.occurredAt,
        pipelineKey: r.pipelineKey ?? null,
        dealId: r.dealId,
        contractCents: 0,
        netCents: 0,
        recipients: [{ userId: r.actorId!, pct: 100 }],
        label: `Meeting held${r.subject ? `: ${r.subject.slice(0, 80)}` : ""}`,
      });
    }
  }

  return events;
}
