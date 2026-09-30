import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, type Executor, type Tx } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { logServerError } from "@/lib/errors";
import { requestApproval } from "@/lib/approvals/service";
import { SCOPE_RANK } from "@/lib/rbac/model";
import { assertCan, dealModule, ForbiddenError, inScope, ownedEntityWhere, scopeFor, type AppUser } from "@/lib/rbac/server";
import { isLive } from "@/lib/r100/calc";
import { filledKeys, GATE_FIELDS, gateFieldMeta, missingFields, needsReason, parseGateValue, reasonPicklist } from "./gates";
import { getPicklist } from "./queries";
import { loadDealForWrite, logActivity, onDealWon, recomputeDealHealth, type DealWriteContext } from "./service";
import type { StageDTO } from "./types";

/**
 * The ONE stage-change path (board drag, record stage path, bulk moves, post-call Apply, Copilot, stage_gate approvals):
 * gates + required fields, won/lost/hold reasons, stage history, activity, won automation (onboarding / invoices /
 * R100 first-post date), approval-gated stages, audit and health recompute.
 */

const uuid = z.string().uuid();
export async function stageById(stageId: string): Promise<(StageDTO & { pipelineId: string; requiresApproval: boolean }) | null> {
  const [st] = await db.select().from(s.stages).where(eq(s.stages.id, stageId));
  return st
    ? { id: st.id, key: st.key, name: st.name, sortOrder: st.sortOrder, probability: st.probability, category: st.category, slaDays: st.slaDays, requiredFields: st.requiredFields, pipelineId: st.pipelineId, requiresApproval: st.requiresApproval }
    : null;
}

/* ═════════════════════ Stage moves (KAN-1, DEAL-2/3/7) ═════════════════════ */

export const moveSchema = z.object({
  dealId: uuid,
  toStageId: uuid,
  /** Gate-dialog values keyed by field (dollars for usd, 0-100 for percent, ISO for dates, contact id). */
  fields: z.record(z.string().max(60), z.string().max(2000)).optional(),
  newContact: z.object({ fullName: z.string().trim().min(2).max(120), email: z.string().trim().email().max(200).optional().or(z.literal("")), title: z.string().trim().max(120).optional() }).optional(),
  reasonCode: z.string().max(120).optional(),
  reasonText: z.string().trim().max(2000).optional(),
});
export type MoveInput = z.infer<typeof moveSchema>;

export type MoveResult = { moved: boolean; stageId: string; status: string; created: string[]; health: number | null; pendingApproval?: boolean };

export type MoveOptions = {
  /** Skip the requiresApproval gate (the stage_gate approval handler, after an approver said yes). */
  approved?: boolean;
  /** Where the move came from (stored on the activity + audit). */
  via?: "board" | "call_review" | "copilot" | "approval" | "bulk" | "r100";
  /**
   * Extra writes that must commit atomically with the move (e.g. the stage_gate approval flipping its own status).
   * Runs inside the move's transaction, after the deal row is locked; use `tx` for every query. Throwing rolls back the move.
   */
  withinTx?: (tx: Tx) => Promise<void>;
};

export async function createContactForDeal(user: AppUser, deal: { accountId: string | null }, c: NonNullable<MoveInput["newContact"]>) {
  await assertCan(user, "contacts", "create");
  return insertContactForDeal(db, user, deal, c);
}

/** Insert (no permission check — callers assert contacts.create first) + audit, on `q` (pass the move's transaction). */
async function insertContactForDeal(q: Executor, user: AppUser, deal: { accountId: string | null }, c: NonNullable<MoveInput["newContact"]>) {
  const [first, ...rest] = c.fullName.split(/\s+/);
  const [row] = await q
    .insert(s.contacts)
    .values({ accountId: deal.accountId, fullName: c.fullName, firstName: first ?? null, lastName: rest.join(" ") || null, email: c.email || null, title: c.title || null, ownerId: user.id, origin: "manual" })
    .returning({ id: s.contacts.id });
  await audit({ actorId: user.id, action: "contact.create", entity: "contact", entityId: row!.id, after: { fullName: c.fullName, accountId: deal.accountId } }, q);
  return row!.id;
}

