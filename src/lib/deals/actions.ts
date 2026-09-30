"use server";
import { revalidatePath } from "next/cache";
import { and, asc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { normalizeDomain } from "@/lib/domain";
import { assertCan, can, dealModule, ForbiddenError, ownedEntityWhere, scopeFor } from "@/lib/rbac/server";
import { notifyMany } from "@/lib/notifications/notify";
import { toCsv } from "./csv";
import { stageSlice } from "./board-shape";
import { filledKeys, gateFieldMeta, missingFields } from "./gates";
import { getPipelineByKey, getStagesByPipeline, listActiveUsers, listDealsForBoard } from "./queries";
import { extractMentions, overrideAutoApproved, validateSplits } from "./rules";
import {
  canAssignTo,
  executiveIds,
  filterRecipientsForDeal,
  hiddenDealFields,
  loadDealForWrite,
  logActivity,
  recomputeDealHealth,
} from "./service";
import { buildDealSummary } from "./summary";
import { assertContactUsable, createContactForDeal, moveSchema, performStageMove, stageById } from "./stage-service";

export type { MoveResult } from "./stage-service";

const uuid = z.string().uuid();
const optDate = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v == null || v === "") return v === undefined ? undefined : null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid date" });
      return z.NEVER;
    }
    return d;
  });
const priorityEnum = z.enum(["top10", "high", "medium", "low"]);

function revalidateDeal(dealId: string, pipelineKey?: string) {
  revalidatePath(`/deals/${dealId}`);
  if (pipelineKey) revalidatePath(`/pipelines/${pipelineKey}`);
  revalidatePath("/pipelines");
}

/* ═════════════════════ Stage moves (KAN-1, DEAL-2/3/7) — logic lives in ./stage-service ═════════════════════ */

export const moveDealStage = action(moveSchema, async (input, user) => {
  const ctx = await loadDealForWrite(user, input.dealId, "edit");
  const res = await performStageMove(user, ctx, input, { via: "board" });
  revalidateDeal(ctx.deal.id, ctx.pipeline.key);
  return res;
});

export const bulkMoveStage = action(
  z.object({ dealIds: z.array(uuid).min(1).max(500), toStageId: uuid, reasonCode: z.string().max(120).optional(), reasonText: z.string().trim().max(2000).optional() }),
  async (input, user) => {
    const moved: string[] = [];
    const skipped: { id: string; name: string; reason: string }[] = [];
    let pipelineKey: string | undefined;
    for (const id of input.dealIds) {
      try {
        const ctx = await loadDealForWrite(user, id, "edit");
        pipelineKey = ctx.pipeline.key;
        const r = await performStageMove(user, ctx, { dealId: id, toStageId: input.toStageId, reasonCode: input.reasonCode, reasonText: input.reasonText }, { via: "bulk" });
        if (r.moved) moved.push(id);
        else if (r.pendingApproval) skipped.push({ id, name: ctx.deal.name, reason: "Stage needs approval — request sent" });
      } catch (e) {
        const [d] = await db.select({ name: s.deals.name }).from(s.deals).where(eq(s.deals.id, id));
        skipped.push({ id, name: d?.name ?? id, reason: e instanceof Error ? e.message : "Failed" });
      }
    }
    await audit({ actorId: user.id, action: "deal.bulk_stage_change", entity: "deal", after: { toStageId: input.toStageId, moved: moved.length, skipped: skipped.length } });
    if (pipelineKey) revalidatePath(`/pipelines/${pipelineKey}`);
    revalidatePath("/pipelines");
    return { moved, skipped };
  },
);

/* ═════════════════════ Assignment ═════════════════════ */

export const bulkReassign = action(z.object({ dealIds: z.array(uuid).min(1).max(500), ownerId: z.string().min(1).max(100) }), async (input, user) => {
  const [target] = await db.select({ id: s.user.id, name: s.user.name, teamId: s.user.teamId }).from(s.user).where(eq(s.user.id, input.ownerId));
  if (!target) throw new UserError("Unknown user.");
  const moved: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  let pipelineKey: string | undefined;
  for (const id of input.dealIds) {
    try {
      const ctx = await loadDealForWrite(user, id, "edit");
      pipelineKey = ctx.pipeline.key;
      await assertCan(user, dealModule(ctx.pipeline.key), "assign");
      if (!(await canAssignTo(user, ctx.pipeline.key, target.id))) throw new ForbiddenError("You can't assign deals to that person.");
      if (ctx.deal.ownerId === target.id) continue;
      await db.update(s.deals).set({ ownerId: target.id, teamId: target.teamId ?? ctx.deal.teamId }).where(eq(s.deals.id, id));
      await audit({ actorId: user.id, action: "deal.reassign", entity: "deal", entityId: id, before: { ownerId: ctx.deal.ownerId }, after: { ownerId: target.id } });
      moved.push(id);
    } catch (e) {
      skipped.push({ id, reason: e instanceof Error ? e.message : "Failed" });
    }
  }
  if (moved.length && target.id !== user.id) {
    await notifyMany([target.id], { kind: "system", title: `${user.name} assigned you ${moved.length} deal${moved.length === 1 ? "" : "s"}`, href: pipelineKey ? `/pipelines/${pipelineKey}?owner=me` : "/pipelines" });
  }
  if (pipelineKey) revalidatePath(`/pipelines/${pipelineKey}`);
  return { moved, skipped };
});

/* ═════════════════════ Create deal (DEAL-1/3, dedupe) ═════════════════════ */

