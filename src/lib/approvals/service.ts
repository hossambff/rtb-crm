import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { ForbiddenError, type AppUser } from "@/lib/rbac/server";
import { UserError } from "@/lib/actions";
import { logServerError } from "@/lib/errors";
import { notify, notifyMany } from "@/lib/notifications/notify";
import { canDecide, getApprovalHandler, type ApprovalDecision, type ApprovalRow } from "./registry";

export { registerApprovalHandler } from "./registry";

class AlreadyDecided extends Error {}

/**
 * Create an approval request and notify the approver role. Other modules call this (e.g. deals when a probability
 * override exceeds the threshold, proposals when terms fall outside guardrails).
 */
export async function requestApproval(input: {
  kind: string;
  entity: string;
  entityId: string;
  requestedBy: string;
  approverRole?: string;
  payload?: Record<string, unknown>;
  note?: string | null;
  title?: string;
}): Promise<ApprovalRow> {
  const [row] = await db
    .insert(s.approvals)
    .values({
      kind: input.kind,
      entity: input.entity,
      entityId: input.entityId,
      requestedBy: input.requestedBy,
      approverRole: input.approverRole ?? "executive",
      payload: input.payload ?? {},
      note: input.note ?? null,
    })
    .returning();
  await audit({ actorId: input.requestedBy, action: "approval.request", entity: "approval", entityId: row!.id, after: row });
  const approvers = await db
    .select({ id: s.user.id })
    .from(s.user)
    .where(inArray(s.user.role, [row!.approverRole, ...(row!.approverRole === "executive" ? [] : ["executive"])]));
  await notifyMany(
    approvers.map((a) => a.id).filter((id) => id !== input.requestedBy),
    { kind: "approval", title: input.title ?? `Approval requested: ${input.kind.replace(/_/g, " ")}`, body: input.note ?? null, href: "/tasks?tab=approvals" },
  );
  return row!;
}

/** Decide a pending approval: permission check → kind handler side effects → status → alerts → notify requester. */
export async function decide(user: AppUser, id: string, decision: ApprovalDecision, note: string | null) {
  const [approval] = await db.select().from(s.approvals).where(eq(s.approvals.id, id));
  if (!approval) throw new UserError("Approval not found.");
  if (approval.status !== "pending") throw new UserError("This request was already decided.");
  if (!(await canDecide(user, approval))) throw new ForbiddenError("You can't decide this request.");
  if (decision === "rejected" && !note?.trim()) throw new UserError("Add a reason when rejecting.");

  const handler = getApprovalHandler(approval.kind);
  const ctx = { approval, decision, user, note };
  // The claim flips the row only while it is still pending, so concurrent deciders can't both apply side effects.
  // It runs inside the same transaction as the side effects (H-13): both commit, or neither does.
  let after: ApprovalRow | undefined;
  const claim = async (tx: Tx) => {
    const [row] = await tx
      .update(s.approvals)
      .set({ status: decision, decidedBy: user.id, decidedAt: new Date(), note: note ? `${approval.note ? `${approval.note}\n` : ""}Decision: ${note}` : approval.note })
      .where(and(eq(s.approvals.id, id), eq(s.approvals.status, "pending")))
      .returning();
    if (!row) throw new AlreadyDecided();
    await audit({ actorId: user.id, action: `approval.${decision}`, entity: "approval", entityId: id, before: approval, after: row }, tx);
    after = row;
  };
  try {
    if (handler.apply) {
      const apply = handler.apply;
      await db.transaction(async (tx) => {
        await claim(tx);
        await apply({ ...ctx, tx });
      });
    } else if (handler.applyWithClaim) {
      await handler.applyWithClaim({ ...ctx, claim });
      if (!after) await db.transaction(claim); // the handler found nothing to do (e.g. already applied): record the decision
    } else {
      await db.transaction(claim);
      if (handler.applyAfter) await handler.applyAfter(ctx);
    }
  } catch (e) {
    if (e instanceof AlreadyDecided) throw new UserError("This request was already decided.");
    // Clear error state: status "failed" + reason (the side effects were rolled back, or — applyAfter — partly done
    // and listed in the audit). Never back to "pending", where it would sit stuck and could be half-applied again.
    const reason = e instanceof UserError || e instanceof ForbiddenError ? e.message : "Unexpected error while applying the decision.";
    try {
      await db
        .update(s.approvals)
        .set({ status: "failed", decidedBy: user.id, decidedAt: new Date(), note: `${approval.note ? `${approval.note}\n` : ""}Apply failed (${decision} by ${user.name}): ${reason}` })
        .where(and(eq(s.approvals.id, id), inArray(s.approvals.status, ["pending", decision])));
      await audit({ actorId: user.id, action: "approval.apply_failed", entity: "approval", entityId: id, before: approval, after: { decision, reason } });
    } catch (e2) {
      logServerError("approvals.mark_failed", e2);
    }
    throw e;
  }
  if (!after) throw new UserError("This request was already decided.");

  // After commit: never throw (the decision is recorded).
  try {
    const res = handler.resolvesAlerts?.(approval);
    if (res?.entityIds.length)
      await db
        .update(s.alerts)
        .set({ state: "resolved", resolvedAt: new Date(), resolution: `Approval ${decision} by ${user.name}` })
        .where(
          and(
            eq(s.alerts.ruleCode, res.ruleCode),
            eq(s.alerts.entity, res.entity),
            inArray(s.alerts.entityId, res.entityIds),
            inArray(s.alerts.state, ["open", "acknowledged", "snoozed", "escalated"]),
          ),
        );
  } catch (e) {
    logServerError("approvals.resolve_alerts", e);
  }

  if (approval.requestedBy !== user.id)
    await notify(approval.requestedBy, {
      kind: "approval",
      title: `${user.name} ${decision} your ${approval.kind.replace(/_/g, " ")} request`,
      body: note,
      href: "/tasks?tab=approvals",
    });
  return after;
}