/** Ensure a contact id is on the deal's account and visible to the user. */
export async function assertContactUsable(user: AppUser, accountId: string | null, contactId: string) {
  const where = await ownedEntityWhere(user, "contacts", "view", s.contacts.ownerId);
  const [c] = await db
    .select({ id: s.contacts.id, accountId: s.contacts.accountId })
    .from(s.contacts)
    .where(and(eq(s.contacts.id, contactId), isNull(s.contacts.deletedAt), where));
  if (!c) throw new UserError("That contact isn't available.");
  if (accountId && c.accountId && c.accountId !== accountId) throw new UserError("The contact belongs to a different account.");
}

/** Core stage transition used by drag-and-drop, the record stage path and bulk moves. */
export async function performStageMove(user: AppUser, ctx: DealWriteContext, input: MoveInput, opts: MoveOptions = {}): Promise<MoveResult> {
  const target = await stageById(input.toStageId);
  if (!target || target.pipelineId !== ctx.deal.pipelineId) throw new UserError("That stage belongs to a different pipeline.");
  if (target.id === ctx.deal.stageId) {
    if (opts.withinTx) await db.transaction(opts.withinTx);
    return { moved: false, stageId: target.id, status: ctx.deal.status, created: [], health: ctx.deal.healthScore };
  }

  // 1. Apply gate-dialog field values
  const patch: Record<string, unknown> = {};
  const customPatch: Record<string, unknown> = {};
  const custom: Record<string, unknown> = { ...(ctx.deal.customFields ?? {}) };
  for (const [key, raw] of Object.entries(input.fields ?? {})) {
    if (!raw.trim()) continue;
    if (ctx.hidden.has(key)) throw new ForbiddenError(`Your role can't edit ${gateFieldMeta(key).label}.`);
    const meta = gateFieldMeta(key);
    if (meta.kind === "contact") {
      if (!uuid.safeParse(raw).success) throw new UserError("Pick a primary contact.");
      await assertContactUsable(user, ctx.deal.accountId, raw);
      patch.primaryContactId = raw;
      continue;
    }
    const parsed = parseGateValue(meta.kind, raw);
    if (parsed === undefined) throw new UserError(`${meta.label} is invalid.`);
    if (key in GATE_FIELDS) patch[key] = meta.kind === "number" && ["muu", "rampMonths"].includes(key) ? Math.round(parsed as number) : parsed;
    else custom[key] = customPatch[key] = parsed instanceof Date ? parsed.toISOString() : parsed;
  }
  if (input.newContact) await assertCan(user, "contacts", "create");

  // 2. Gates (a new inline contact counts as the primary contact; it is created only once everything validates)
  const merged = { ...ctx.deal, ...patch, ...(input.newContact ? { primaryContactId: "pending-new-contact" } : {}), customFields: custom } as Record<string, unknown> & {
    customFields: Record<string, unknown>;
  };
  const missing = missingFields(target, filledKeys(merged, target.requiredFields));
  if (missing.length) {
    const hiddenMissing = missing.filter((k) => ctx.hidden.has(k));
    if (hiddenMissing.length) throw new UserError(`${target.name} requires ${hiddenMissing.map((k) => gateFieldMeta(k).label).join(", ")} — ask a manager to complete it.`);
    throw new UserError(`${target.name} requires: ${missing.map((k) => gateFieldMeta(k).label).join(", ")}.`);
  }
  let reason: string | null = null;
  if (needsReason(target.category)) {
    const list = reasonPicklist(target.category);
    if (list) {
      const options = await getPicklist(list);
      if (!input.reasonCode || !options.some((o) => o.value === input.reasonCode)) throw new UserError(`Pick a ${target.category} reason.`);
      reason = input.reasonText ? `${input.reasonCode}: ${input.reasonText}` : input.reasonCode;
    } else {
      if (!input.reasonText) throw new UserError("Add a short note on why this deal was won.");
      reason = input.reasonText;
    }
  }

  // 2b. Approval-gated stage: users without approve scope on this deal request it (stage_gate) instead of moving.
  if (target.requiresApproval && !opts.approved && !(await canSelfApprove(user, ctx))) {
    const [pending] = await db
      .select({ id: s.approvals.id })
      .from(s.approvals)
      .where(and(eq(s.approvals.kind, "stage_gate"), eq(s.approvals.entityId, ctx.deal.id), eq(s.approvals.status, "pending")));
    if (!pending) {
      await requestApproval({
        kind: "stage_gate",
        entity: "deal",
        entityId: ctx.deal.id,
        requestedBy: user.id,
        approverRole: "sales_leader",
        title: `Stage approval: ${ctx.deal.name} → ${target.name}`,
        note: reason,
        payload: {
          dealName: ctx.deal.name,
          fromStageId: ctx.stage.id,
          toStageId: target.id,
          toStage: target.name,
          reasonCode: input.reasonCode ?? null,
          reasonText: input.reasonText ?? null,
          fields: input.fields ?? {},
          newContact: input.newContact ?? null,
          via: opts.via ?? "board",
        },
      });
      await audit({ actorId: user.id, action: "deal.stage_change_requested", entity: "deal", entityId: ctx.deal.id, before: { stageId: ctx.stage.id }, after: { stageId: target.id, reason } });
    }
    return { moved: false, stageId: ctx.stage.id, status: ctx.deal.status, created: [], health: ctx.deal.healthScore, pendingApproval: true };
  }

  // 3. Write — ONE transaction: lock the deal row, re-check it is still where the user saw it (H-11: a double submit or
  // a concurrent move becomes a no-op / a "reload" error instead of running won side-effects twice), then write.
  const now = new Date();
  const from = ctx.stage;
  const update: Partial<typeof s.deals.$inferInsert> = {
    ...(patch as Partial<typeof s.deals.$inferInsert>),
    stageId: target.id,
    stageEnteredAt: now,
    status: target.category,
  };
  // wonAt is cleared when a deal leaves a won stage (won analytics read status + wonAt); the original win stays in
  // deal_stage_history, which the commissions clawback reads (H-02).
  update.wonAt = target.category === "won" ? (ctx.deal.wonAt ?? now) : null; // re-opened deals no longer count as won
  if (target.category === "lost") {
    update.lostAt = now;
    update.lostReason = reason;
  }
  if (target.category === "hold") update.holdReason = reason;
  if (target.category === "open") {
    update.lostAt = null;
    update.holdReason = null;
  }
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(s.deals).where(and(eq(s.deals.id, ctx.deal.id), isNull(s.deals.deletedAt))).for("update");
    if (!locked) throw new UserError("Deal not found.");
    if (locked.stageId === target.id) {
      await opts.withinTx?.(tx);
      return { noop: true as const, deal: locked };
    }
    if (locked.stageId !== ctx.deal.stageId) throw new UserError("This deal was moved by someone else in the meantime. Reload and try again.");
    // JSON columns: merge onto the LOCKED row (not the snapshot the checks ran on), so concurrent edits aren't lost.
    update.customFields = Object.keys(customPatch).length ? { ...(locked.customFields ?? {}), ...customPatch } : locked.customFields;
    // R100: reaching a live/won stage stamps the first-post date once (same rule as the R100 program board).
    if (ctx.pipeline.key === "R100" && isLive(target)) {
      const r100 = { ...((locked.r100 ?? {}) as NonNullable<typeof locked.r100>) };
      if (!r100.firstPostDate) {
        r100.firstPostDate = now.toISOString().slice(0, 10);
        update.r100 = r100;
      }
    }
    if (input.newContact) patch.primaryContactId = update.primaryContactId = await insertContactForDeal(tx, user, ctx.deal, input.newContact);
    const [updated] = await tx.update(s.deals).set(update).where(eq(s.deals.id, ctx.deal.id)).returning();
    await tx.insert(s.dealStageHistory).values({ dealId: ctx.deal.id, fromStageId: from.id, toStageId: target.id, changedBy: user.id, reason });
    if (patch.primaryContactId) {
      await tx.insert(s.dealContacts).values({ dealId: ctx.deal.id, contactId: patch.primaryContactId as string, role: null }).onConflictDoNothing();
    }
    await logActivity(
      {
        type: "stage_change",
        source: "manual",
        subject: `${from.name} → ${target.name}`,
        body: reason,
        actorId: user.id,
        dealId: ctx.deal.id,
        accountId: ctx.deal.accountId,
        metadata: { fromStageId: from.id, toStageId: target.id, category: target.category, via: opts.via ?? "board" },
      },
      tx,
    );
    // Won side-effects are idempotent on their own too (unique migration_projects(deal_id), invoices.source_key).
    const created = target.category === "won" ? await onDealWon({ deal: updated!, pipelineKey: ctx.pipeline.key, actorId: user.id }, tx) : [];
    await audit(
      {
        actorId: user.id,
        action: "deal.stage_change",
        entity: "deal",
        entityId: ctx.deal.id,
        before: { stageId: from.id, stage: from.name, status: ctx.deal.status },
        after: { stageId: target.id, stage: target.name, status: target.category, reason, fields: Object.keys(patch), created, via: opts.via ?? "board" },
      },
      tx,
    );
    await opts.withinTx?.(tx);
    return { noop: false as const, created };
  });
  if (result.noop) return { moved: false, stageId: target.id, status: result.deal.status, created: [], health: result.deal.healthScore };

  // After commit: never throw (the move succeeded; an error here would invite a retry).
  let health: number | null = null;
  try {
    health = (await recomputeDealHealth(ctx.deal.id))?.score ?? null;
  } catch (e) {
    logServerError("stage-move.health", e);
  }
  return { moved: true, stageId: target.id, status: target.category, created: result.created, health };
}