export const searchAccounts = action(z.object({ q: z.string().trim().max(120) }), async ({ q }, user) => {
  const where = await ownedEntityWhere(user, "accounts", "view", s.accounts.ownerId);
  const pat = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const restrictedOk =
    user.role === "super_admin"
      ? sql`true`
      : or(
          eq(s.accounts.restricted, false),
          sql`exists (select 1 from rso.restricted_access ra where ra.entity = 'account' and ra.entity_id = ${s.accounts.id} and ra.user_id = ${user.id})`,
        )!;
  const rows = await db
    .select({ id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain, muu: s.accounts.muu, category: s.accounts.category })
    .from(s.accounts)
    .where(and(isNull(s.accounts.deletedAt), where, restrictedOk, q ? or(ilike(s.accounts.name, pat), ilike(s.accounts.domain, pat)) : undefined))
    .orderBy(asc(s.accounts.name))
    .limit(12);
  return rows;
});

const createSchema = z
  .object({
    name: z.string().trim().max(200).optional(),
    pipelineId: uuid,
    stageId: uuid,
    accountId: uuid.optional(),
    newAccount: z.object({ name: z.string().trim().min(2).max(200), domain: z.string().trim().max(200).optional() }).optional(),
    ownerId: z.string().max(100).optional(),
    muu: z.coerce.number().int().min(0).max(5_000_000_000).optional(),
    contractValue: z.coerce.number().min(0).max(1_000_000_000).optional(), // dollars
    nextStep: z.string().trim().min(3, "Describe the next step").max(500),
    nextStepDueAt: z.string().min(1, "Pick a due date"),
    priority: priorityEnum.optional(),
    source: z.string().trim().max(120).optional(),
  })
  .refine((v) => v.accountId || v.newAccount, { message: "Pick or create an account", path: ["accountId"] });

export const createDeal = action(createSchema, async (input, user) => {
  const [pipeline] = await db.select().from(s.pipelines).where(eq(s.pipelines.id, input.pipelineId));
  if (!pipeline) throw new UserError("Unknown pipeline.");
  const mod = dealModule(pipeline.key);
  await assertCan(user, mod, "create");
  const stage = await stageById(input.stageId);
  if (!stage || stage.pipelineId !== pipeline.id) throw new UserError("Pick a stage in this pipeline.");
  if (stage.category !== "open") throw new UserError("New deals must start in an open stage.");
  const due = new Date(input.nextStepDueAt);
  if (Number.isNaN(due.getTime())) throw new UserError("Next step due date is invalid.");

  const ownerId = input.ownerId || user.id;
  if (ownerId !== user.id) {
    await assertCan(user, mod, "assign");
    if (!(await canAssignTo(user, pipeline.key, ownerId))) throw new ForbiddenError("You can't assign deals to that person.");
  }
  const [owner] = await db.select({ id: s.user.id, teamId: s.user.teamId }).from(s.user).where(eq(s.user.id, ownerId));
  if (!owner) throw new UserError("Unknown owner.");

  // Account: existing (visible) or create-with-dedupe by normalized domain
  let accountId = input.accountId ?? null;
  let accountName = "";
  let accountMuu: number | null = null;
  let linkedExisting = false;
  if (accountId) {
    const where = await ownedEntityWhere(user, "accounts", "view", s.accounts.ownerId);
    const [acc] = await db.select().from(s.accounts).where(and(eq(s.accounts.id, accountId), isNull(s.accounts.deletedAt), where));
    if (!acc) throw new UserError("That account isn't available.");
    accountName = acc.name;
    accountMuu = acc.muu;
  } else if (input.newAccount) {
    const domain = input.newAccount.domain ? normalizeDomain(input.newAccount.domain) : null;
    if (input.newAccount.domain && !domain) throw new UserError("That domain doesn't look valid.");
    const existing = domain
      ? (await db.select().from(s.accounts).where(and(isNull(s.accounts.deletedAt), or(eq(s.accounts.domain, domain), sql`${domain} = any(${s.accounts.altDomains})`))))[0]
      : undefined;
    if (existing) {
      if (existing.restricted && user.role !== "super_admin") throw new UserError("An account with that domain already exists. Ask an admin for access.");
      accountId = existing.id;
      accountName = existing.name;
      accountMuu = existing.muu;
      linkedExisting = true;
    } else {
      await assertCan(user, "accounts", "create");
      const [acc] = await db
        .insert(s.accounts)
        .values({ name: input.newAccount.name, domain, website: domain ? `https://${domain}` : null, ownerId: user.id, createdBy: user.id, source: "deal_create", lifecycle: "prospect" })
        .returning();
      accountId = acc!.id;
      accountName = acc!.name;
      await audit({ actorId: user.id, action: "account.create", entity: "account", entityId: acc!.id, after: { name: acc!.name, domain } });
    }
  }

  const muu = pipeline.unit === "muu" ? (input.muu ?? accountMuu ?? null) : null;
  const contractValueCents = pipeline.unit === "usd" && input.contractValue ? Math.round(input.contractValue * 100) : null;
  const candidate = { muu, contractValueCents, nextStep: input.nextStep, nextStepDueAt: due, primaryContactId: null, customFields: {} };
  const missing = missingFields(stage, filledKeys(candidate, stage.requiredFields));
  if (missing.length) throw new UserError(`${stage.name} requires ${missing.map((k) => gateFieldMeta(k).label).join(", ")} — start in an earlier stage and move it once filled.`);

  const name = input.name?.trim() || `${accountName}${pipeline.key === "R100" ? " — RTB100" : ""}`;
  const dealId = await db.transaction(async (tx) => {
    const [deal] = await tx
      .insert(s.deals)
      .values({
        name,
        pipelineId: pipeline.id,
        stageId: stage.id,
        status: "open",
        accountId,
        ownerId,
        teamId: owner.teamId,
        priority: input.priority ?? null,
        source: input.source || "manual",
        nextStep: input.nextStep,
        nextStepDueAt: due,
        muu,
        contractValueCents,
        stageEnteredAt: new Date(),
        createdBy: user.id,
      })
      .returning({ id: s.deals.id });
    await tx.insert(s.dealStageHistory).values({ dealId: deal!.id, fromStageId: null, toStageId: stage.id, changedBy: user.id, reason: "created" });
    await logActivity({ type: "system", subject: "Deal created", body: `Created in ${stage.name}`, actorId: user.id, dealId: deal!.id, accountId }, tx);
    return deal!.id;
  });
  await audit({ actorId: user.id, action: "deal.create", entity: "deal", entityId: dealId, after: { name, pipeline: pipeline.key, stage: stage.key, ownerId, accountId } });
  await recomputeDealHealth(dealId);
  if (ownerId !== user.id) await notifyMany([ownerId], { kind: "system", title: `${user.name} assigned you ${name}`, href: `/deals/${dealId}` });
  revalidatePath(`/pipelines/${pipeline.key}`);
  revalidatePath("/pipelines");
  return { id: dealId, linkedExisting, accountName };
});

