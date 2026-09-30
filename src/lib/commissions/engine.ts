import "server-only";
import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db, withXactLock, type Executor, type Tx } from "@/db";
import * as s from "@/db/schema";
import { dealValue } from "@/lib/pipeline-math";
import { LIVE_STAGE_KEYS, type R100Json } from "@/lib/r100/calc";
import {
  capKeyOf,
  clawbackDue,
  clawbackEventAt,
  clawbackKey,
  isClawbackKey,
  normalizeRules,
  periodOf,
  planAccruals,
  recipientsFor,
  ruleIdFromKey,
  type AccrualDraft,
  type CommissionEvent,
  type Trigger,
} from "./calc";

export * from "./calc";

export type AccrualRunResult = {
  created: number;
  createdCents: number;
  clawbacks: number;
  clawbackCents: number;
  expiredRegistrations: number;
  assignments: number;
  /** Another run held the lock; this call did nothing (it doesn't queue behind it holding a pooled connection). */
  alreadyRunning?: boolean;
};

/**
 * Accrual engine (PRD COM-1..4). Idempotent: every row carries a stable `source_key` (see calc.ts `accrualKey`) backed
 * by a unique index and inserted with ON CONFLICT DO NOTHING; re-runs and plan edits never duplicate (CR-01).
 * For each active assignment × rule: find qualifying events since effectiveFrom, credit deal splits (default owner 100%),
 * apply monthly caps, write `commission_accruals`; then write clawback offsets for deals lost within `clawbackDays`.
 * Safe to call from a cron route handler (pass actorId null) or the "Run accruals" button.
 */
export async function accrueCommissions(opts: { actorId: string | null; now?: Date } = { actorId: null }): Promise<AccrualRunResult> {
  // One run at a time (H-03): ONE transaction holding a transaction-scoped advisory lock (valid behind the Supavisor
  // transaction pooler); every query of the run goes through `tx`, so the run needs exactly one pooled connection and
  // commits or rolls back as a whole. A concurrent run returns immediately instead of queueing on the lock.
  const res = await withXactLock("rso.commission_accruals", (tx) => runAccruals(tx, opts), "try");
  if (!res.locked) return { created: 0, createdCents: 0, clawbacks: 0, clawbackCents: 0, expiredRegistrations: 0, assignments: 0, alreadyRunning: true };
  return res.value;
}