export type ApprovalView = {
  id: string;
  kind: string;
  label: string;
  requestedBy: string;
  requesterName: string | null;
  status: string;
  note: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  decidedAt: string | null;
  deciderName: string | null;
  canDecide: boolean;
};

/** Pending requests the user may decide + the user's own recent requests. */
export async function listApprovals(user: AppUser): Promise<{ pending: ApprovalView[]; mine: ApprovalView[]; isApprover: boolean }> {
  const [pendingRows, mineRows, users] = await Promise.all([
    db.select().from(s.approvals).where(eq(s.approvals.status, "pending")).orderBy(s.approvals.createdAt).limit(300),
    db.select().from(s.approvals).where(eq(s.approvals.requestedBy, user.id)).orderBy(desc(s.approvals.createdAt)).limit(30),
    db.select({ id: s.user.id, name: s.user.name }).from(s.user),
  ]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const decidable: ApprovalRow[] = [];
  for (const a of pendingRows) if (await canDecide(user, a)) decidable.push(a);
  const view = async (a: ApprovalRow, can: boolean): Promise<ApprovalView> => {
    const h = getApprovalHandler(a.kind);
    const label = (h.label ? await h.label(user, a) : null) ?? `${a.entity} ${a.entityId.slice(0, 8)}`;
    return {
      id: a.id,
      kind: a.kind,
      label,
      requestedBy: a.requestedBy,
      requesterName: names.get(a.requestedBy) ?? null,
      status: a.status,
      note: a.note,
      payload: safePayload(a.payload),
      createdAt: a.createdAt.toISOString(),
      decidedAt: a.decidedAt?.toISOString() ?? null,
      deciderName: a.decidedBy ? (names.get(a.decidedBy) ?? null) : null,
      canDecide: can,
    };
  };
  const pending = await Promise.all(decidable.map((a) => view(a, true)));
  const mine = await Promise.all(mineRows.map((a) => view(a, false)));
  const isApprover = pending.length > 0 || ["executive", "admin", "super_admin", "sales_leader", "finance"].includes(user.role);
  return { pending, mine, isApprover };
}

/** Only pass simple scalar payload fields to the client (for display: requested probability, reason, amounts). */
function safePayload(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p ?? {})) {
    if (["string", "number", "boolean"].includes(typeof v)) out[k] = v;
    else if (Array.isArray(v)) out[k] = `${v.length} item${v.length === 1 ? "" : "s"}`;
  }
  return out;
}

export async function pendingApprovalCount(user: AppUser): Promise<number> {
  const rows = await db.select().from(s.approvals).where(eq(s.approvals.status, "pending")).limit(300);
  let n = 0;
  for (const a of rows) if (await canDecide(user, a)) n++;
  return n;
}
