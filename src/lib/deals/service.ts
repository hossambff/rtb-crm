import "server-only";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import type { Role } from "@/lib/rbac/model";
import { assertCan, dealAccessWhere, dealModule, ForbiddenError, getHiddenFields, inScope, scopeFor, type AppUser } from "@/lib/rbac/server";
import { UserError } from "@/lib/actions";
import { computeHealth } from "./health";
import { ensureMigrationProject } from "@/lib/onboarding/service";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = typeof db | Tx;

/* ───────────── Field-level security ───────────── */

/** Deal fields hidden for a role: code defaults (DEFAULT_HIDDEN_FIELDS) + admin overrides in rso.field_permissions. */
export const hiddenDealFields = (role: Role): Promise<Set<string>> => getHiddenFields(role, "deal");

/** Remove hidden keys from a deal-shaped object (server-side, before anything reaches the client). */
export function stripHidden<T extends Record<string, unknown>>(obj: T, hidden: Set<string>): T {
  if (hidden.size === 0) return obj;
  const out = { ...obj };
  for (const f of hidden) delete (out as Record<string, unknown>)[f];
  return out;
}

/* ───────────── Loading a deal for a write ───────────── */

export type DealWriteContext = {
  deal: typeof s.deals.$inferSelect;
  pipeline: typeof s.pipelines.$inferSelect;
  stage: typeof s.stages.$inferSelect;
  splitUserIds: string[];
  hidden: Set<string>;
};

/**
 * Load a deal the user can SEE (dealAccessWhere incl. restricted access list) and assert `action` scope on the
 * pipeline's deal module + that the record is inside that scope. Throws ForbiddenError / UserError.
 */
export async function loadDealForWrite(user: AppUser, dealId: string, action: "edit" | "assign" | "view" = "edit"): Promise<DealWriteContext> {
  const where = await dealAccessWhere(user, "view");
  const [row] = await db
    .select({ deal: s.deals, pipeline: s.pipelines, stage: s.stages })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .where(and(eq(s.deals.id, dealId), where));
  if (!row) throw new UserError("Deal not found.");
  const splits = await db.select({ userId: s.dealSplits.userId }).from(s.dealSplits).where(eq(s.dealSplits.dealId, dealId));
  const splitUserIds = splits.map((x) => x.userId);
  const scope = await assertCan(user, dealModule(row.pipeline.key), action);
  if (!inScope(user, scope, { ownerId: row.deal.ownerId, teamId: row.deal.teamId, splitUserIds, pipelineKey: row.pipeline.key })) {
    throw new ForbiddenError();
  }
  return { ...row, splitUserIds, hidden: await hiddenDealFields(user.role) };
}

/** Can `user` assign deals in this pipeline to `targetUserId`? (assign scope: all/pipeline → anyone, team → team, own → self). */
export async function canAssignTo(user: AppUser, pipelineKey: string, targetUserId: string | null): Promise<boolean> {
  if (!targetUserId || targetUserId === user.id) return true;
  const scope = await scopeFor(user, dealModule(pipelineKey), "assign");
  if (scope === "all" || scope === "pipeline") return true;
  if (scope === "team") return user.teamMemberIds.includes(targetUserId);
  return false;
}

/* ───────────── Activities ───────────── */

export type LogActivityInput = {
  type: (typeof s.activityType.enumValues)[number];
  source?: (typeof s.activitySource.enumValues)[number];
  subject?: string | null;
  body?: string | null;
  direction?: "inbound" | "outbound" | null;
  occurredAt?: Date;
  durationMin?: number | null;
  actorId: string | null;
  dealId?: string | null;
  accountId?: string | null;
  contactId?: string | null;
  emailMessageId?: string | null;
  transcriptId?: string | null;
  meetingId?: string | null;
  metadata?: Record<string, unknown>;
  pinned?: boolean;
};

const TOUCH_TYPES = new Set(["email", "call", "meeting", "note", "linkedin", "stage_change", "agent"]);
const CONTACT_TOUCH_TYPES = new Set(["email", "call", "meeting", "linkedin"]);

/**
 * Insert an activity and bump deals.last_activity_at (for real touches, never backwards) and
 * contacts.last_contacted_at. Callers are responsible for permission checks. Returns the new activity id.
 */
export async function logActivity(input: LogActivityInput, tx: DbOrTx = db): Promise<string> {
  const occurredAt = input.occurredAt ?? new Date();
  let accountId = input.accountId ?? null;
  if (!accountId && input.dealId) {
    const [d] = await tx.select({ accountId: s.deals.accountId }).from(s.deals).where(eq(s.deals.id, input.dealId));
    accountId = d?.accountId ?? null;
  }
  const [row] = await tx
    .insert(s.activities)
    .values({
      type: input.type,
      source: input.source ?? "manual",
      subject: input.subject ?? null,
      body: input.body ?? null,
      direction: input.direction ?? null,
      occurredAt,
      durationMin: input.durationMin ?? null,
      actorId: input.actorId,
      dealId: input.dealId ?? null,
      accountId,
      contactId: input.contactId ?? null,
      emailMessageId: input.emailMessageId ?? null,
      transcriptId: input.transcriptId ?? null,
      meetingId: input.meetingId ?? null,
      metadata: input.metadata ?? {},
      pinned: input.pinned ?? false,
    })
    .returning({ id: s.activities.id });
  const at = occurredAt.toISOString(); // raw Date objects are not serialized inside sql`` templates
  if (input.dealId && TOUCH_TYPES.has(input.type)) {
    await tx
      .update(s.deals)
      .set({ lastActivityAt: sql`greatest(coalesce(${s.deals.lastActivityAt}, ${at}::timestamptz), ${at}::timestamptz)` })
      .where(eq(s.deals.id, input.dealId));
  }
  if (input.contactId && CONTACT_TOUCH_TYPES.has(input.type)) {
    await tx
      .update(s.contacts)
      .set({ lastContactedAt: sql`greatest(coalesce(${s.contacts.lastContactedAt}, ${at}::timestamptz), ${at}::timestamptz)` })
      .where(eq(s.contacts.id, input.contactId));
  }
  return row!.id;
}