/* ═════════════════════ Inline edits ═════════════════════ */

const quickSchema = z.object({
  dealId: uuid,
  patch: z.object({
    name: z.string().trim().min(2).max(200).optional(),
    nextStep: z.string().trim().max(500).nullable().optional(),
    nextStepDueAt: optDate,
    nextStepWaitingReason: z.string().trim().max(300).nullable().optional(),
    priority: priorityEnum.nullable().optional(),
    ownerId: z.string().max(100).optional(),
    expectedCloseDate: optDate,
    source: z.string().trim().max(120).nullable().optional(),
  }),
});

/** Next step / due / priority / owner / name / close date (list inline edit, record header). Enforces DEAL-3. */
export const updateDealQuick = action(quickSchema, async ({ dealId, patch }, user) => {
  const ctx = await loadDealForWrite(user, dealId, "edit");
  const upd: Partial<typeof s.deals.$inferInsert> = {};
  if (patch.name !== undefined) upd.name = patch.name;
  if (patch.nextStep !== undefined) upd.nextStep = patch.nextStep || null;
  if (patch.nextStepDueAt !== undefined) upd.nextStepDueAt = patch.nextStepDueAt;
  if (patch.nextStepWaitingReason !== undefined) upd.nextStepWaitingReason = patch.nextStepWaitingReason || null;
  if (patch.priority !== undefined) upd.priority = patch.priority;
  if (patch.expectedCloseDate !== undefined) upd.expectedCloseDate = patch.expectedCloseDate;
  if (patch.source !== undefined) upd.source = patch.source || null;
  if (patch.ownerId !== undefined && patch.ownerId !== ctx.deal.ownerId) {
    await assertCan(user, dealModule(ctx.pipeline.key), "assign");
    if (!(await canAssignTo(user, ctx.pipeline.key, patch.ownerId))) throw new ForbiddenError("You can't assign deals to that person.");
    const [o] = await db.select({ teamId: s.user.teamId }).from(s.user).where(eq(s.user.id, patch.ownerId));
    if (!o) throw new UserError("Unknown owner.");
    upd.ownerId = patch.ownerId;
    upd.teamId = o.teamId ?? ctx.deal.teamId;
  }
  // DEAL-3: open deals need next step + due date, or an explicit waiting reason
  const next = { ...ctx.deal, ...upd };
  if (ctx.stage.category === "open" && (!next.nextStep || !next.nextStepDueAt) && !next.nextStepWaitingReason) {
    throw new UserError("Open deals need a next step with a due date — or a waiting reason (e.g. “Waiting on client until 15 Oct”).");
  }
  if (Object.keys(upd).length === 0) return { ok: true };
  await db.update(s.deals).set(upd).where(eq(s.deals.id, dealId));
  const before = Object.fromEntries(Object.keys(upd).map((k) => [k, (ctx.deal as Record<string, unknown>)[k]]));
  await audit({ actorId: user.id, action: "deal.update", entity: "deal", entityId: dealId, before, after: upd });
  if (upd.ownerId && upd.ownerId !== user.id) await notifyMany([upd.ownerId], { kind: "system", title: `${user.name} assigned you ${next.name}`, href: `/deals/${dealId}` });
  await recomputeDealHealth(dealId);
  revalidateDeal(dealId, ctx.pipeline.key);
  return { ok: true };
});

const valueSchema = z.object({
  dealId: uuid,
  patch: z.object({
    muu: z.coerce.number().int().min(0).max(5_000_000_000).nullable().optional(),
    usdPerMuu: z.coerce.number().min(0).max(1000).nullable().optional(),
    revSharePct: z.coerce.number().min(0).max(100).nullable().optional(), // UI percent 0..100
    guaranteeType: z.string().trim().max(120).nullable().optional(),
    guaranteeMonthly: z.coerce.number().min(0).max(100_000_000).nullable().optional(), // dollars
    rampMonths: z.coerce.number().int().min(0).max(60).nullable().optional(),
    termYears: z.coerce.number().min(0).max(30).nullable().optional(),
    contractValue: z.coerce.number().min(0).max(1_000_000_000).nullable().optional(),
    annualizedValue: z.coerce.number().min(0).max(1_000_000_000).nullable().optional(),
    nextPayment: z.coerce.number().min(0).max(1_000_000_000).nullable().optional(),
    nextPaymentAt: optDate,
    renewalAt: optDate,
  }),
});