async function runAccruals(q: Tx, opts: { actorId: string | null; now?: Date }): Promise<AccrualRunResult> {
  const now = opts.now ?? new Date();
  const result: AccrualRunResult = { created: 0, createdCents: 0, clawbacks: 0, clawbackCents: 0, expiredRegistrations: 0, assignments: 0 };

  result.expiredRegistrations = await expireRegistrationsWith(q, now);

  const assignments = await q
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
    const existing = await q
      .select({ sourceKey: s.commissionAccruals.sourceKey, period: s.commissionAccruals.period, amountCents: s.commissionAccruals.amountCents })
      .from(s.commissionAccruals)
      .where(and(eq(s.commissionAccruals.userId, a.userId), eq(s.commissionAccruals.planId, plan.id), isNotNull(s.commissionAccruals.sourceKey)));
    const existingKeys = new Set<string>();
    const periodTotals = new Map<string, number>();
    for (const e of existing) {
      const key = e.sourceKey!;
      existingKeys.add(key);
      if (isClawbackKey(key)) continue;
      const ruleId = ruleIdFromKey(key);
      if (!ruleId) continue;
      const capKey = capKeyOf(ruleId, e.period);
      periodTotals.set(capKey, (periodTotals.get(capKey) ?? 0) + e.amountCents);
    }
    const drafts = planAccruals({ userId: a.userId, planId: plan.id, planName: plan.name, effectiveFrom: a.effectiveFrom, rules, events, existingKeys, periodTotals });
    if (drafts.length) {
      const written = await insertDrafts(q, drafts);
      result.created += written.length;
      result.createdCents += written.reduce((acc, d) => acc + d.amountCents, 0);
    }

    // Clawbacks: positive accruals on deals that were lost within the rule's window.
    const rulesWithClawback = rules.filter((r) => (r.clawbackDays ?? 0) > 0);
    if (!rulesWithClawback.length) continue;
    // H-02: the event time of a `deal_won` accrual is the deal's LAST win before it was lost. stage-service clears
    // `won_at` when a deal leaves a won stage, so read the win from deal_stage_history (a won-category target stage
    // entered at or before lost_at). `migration_launched` uses the project's go-live; `invoice_paid` the payment date.
    const lastWinAt = sql<Date | null>`(
      select max(h.changed_at) from ${s.dealStageHistory} h join ${s.stages} st on st.id = h.to_stage_id
      where h.deal_id = ${s.deals.id} and st.category = 'won' and h.changed_at <= ${s.deals.lostAt})`;
    const goLiveAt = sql<Date | null>`(
      select coalesce(mp.actual_go_live, mp.updated_at) from ${s.migrationProjects} mp where mp.deal_id = ${s.deals.id} limit 1)`;
    const candidates = await q
      .select({
        acc: s.commissionAccruals,
        dealStatus: s.deals.status,
        lostAt: s.deals.lostAt,
        lastWinAt: lastWinAt.mapWith((v: string | Date | null) => (v ? new Date(v) : null)),
        goLiveAt: goLiveAt.mapWith((v: string | Date | null) => (v ? new Date(v) : null)),
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
          isNotNull(s.commissionAccruals.sourceKey),
          eq(s.deals.status, "lost"),
          isNotNull(s.deals.lostAt),
        ),
      );
    const clawDrafts: AccrualDraft[] = [];
    for (const c of candidates) {
      const key = c.acc.sourceKey!;
      if (isClawbackKey(key) || existingKeys.has(clawbackKey(key))) continue;
      const ruleId = ruleIdFromKey(key);
      const rule = rulesWithClawback.find((r) => r.id === ruleId);
      if (!rule) continue;
      const eventAt = clawbackEventAt({
        trigger: c.acc.trigger,
        paidAt: c.paidAt,
        firstPostDate: (c.r100 as R100Json)?.firstPostDate ?? null,
        goLiveAt: c.goLiveAt,
        lastWinAt: c.lastWinAt,
        accruedAt: c.acc.createdAt,
      });
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
        note: `Clawback: deal lost within ${rule.clawbackDays} days`,
      });
    }
    if (clawDrafts.length) {
      const written = await insertDrafts(q, clawDrafts);
      result.clawbacks += written.length;
      result.clawbackCents += written.reduce((acc, d) => acc + d.amountCents, 0);
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

/** Insert drafts; rows whose (user, plan, source_key) already exists are skipped by the unique index. Returns the rows written. */
async function insertDrafts(q: Tx, drafts: AccrualDraft[]) {
  const written: { amountCents: number }[] = [];
  for (let i = 0; i < drafts.length; i += 200) {
    const rows = await q
      .insert(s.commissionAccruals)
      .values(
        drafts.slice(i, i + 200).map((d) => ({
          userId: d.userId,
          planId: d.planId,
          dealId: d.dealId,
          invoiceId: d.invoiceId,
          trigger: d.trigger,
          amountCents: d.amountCents,
          status: d.status,
          period: d.period,
          sourceKey: d.key,
          note: d.note,
        })),
      )
      .onConflictDoNothing()
      .returning({ amountCents: s.commissionAccruals.amountCents });
    written.push(...rows);
  }
  return written;
}

/** Approved registrations past protectedUntil → expired (PRD COM-6 "expires automatically"). */
export async function expireRegistrations(now = new Date()): Promise<number> {
  return expireRegistrationsWith(db, now);
}

async function expireRegistrationsWith(q: Executor, now: Date): Promise<number> {
  const rows = await q
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
    const rows = await q
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
    const won = await q
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
    const paid = await q
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
    const rows = await q
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
    const rows = await q
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
    const rows = await q
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