/** Approve scope ≥ own on the deal's pipeline with the deal in scope → the user may pass an approval-gated stage directly. */
async function canSelfApprove(user: AppUser, ctx: DealWriteContext): Promise<boolean> {
  const scope = await scopeFor(user, dealModule(ctx.pipeline.key), "approve");
  if (SCOPE_RANK[scope] < SCOPE_RANK.own) return false;
  return inScope(user, scope, { ownerId: ctx.deal.ownerId, teamId: ctx.deal.teamId, splitUserIds: ctx.splitUserIds, pipelineKey: ctx.pipeline.key });
}

/**
 * Convenience wrapper for other modules: permission-checked load (edit scope) + the full stage move.
 * `toStage` is a stage id or a stage key within the deal's pipeline.
 */
export async function moveDealToStage(
  user: AppUser,
  dealId: string,
  toStage: { id?: string; key?: string },
  input: Omit<MoveInput, "dealId" | "toStageId"> = {},
  opts: MoveOptions = {},
): Promise<MoveResult & { stageName: string; pipelineKey: string }> {
  const ctx = await loadDealForWrite(user, dealId, "edit");
  let toStageId = toStage.id;
  if (!toStageId && toStage.key) {
    const [st] = await db.select({ id: s.stages.id }).from(s.stages).where(and(eq(s.stages.pipelineId, ctx.deal.pipelineId), eq(s.stages.key, toStage.key)));
    if (!st) throw new UserError(`Unknown stage "${toStage.key}".`);
    toStageId = st.id;
  }
  if (!toStageId) throw new UserError("Pick a stage.");
  const res = await performStageMove(user, ctx, { ...input, dealId, toStageId }, opts);
  const [st] = await db.select({ name: s.stages.name }).from(s.stages).where(eq(s.stages.id, toStageId));
  return { ...res, stageName: st?.name ?? "", pipelineKey: ctx.pipeline.key };
}