const VALUE_FIELD_MAP: Record<string, string> = { guaranteeMonthly: "guaranteeMonthlyCents", contractValue: "contractValueCents", annualizedValue: "annualizedValueCents", nextPayment: "nextPaymentCents" };

/** Type-specific value fields (MUU terms, ADS billing). Rejects writes to fields hidden for the role. */
export const updateDealValues = action(valueSchema, async ({ dealId, patch }, user) => {
  const ctx = await loadDealForWrite(user, dealId, "edit");
  const upd: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const col = VALUE_FIELD_MAP[k] ?? k;
    if (ctx.hidden.has(col)) throw new ForbiddenError(`Your role can't edit ${gateFieldMeta(col).label}.`);
    if (col.endsWith("Cents")) upd[col] = v == null ? null : Math.round((v as number) * 100);
    else if (col === "revSharePct") upd[col] = v == null ? null : (v as number) / 100;
    else upd[col] = v;
  }
  if (!Object.keys(upd).length) return { ok: true };
  await db.update(s.deals).set(upd).where(eq(s.deals.id, dealId));
  const before = Object.fromEntries(Object.keys(upd).map((k) => [k, (ctx.deal as Record<string, unknown>)[k]]));
  await audit({ actorId: user.id, action: "deal.update_values", entity: "deal", entityId: dealId, before, after: upd });
  await logActivity({ type: "field_change", subject: "Value fields updated", body: Object.keys(upd).map((k) => gateFieldMeta(k).label).join(", "), actorId: user.id, dealId, accountId: ctx.deal.accountId });
  revalidateDeal(dealId, ctx.pipeline.key);
  return { ok: true };
});

const r100Schema = z.object({
  dealId: uuid,
  r100: z.object({
    firstPostDate: z.string().max(40).nullable().optional(),
    participation: z.array(z.boolean()).max(12).optional(),
    postCount: z.coerce.number().int().min(0).max(100000).optional(),
    profileUrl: z.string().trim().url().max(500).nullable().optional().or(z.literal("")),
    editorialLinks: z.array(z.string().trim().url().max(500)).max(20).optional(),
    bonusEligible: z.boolean().optional(),
  }),
});

export const updateR100 = action(r100Schema, async ({ dealId, r100 }, user) => {
  const ctx = await loadDealForWrite(user, dealId, "edit");
  if (ctx.pipeline.key !== "R100") throw new UserError("Not a Roundtable 100 deal.");
  const next = { ...(ctx.deal.r100 ?? {}), ...r100, profileUrl: r100.profileUrl === "" ? null : (r100.profileUrl ?? ctx.deal.r100?.profileUrl ?? null) };
  await db.update(s.deals).set({ r100: next }).where(eq(s.deals.id, dealId));
  await audit({ actorId: user.id, action: "deal.update_r100", entity: "deal", entityId: dealId, before: ctx.deal.r100, after: next });
  revalidateDeal(dealId, ctx.pipeline.key);
  return { ok: true };
});

/* ═════════════════════ Splits (DEAL-6) ═════════════════════ */

export const setSplits = action(
  z.object({ dealId: uuid, splits: z.array(z.object({ userId: z.string().min(1).max(100), pct: z.coerce.number(), role: z.enum(["owner", "sourcer", "closer", "collaborator"]).default("owner") })).max(10) }),
  async ({ dealId, splits }, user) => {
    const ctx = await loadDealForWrite(user, dealId, "edit");
    const err = validateSplits(splits);
    if (err) throw new UserError(err);
    const current = new Set(ctx.splitUserIds);
    const newcomers = splits.map((x) => x.userId).filter((id) => !current.has(id) && id !== user.id);
    if (newcomers.length) {
      await assertCan(user, dealModule(ctx.pipeline.key), "assign");
      for (const id of newcomers) if (!(await canAssignTo(user, ctx.pipeline.key, id))) throw new ForbiddenError("You can't add that person to the split.");
    }
    const users = await db.select({ id: s.user.id }).from(s.user).where(inArray(s.user.id, splits.map((x) => x.userId)));
    if (users.length !== splits.length) throw new UserError("Unknown user in splits.");
    await db.transaction(async (tx) => {
      await tx.delete(s.dealSplits).where(eq(s.dealSplits.dealId, dealId));
      await tx.insert(s.dealSplits).values(splits.map((x) => ({ dealId, userId: x.userId, pct: x.pct, role: x.role })));
    });
    await audit({ actorId: user.id, action: "deal.splits", entity: "deal", entityId: dealId, before: ctx.splitUserIds, after: splits });
    revalidateDeal(dealId, ctx.pipeline.key);
    return { ok: true };
  },
);

/* ═════════════════════ Timeline ═════════════════════ */

export const logDealActivity = action(
  z.object({
    dealId: uuid,
    type: z.enum(["note", "call", "meeting", "email", "linkedin"]),
    subject: z.string().trim().max(300).optional(),
    body: z.string().trim().max(20_000).optional(),
    occurredAt: optDate,
    durationMin: z.coerce.number().int().min(0).max(1440).optional(),
    contactId: uuid.optional().or(z.literal("")),
    direction: z.enum(["inbound", "outbound"]).optional(),
    pinned: z.boolean().optional(),
  }),
  async (input, user) => {
    if (!input.subject && !input.body) throw new UserError("Add a subject or some notes.");
    const ctx = await loadDealForWrite(user, input.dealId, "view");
    await assertCan(user, "activities", "create");
    if (input.contactId) await assertContactUsable(user, ctx.deal.accountId, input.contactId);
    const id = await logActivity({
      type: input.type,
      subject: input.subject || null,
      body: input.body || null,
      occurredAt: input.occurredAt ?? new Date(),
      durationMin: input.durationMin ?? null,
      contactId: input.contactId || null,
      direction: input.direction ?? null,
      pinned: input.pinned ?? false,
      actorId: user.id,
      dealId: ctx.deal.id,
      accountId: ctx.deal.accountId,
    });
    await audit({ actorId: user.id, action: "activity.create", entity: "activity", entityId: id, after: { dealId: ctx.deal.id, type: input.type } });
    await recomputeDealHealth(ctx.deal.id);
    revalidateDeal(ctx.deal.id, ctx.pipeline.key);
    return { id };
  },
);