/* ───────────── Health ───────────── */

/** Recompute + persist the health score for one deal (call after any deal mutation). Safe to call from any module. */
export async function recomputeDealHealth(dealId: string, tx: DbOrTx = db): Promise<{ score: number | null; explanation: string } | null> {
  const [row] = await tx
    .select({ deal: s.deals, stage: s.stages })
    .from(s.deals)
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .where(eq(s.deals.id, dealId));
  if (!row) return null;
  const now = new Date();
  const roles = await tx.select({ role: s.dealContacts.role }).from(s.dealContacts).where(eq(s.dealContacts.dealId, dealId));
  const [overdue] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(s.tasks)
    .where(and(eq(s.tasks.dealId, dealId), eq(s.tasks.status, "open"), lt(s.tasks.dueAt, now)));
  const h = computeHealth({
    now,
    category: row.stage.category,
    createdAt: row.deal.createdAt,
    stageEnteredAt: row.deal.stageEnteredAt,
    slaDays: row.stage.slaDays,
    lastActivityAt: row.deal.lastActivityAt,
    nextStep: row.deal.nextStep,
    nextStepDueAt: row.deal.nextStepDueAt,
    nextStepWaitingReason: row.deal.nextStepWaitingReason,
    stakeholderRoles: roles.map((r) => r.role),
    overdueTaskCount: overdue?.n ?? 0,
    imported: row.deal.tags?.includes("imported") ?? false,
  });
  if (h.score !== row.deal.healthScore || h.explanation !== row.deal.healthExplanation) {
    await tx.update(s.deals).set({ healthScore: h.score, healthExplanation: h.explanation }).where(eq(s.deals.id, dealId));
  }
  return { score: h.score, explanation: h.explanation };
}

/**
 * Batch recompute for cron / backfill (e.g. nightly, or after an import). Sequential on purpose (pooler-friendly).
 * Pass a pipeline id to limit scope; returns how many deals were processed.
 */
export async function recomputeHealthForDeals(opts: { pipelineId?: string; limit?: number } = {}): Promise<number> {
  const rows = await db
    .select({ id: s.deals.id })
    .from(s.deals)
    .where(and(sql`${s.deals.deletedAt} is null`, eq(s.deals.status, "open"), opts.pipelineId ? eq(s.deals.pipelineId, opts.pipelineId) : undefined))
    .limit(opts.limit ?? 10_000);
  for (const r of rows) await recomputeDealHealth(r.id);
  return rows.length;
}

/* ───────────── Notifications ───────────── */

export async function notify(userIds: string[], n: { kind: string; title: string; body?: string | null; href?: string | null }, tx: DbOrTx = db) {
  const ids = Array.from(new Set(userIds)).filter(Boolean);
  if (!ids.length) return;
  await tx.insert(s.notifications).values(ids.map((userId) => ({ userId, kind: n.kind, title: n.title, body: n.body ?? null, href: n.href ?? null })));
}

/** For restricted deals, only users on the access list (or super admins) may be notified about it. */
export async function filterRecipientsForDeal(deal: { id: string; restricted: boolean }, userIds: string[]): Promise<string[]> {
  if (!deal.restricted || userIds.length === 0) return userIds;
  const access = await db
    .select({ u: s.restrictedAccess.userId })
    .from(s.restrictedAccess)
    .where(and(eq(s.restrictedAccess.entity, "deal"), eq(s.restrictedAccess.entityId, deal.id), inArray(s.restrictedAccess.userId, userIds)));
  const admins = await db.select({ u: s.user.id }).from(s.user).where(and(inArray(s.user.id, userIds), eq(s.user.role, "super_admin")));
  const ok = new Set([...access.map((a) => a.u), ...admins.map((a) => a.u)]);
  return userIds.filter((u) => ok.has(u));
}

/* ───────────── Won side-effects (DEAL-7) ───────────── */

/** NET/ENT/SPT won → migration project (once). ADS won → invoice from next payment (once per due date). */
export async function onDealWon(ctx: { deal: typeof s.deals.$inferSelect; pipelineKey: string; actorId: string }, tx: DbOrTx) {
  const { deal, pipelineKey } = ctx;
  const created: string[] = [];
  if (["NET", "ENT", "SPT"].includes(pipelineKey)) {
    // Single path with the Programs module (idempotent; returns the existing project if there is one).
    const res = await ensureMigrationProject(deal.id, { actorId: ctx.actorId }, tx);
    if (res?.created) created.push("migration_project");
  }
  if (pipelineKey === "ADS" && deal.nextPaymentCents && deal.nextPaymentAt) {
    const [existing] = await tx
      .select({ id: s.invoices.id })
      .from(s.invoices)
      .where(and(eq(s.invoices.dealId, deal.id), eq(s.invoices.dueAt, deal.nextPaymentAt)));
    if (!existing) {
      await tx.insert(s.invoices).values({ dealId: deal.id, amountCents: deal.nextPaymentCents, dueAt: deal.nextPaymentAt, status: "scheduled" });
      created.push("invoice");
    }
  }
  return created;
}

/** Users who can approve probability overrides (executives). */
export async function executiveIds(): Promise<string[]> {
  const rows = await db.select({ id: s.user.id }).from(s.user).where(and(eq(s.user.role, "executive"), sql`coalesce(${s.user.banned}, false) = false`));
  return rows.map((r) => r.id);
}