export const toggleActivityPin = action(z.object({ activityId: uuid }), async ({ activityId }, user) => {
  const [a] = await db.select({ id: s.activities.id, dealId: s.activities.dealId, pinned: s.activities.pinned }).from(s.activities).where(eq(s.activities.id, activityId));
  if (!a?.dealId) throw new UserError("Activity not found.");
  const ctx = await loadDealForWrite(user, a.dealId, "edit");
  await db.update(s.activities).set({ pinned: !a.pinned }).where(eq(s.activities.id, activityId));
  await audit({ actorId: user.id, action: a.pinned ? "activity.unpin" : "activity.pin", entity: "activity", entityId: activityId });
  revalidateDeal(a.dealId, ctx.pipeline.key);
  return { pinned: !a.pinned };
});

/* ═════════════════════ Tasks (CARD-5) ═════════════════════ */

export const createDealTask = action(
  z.object({
    dealId: uuid,
    title: z.string().trim().min(2).max(300),
    description: z.string().trim().max(5000).optional(),
    dueAt: optDate,
    assigneeId: z.string().max(100).optional(),
    priority: priorityEnum.optional(),
    owedBy: z.enum(["us", "them"]).optional(),
  }),
  async (input, user) => {
    const ctx = await loadDealForWrite(user, input.dealId, "view");
    await assertCan(user, "tasks", "create");
    const assigneeId = input.assigneeId || user.id;
    if (assigneeId !== user.id) {
      const scope = await scopeFor(user, "tasks", "assign");
      const ok = scope === "all" || scope === "pipeline" || (scope === "team" && user.teamMemberIds.includes(assigneeId)) || assigneeId === ctx.deal.ownerId;
      if (!ok) throw new ForbiddenError("You can't assign tasks to that person.");
    }
    const [t] = await db
      .insert(s.tasks)
      .values({
        title: input.title,
        description: input.description || null,
        dueAt: input.dueAt ?? null,
        assigneeId,
        createdBy: user.id,
        dealId: ctx.deal.id,
        accountId: ctx.deal.accountId,
        priority: input.priority ?? "medium",
        owedBy: input.owedBy ?? "us",
        origin: "manual",
      })
      .returning({ id: s.tasks.id });
    await audit({ actorId: user.id, action: "task.create", entity: "task", entityId: t!.id, after: { dealId: ctx.deal.id, title: input.title, assigneeId } });
    if (assigneeId !== user.id) {
      const recipients = await filterRecipientsForDeal(ctx.deal, [assigneeId]);
      await notifyMany(recipients, { kind: "system", title: `New task: ${input.title}`, body: ctx.deal.name, href: `/deals/${ctx.deal.id}` });
    }
    await recomputeDealHealth(ctx.deal.id);
    revalidateDeal(ctx.deal.id, ctx.pipeline.key);
    return { id: t!.id };
  },
);

export const setTaskStatus = action(z.object({ taskId: uuid, status: z.enum(["open", "done"]) }), async ({ taskId, status }, user) => {
  const [t] = await db.select().from(s.tasks).where(eq(s.tasks.id, taskId));
  if (!t?.dealId) throw new UserError("Task not found.");
  const ctx = await loadDealForWrite(user, t.dealId, "view");
  const editScope = await scopeFor(user, "tasks", "edit");
  const mine = t.assigneeId === user.id || t.createdBy === user.id;
  const ok = editScope === "all" || editScope === "pipeline" || (editScope === "team" && (user.teamMemberIds.includes(t.assigneeId ?? "") || mine)) || (editScope === "own" && mine) || ctx.deal.ownerId === user.id;
  if (!ok) throw new ForbiddenError();
  await db.update(s.tasks).set({ status, completedAt: status === "done" ? new Date() : null }).where(eq(s.tasks.id, taskId));
  await audit({ actorId: user.id, action: status === "done" ? "task.complete" : "task.reopen", entity: "task", entityId: taskId });
  await recomputeDealHealth(t.dealId);
  revalidateDeal(t.dealId, ctx.pipeline.key);
  return { ok: true };
});

/* ═════════════════════ Stakeholders (CARD-4) ═════════════════════ */

const roleEnum = z.enum(["decision_maker", "champion", "influencer", "finance", "legal", "tech", "blocker"]).nullable();

export const addStakeholder = action(
  z.object({ dealId: uuid, contactId: uuid.optional(), newContact: moveSchema.shape.newContact, role: roleEnum.optional(), makePrimary: z.boolean().optional() }),
  async (input, user) => {
    const ctx = await loadDealForWrite(user, input.dealId, "edit");
    let contactId = input.contactId;
    if (!contactId && input.newContact) contactId = await createContactForDeal(user, ctx.deal, input.newContact);
    if (!contactId) throw new UserError("Pick a contact.");
    await assertContactUsable(user, ctx.deal.accountId, contactId);
    await db
      .insert(s.dealContacts)
      .values({ dealId: ctx.deal.id, contactId, role: input.role ?? null })
      .onConflictDoUpdate({ target: [s.dealContacts.dealId, s.dealContacts.contactId], set: { role: input.role ?? null } });
    if (input.makePrimary || !ctx.deal.primaryContactId) await db.update(s.deals).set({ primaryContactId: contactId }).where(eq(s.deals.id, ctx.deal.id));
    await audit({ actorId: user.id, action: "deal.stakeholder_add", entity: "deal", entityId: ctx.deal.id, after: { contactId, role: input.role } });
    await recomputeDealHealth(ctx.deal.id);
    revalidateDeal(ctx.deal.id, ctx.pipeline.key);
    return { contactId };
  },
);

export const updateStakeholder = action(
  z.object({ dealId: uuid, contactId: uuid, role: roleEnum.optional(), makePrimary: z.boolean().optional(), remove: z.boolean().optional() }),
  async (input, user) => {
    const ctx = await loadDealForWrite(user, input.dealId, "edit");
    const key = and(eq(s.dealContacts.dealId, ctx.deal.id), eq(s.dealContacts.contactId, input.contactId));
    if (input.remove) {
      await db.delete(s.dealContacts).where(key);
      if (ctx.deal.primaryContactId === input.contactId) await db.update(s.deals).set({ primaryContactId: null }).where(eq(s.deals.id, ctx.deal.id));
    } else {
      if (input.role !== undefined) await db.update(s.dealContacts).set({ role: input.role }).where(key);
      if (input.makePrimary) await db.update(s.deals).set({ primaryContactId: input.contactId }).where(eq(s.deals.id, ctx.deal.id));
    }
    await audit({ actorId: user.id, action: input.remove ? "deal.stakeholder_remove" : "deal.stakeholder_update", entity: "deal", entityId: ctx.deal.id, after: input });
    await recomputeDealHealth(ctx.deal.id);
    revalidateDeal(ctx.deal.id, ctx.pipeline.key);
    return { ok: true };
  },
);

/* ═════════════════════ Documents (CARD-6) ═════════════════════ */

const docTypeEnum = z.enum(["nda", "contract", "proposal", "pro_forma", "deck", "io", "invoice", "other"]);
const docStatusEnum = z.enum(["draft", "sent", "signed", "expired"]);
const httpUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((u) => /^https:\/\//i.test(u) || /^http:\/\//i.test(u), "Use an http(s) link");

export const addDocument = action(
  z.object({ dealId: uuid, type: docTypeEnum, name: z.string().trim().min(2).max(200), url: httpUrl.optional().or(z.literal("")), status: docStatusEnum.default("draft"), signedAt: optDate, expiresAt: optDate }),
  async (input, user) => {
    const ctx = await loadDealForWrite(user, input.dealId, "edit");
    const [prev] = await db
      .select({ v: sql<number>`coalesce(max(${s.documents.version}), 0)::int` })
      .from(s.documents)
      .where(and(eq(s.documents.dealId, ctx.deal.id), eq(s.documents.type, input.type)));
    const [doc] = await db
      .insert(s.documents)
      .values({
        dealId: ctx.deal.id,
        accountId: ctx.deal.accountId,
        type: input.type,
        name: input.name,
        url: input.url || null,
        status: input.status,
        version: (prev?.v ?? 0) + 1,
        signedAt: input.signedAt ?? (input.status === "signed" ? new Date() : null),
        expiresAt: input.expiresAt ?? null,
        uploadedBy: user.id,
      })
      .returning({ id: s.documents.id });
    await audit({ actorId: user.id, action: "document.create", entity: "document", entityId: doc!.id, after: { dealId: ctx.deal.id, type: input.type, name: input.name, status: input.status } });
    await logActivity({ type: "system", subject: `Document added: ${input.name}`, body: `${input.type.toUpperCase()} · ${input.status}`, actorId: user.id, dealId: ctx.deal.id, accountId: ctx.deal.accountId });
    revalidateDeal(ctx.deal.id, ctx.pipeline.key);
    return { id: doc!.id };
  },
);

export const updateDocumentStatus = action(z.object({ documentId: uuid, status: docStatusEnum }), async ({ documentId, status }, user) => {
  const [doc] = await db.select().from(s.documents).where(eq(s.documents.id, documentId));
  if (!doc?.dealId) throw new UserError("Document not found.");
  const ctx = await loadDealForWrite(user, doc.dealId, "edit");
  await db
    .update(s.documents)
    .set({ status, signedAt: status === "signed" ? (doc.signedAt ?? new Date()) : doc.signedAt })
    .where(eq(s.documents.id, documentId));
  await audit({ actorId: user.id, action: "document.status", entity: "document", entityId: documentId, before: { status: doc.status }, after: { status } });
  revalidateDeal(doc.dealId, ctx.pipeline.key);
  return { ok: true };
});

/* ═════════════════════ Comments + @mentions (CARD-10) ═════════════════════ */

export const addComment = action(z.object({ dealId: uuid, body: z.string().trim().min(1).max(5000), mentionIds: z.array(z.string().max(100)).max(20).optional() }), async (input, user) => {
  const ctx = await loadDealForWrite(user, input.dealId, "view");
  const users = await listActiveUsers();
  const parsed = extractMentions(input.body, users);
  const ids = Array.from(new Set([...parsed, ...(input.mentionIds ?? []).filter((id) => users.some((u) => u.id === id) && input.body.includes(`@${users.find((u) => u.id === id)!.name}`))]));
  const [c] = await db.insert(s.comments).values({ entity: "deal", entityId: ctx.deal.id, authorId: user.id, body: input.body, mentions: ids }).returning({ id: s.comments.id });
  const recipients = await filterRecipientsForDeal(ctx.deal, ids.filter((id) => id !== user.id));
  await notifyMany(recipients, { kind: "mention", title: `${user.name} mentioned you on ${ctx.deal.name}`, body: input.body.slice(0, 280), href: `/deals/${ctx.deal.id}#comments` });
  await audit({ actorId: user.id, action: "comment.create", entity: "deal", entityId: ctx.deal.id, after: { commentId: c!.id, mentions: ids } });
  revalidateDeal(ctx.deal.id);
  return { id: c!.id, notified: recipients.length };
});

/* ═════════════════════ Probability override (DEAL-4) ═════════════════════ */

export const requestProbabilityOverride = action(
  z.object({ dealId: uuid, pct: z.coerce.number().min(0).max(100), reason: z.string().trim().min(5, "Explain the override").max(1000) }),
  async ({ dealId, pct, reason }, user) => {
    const ctx = await loadDealForWrite(user, dealId, "edit");
    const auto = overrideAutoApproved(user.role);
    const probability = pct / 100;
    await db.transaction(async (tx) => {
      await tx
        .update(s.deals)
        .set({ probabilityOverride: probability, overrideReason: reason, overrideStatus: auto ? "approved" : "pending", overrideApprovedBy: auto ? user.id : null })
        .where(eq(s.deals.id, dealId));
      // supersede earlier pending requests
      await tx
        .update(s.approvals)
        .set({ status: "rejected", note: "Superseded by a newer request", decidedAt: new Date(), decidedBy: user.id })
        .where(and(eq(s.approvals.kind, "probability_override"), eq(s.approvals.entityId, dealId), eq(s.approvals.status, "pending")));
      if (!auto) {
        await tx.insert(s.approvals).values({
          kind: "probability_override",
          entity: "deal",
          entityId: dealId,
          requestedBy: user.id,
          approverRole: "executive",
          payload: { from: ctx.stage.probability, previousOverride: ctx.deal.probabilityOverride, to: probability, reason, dealName: ctx.deal.name },
        });
      }
    });
    if (!auto) {
      const recipients = await filterRecipientsForDeal(ctx.deal, await executiveIds());
      await notifyMany(recipients, { kind: "approval", title: `Probability override needs approval: ${ctx.deal.name}`, body: `${Math.round(ctx.stage.probability * 100)}% → ${pct}% — ${reason}`, href: `/deals/${dealId}` });
    }
    await audit({ actorId: user.id, action: auto ? "deal.override_set" : "deal.override_requested", entity: "deal", entityId: dealId, before: { probabilityOverride: ctx.deal.probabilityOverride, overrideStatus: ctx.deal.overrideStatus }, after: { probabilityOverride: probability, reason, status: auto ? "approved" : "pending" } });
    await logActivity({ type: "field_change", subject: `Probability override ${auto ? "set" : "requested"}: ${pct}%`, body: reason, actorId: user.id, dealId, accountId: ctx.deal.accountId });
    revalidateDeal(dealId, ctx.pipeline.key);
    return { status: auto ? "approved" : "pending" };
  },
);

export const clearProbabilityOverride = action(z.object({ dealId: uuid }), async ({ dealId }, user) => {
  const ctx = await loadDealForWrite(user, dealId, "edit");
  await db.update(s.deals).set({ probabilityOverride: null, overrideReason: null, overrideStatus: null, overrideApprovedBy: null }).where(eq(s.deals.id, dealId));
  await db
    .update(s.approvals)
    .set({ status: "rejected", note: "Override withdrawn", decidedAt: new Date(), decidedBy: user.id })
    .where(and(eq(s.approvals.kind, "probability_override"), eq(s.approvals.entityId, dealId), eq(s.approvals.status, "pending")));
  await audit({ actorId: user.id, action: "deal.override_cleared", entity: "deal", entityId: dealId, before: { probabilityOverride: ctx.deal.probabilityOverride } });
  revalidateDeal(dealId, ctx.pipeline.key);
  return { ok: true };
});

/** Executives approve/reject a pending override from the record page (the approvals inbox can reuse this). */
export const decideProbabilityOverride = action(z.object({ dealId: uuid, approve: z.boolean(), note: z.string().trim().max(1000).optional() }), async ({ dealId, approve, note }, user) => {
  if (!overrideAutoApproved(user.role)) throw new ForbiddenError("Only executives can approve overrides.");
  const ctx = await loadDealForWrite(user, dealId, "view");
  if (ctx.deal.overrideStatus !== "pending") throw new UserError("No pending override on this deal.");
  await db.transaction(async (tx) => {
    await tx
      .update(s.deals)
      .set(approve ? { overrideStatus: "approved", overrideApprovedBy: user.id } : { overrideStatus: "rejected", overrideApprovedBy: user.id })
      .where(eq(s.deals.id, dealId));
    await tx
      .update(s.approvals)
      .set({ status: approve ? "approved" : "rejected", decidedBy: user.id, decidedAt: new Date(), note: note ?? null })
      .where(and(eq(s.approvals.kind, "probability_override"), eq(s.approvals.entityId, dealId), eq(s.approvals.status, "pending")));
  });
  const [req] = await db.select({ requestedBy: s.approvals.requestedBy }).from(s.approvals).where(and(eq(s.approvals.kind, "probability_override"), eq(s.approvals.entityId, dealId))).orderBy(sql`${s.approvals.createdAt} desc`).limit(1);
  if (req && req.requestedBy !== user.id) await notifyMany([req.requestedBy], { kind: "approval", title: `Override ${approve ? "approved" : "rejected"}: ${ctx.deal.name}`, body: note ?? null, href: `/deals/${dealId}` });
  await audit({ actorId: user.id, action: approve ? "deal.override_approved" : "deal.override_rejected", entity: "deal", entityId: dealId, after: { note } });
  revalidateDeal(dealId, ctx.pipeline.key);
  return { ok: true };
});

/* ═════════════════════ AI summary (CARD-2) ═════════════════════ */

export const refreshAiSummary = action(z.object({ dealId: uuid }), async ({ dealId }, user) => {
  const ctx = await loadDealForWrite(user, dealId, "view");
  const allowAi = await can(user, "copilot", "use_ai");
  const summary = await buildDealSummary({ dealId, userId: user.id, allowAi, hiddenFields: await hiddenDealFields(user.role) });
  await db.update(s.deals).set({ aiSummary: JSON.stringify(summary), aiSummaryAt: new Date(summary.generatedAt) }).where(eq(s.deals.id, dealId));
  await audit({ actorId: user.id, action: "deal.ai_summary", entity: "deal", entityId: dealId, after: { engine: summary.engine } });
  revalidateDeal(dealId, ctx.pipeline.key);
  return { engine: summary.engine };
});

/* ═════════════════════ Export (KAN-5, permissioned) ═════════════════════ */

const filtersSchema = z
  .object({
    q: z.string().max(120).optional(),
    owner: z.string().max(100).optional(),
    priority: z.enum(["top10", "high", "medium", "low", "none"]).optional(),
    category: z.string().max(80).optional(),
    overdue: z.boolean().optional(),
    status: z.enum(["open", "won", "lost", "hold"]).optional(),
  })
  .default({});

/** "Show more" on a Kanban column (KAN-8): next slice of a stage's cards with the same filters. */
export const loadStageDeals = action(
  z.object({ pipelineKey: z.string().max(40), stageId: uuid, filters: filtersSchema, offset: z.number().int().min(0).max(100_000), limit: z.number().int().min(1).max(200).default(100) }),
  async ({ pipelineKey, stageId, filters, offset, limit }, user) => {
    const all = await listDealsForBoard(user, pipelineKey, filters);
    return stageSlice(all, stageId, offset, limit);
  },
);

export const exportDealsCsv = action(
  z.object({
    pipelineKey: z.string().max(40),
    filters: filtersSchema,
    dealIds: z.array(uuid).max(5000).optional(),
  }),
  async ({ pipelineKey, filters, dealIds }, user) => {
    const pipeline = await getPipelineByKey(pipelineKey);
    if (!pipeline) throw new UserError("Unknown pipeline.");
    const exportScope = await assertCan(user, dealModule(pipelineKey), "export");
    const stagesBy = await getStagesByPipeline();
    const hidden = await hiddenDealFields(user.role);
    const stageName = new Map((stagesBy[pipeline.id] ?? []).map((st) => [st.id, st.name]));
    let deals = await listDealsForBoard(user, pipelineKey, filters);
    deals = deals.filter((d) => !d.restricted); // MNPI never leaves via export
    if (dealIds?.length) {
      const set = new Set(dealIds);
      deals = deals.filter((d) => set.has(d.id));
    }
    if (exportScope !== "all" && exportScope !== "pipeline") {
      deals = deals.filter((d) =>
        exportScope === "team" ? d.owners.some((o) => user.teamMemberIds.includes(o.id)) : d.owners.some((o) => o.id === user.id),
      );
    }
    const showNet = !hidden.has("revSharePct");
    const headers = ["Deal", "Account", "Domain", "Stage", "Status", "Owner", "Priority", "MUU", "Gross USD", ...(showNet ? ["Net USD"] : []), "Probability", "Weighted USD", "Next step", "Next step due", "Days in stage", "Health", "Deal ID"];
    const rows = deals.map((d) => [
      d.name,
      d.accountName,
      d.accountDomain,
      stageName.get(d.stageId) ?? "",
      d.status,
      d.owners[0]?.name ?? "",
      d.priority ?? "",
      pipeline.unit === "muu" ? d.muu : "",
      Math.round(d.grossUsd),
      ...(showNet ? [Math.round(d.netUsd ?? 0)] : []),
      Math.round(d.probability * 100) + "%",
      Math.round(d.weightedUsd),
      d.nextStep,
      d.nextStepDueAt?.slice(0, 10) ?? "",
      d.daysInStage,
      d.healthScore ?? "",
      d.id,
    ]);
    await audit({ actorId: user.id, action: "deal.export", entity: "pipeline", entityId: pipelineKey, after: { count: rows.length, filters } });
    return { filename: `${pipelineKey.toLowerCase()}-deals-${new Date().toISOString().slice(0, 10)}.csv`, csv: toCsv(headers, rows), count: rows.length };
  },
);

/* ═════════════════════ Lookups for dialogs ═════════════════════ */

/** Contacts on the deal's account the user can see (gate dialog "primary contact", stakeholder picker). */
export const getDealContacts = action(z.object({ dealId: uuid }), async ({ dealId }, user) => {
  const ctx = await loadDealForWrite(user, dealId, "view");
  if (!ctx.deal.accountId) return [];
  const where = await ownedEntityWhere(user, "contacts", "view", s.contacts.ownerId);
  return db
    .select({ id: s.contacts.id, name: s.contacts.fullName, title: s.contacts.title, email: s.contacts.email })
    .from(s.contacts)
    .where(and(eq(s.contacts.accountId, ctx.deal.accountId), isNull(s.contacts.deletedAt), where))
    .orderBy(asc(s.contacts.fullName))
    .limit(200);
});
