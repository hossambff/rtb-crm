"use server";
import { revalidatePath } from "next/cache";
import { and, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { normalizeDomain } from "@/lib/domain";
import { assertCan, can, canSeeRestricted, dealModule, ForbiddenError, scopeFor, type AppUser } from "@/lib/rbac/server";
import { RATE_TYPES, TRIGGERS } from "./calc";
import { accrueCommissions } from "./engine";
import { registrationConflicts, UNAVAILABLE_ACCOUNT_CONFLICT } from "./registration";
import { applyRegistrationDecision } from "./registration-service";

const ruleSchema = z.object({
  trigger: z.enum(TRIGGERS),
  pipelineKeys: z.array(z.enum(["NET", "ENT", "SPT", "R100", "ADS", "PAY"])).max(6).optional(),
  rateType: z.enum(RATE_TYPES),
  rate: z.number().min(0, "Rate must be ≥ 0").max(10_000_000),
  capCents: z.number().int().min(0).max(1_000_000_000).optional(),
  clawbackDays: z.number().int().min(0).max(730).optional(),
});

export const savePlan = action(
  z.object({
    id: z.uuid().optional(),
    name: z.string().trim().min(2, "Name the plan").max(120),
    description: z.string().trim().max(1000).optional().nullable(),
    active: z.boolean(),
    rules: z.array(ruleSchema).min(1, "Add at least one rule").max(20),
  }),
  async (input, user) => {
    await assertCan(user, "commissions", "configure", "all");
    for (const r of input.rules) if (r.rateType !== "flat" && r.rate > 100) throw new UserError("Percentage rates must be between 0 and 100.");
    const rules = input.rules.map((r) => ({ ...r, pipelineKeys: r.pipelineKeys?.length ? r.pipelineKeys : undefined }));
    if (input.id) {
      const [before] = await db.select().from(s.commissionPlans).where(eq(s.commissionPlans.id, input.id));
      if (!before) throw new UserError("Plan not found.");
      const patch = { name: input.name, description: input.description || null, active: input.active, rules };
      await db.update(s.commissionPlans).set(patch).where(eq(s.commissionPlans.id, input.id));
      await audit({ actorId: user.id, action: "commission_plan.update", entity: "commission_plan", entityId: input.id, before, after: patch });
      revalidatePath("/commissions");
      return { id: input.id };
    }
    const [row] = await db.insert(s.commissionPlans).values({ name: input.name, description: input.description || null, active: input.active, rules }).returning();
    await audit({ actorId: user.id, action: "commission_plan.create", entity: "commission_plan", entityId: row!.id, after: row });
    revalidatePath("/commissions");
    return { id: row!.id };
  },
);

export const assignPlan = action(z.object({ userId: z.string().min(1, "Pick a user"), planId: z.uuid("Pick a plan"), effectiveFrom: z.iso.date("Pick a date") }), async (input, user) => {
  await assertCan(user, "commissions", "configure", "all");
  const effectiveFrom = new Date(`${input.effectiveFrom}T00:00:00Z`);
  await db
    .insert(s.commissionAssignments)
    .values({ userId: input.userId, planId: input.planId, effectiveFrom })
    .onConflictDoUpdate({ target: [s.commissionAssignments.userId, s.commissionAssignments.planId], set: { effectiveFrom } });
  await audit({ actorId: user.id, action: "commission_assignment.upsert", entity: "commission_assignment", entityId: `${input.userId}:${input.planId}`, after: input });
  revalidatePath("/commissions");
  return { ok: true };
});

export const unassignPlan = action(z.object({ userId: z.string().min(1), planId: z.uuid() }), async (input, user) => {
  await assertCan(user, "commissions", "configure", "all");
  await db.delete(s.commissionAssignments).where(and(eq(s.commissionAssignments.userId, input.userId), eq(s.commissionAssignments.planId, input.planId)));
  await audit({ actorId: user.id, action: "commission_assignment.delete", entity: "commission_assignment", entityId: `${input.userId}:${input.planId}`, before: input });
  revalidatePath("/commissions");
  return { ok: true };
});

export const runAccruals = action(z.object({}), async (_input, user) => {
  if (!(await can(user, "commissions", "create", "all")) && !(await can(user, "commissions", "configure", "all"))) throw new ForbiddenError();
  const res = await accrueCommissions({ actorId: user.id });
  revalidatePath("/commissions");
  return res;
});

/** Finance: approve (commissions approve) or mark paid (commissions edit) — bulk. */
export const setAccrualStatus = action(
  z.object({ ids: z.array(z.uuid()).min(1).max(500), status: z.enum(["approved", "paid", "accrued"]) }),
  async ({ ids, status }, user) => {
    if (status === "approved") await assertCan(user, "commissions", "approve", "all");
    else await assertCan(user, "commissions", "edit", "all");
    const rows = await db.select().from(s.commissionAccruals).where(inArray(s.commissionAccruals.id, ids));
    const allowedFrom: Record<string, string[]> = { approved: ["accrued", "disputed"], paid: ["approved"], accrued: ["disputed", "approved"] };
    const eligible = rows.filter((r) => allowedFrom[status]!.includes(r.status));
    if (!eligible.length) throw new UserError(status === "paid" ? "Only approved accruals can be marked paid." : "No selected accruals can move to that status.");
    await db.update(s.commissionAccruals).set({ status }).where(inArray(s.commissionAccruals.id, eligible.map((r) => r.id)));
    for (const r of eligible) await audit({ actorId: user.id, action: `commission_accrual.${status}`, entity: "commission_accrual", entityId: r.id, before: { status: r.status }, after: { status } });
    revalidatePath("/commissions");
    return { updated: eligible.length, skipped: rows.length - eligible.length };
  },
);

/** Rep disputes one of their own accruals (COM-4). Finance/managers in view scope may also flag. */
export const disputeAccrual = action(z.object({ id: z.uuid(), note: z.string().trim().min(5, "Explain the dispute (5+ characters)").max(1000) }), async ({ id, note }, user) => {
  const [row] = await db.select().from(s.commissionAccruals).where(eq(s.commissionAccruals.id, id));
  if (!row) throw new UserError("Accrual not found.");
  const scope = await scopeFor(user, "commissions", "view");
  const mine = row.userId === user.id;
  if (!mine && scope !== "all" && !(scope === "team" && user.teamMemberIds.includes(row.userId))) throw new ForbiddenError();
  if (row.status === "paid") throw new UserError("Paid accruals can't be disputed here — contact finance.");
  const stamp = new Date().toISOString().slice(0, 10);
  const nextNote = `${row.note ?? ""}\nDispute (${user.name}, ${stamp}): ${note}`.trim();
  await db.update(s.commissionAccruals).set({ status: "disputed", note: nextNote }).where(eq(s.commissionAccruals.id, id));
  await audit({ actorId: user.id, action: "commission_accrual.dispute", entity: "commission_accrual", entityId: id, before: { status: row.status }, after: { status: "disputed", note } });
  revalidatePath("/commissions");
  return { id };
});

/** Finance resolves a dispute: adjust amount (optional) and return to accrued/approved. */
export const resolveDispute = action(
  z.object({ id: z.uuid(), status: z.enum(["accrued", "approved"]), amountCents: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional(), note: z.string().trim().max(1000).optional() }),
  async ({ id, status, amountCents, note }, user) => {
    await assertCan(user, "commissions", "edit", "all");
    const [row] = await db.select().from(s.commissionAccruals).where(eq(s.commissionAccruals.id, id));
    if (!row || row.status !== "disputed") throw new UserError("Only disputed accruals can be resolved.");
    const stamp = new Date().toISOString().slice(0, 10);
    const patch = {
      status,
      amountCents: amountCents ?? row.amountCents,
      note: `${row.note ?? ""}\nResolved (${user.name}, ${stamp})${note ? `: ${note}` : ""}`.trim(),
    };
    await db.update(s.commissionAccruals).set(patch).where(eq(s.commissionAccruals.id, id));
    await audit({ actorId: user.id, action: "commission_accrual.resolve", entity: "commission_accrual", entityId: id, before: row, after: patch });
    revalidatePath("/commissions");
    return { id };
  },
);

/* ───────────── Lead registration (COM-6) ───────────── */

/** Search accounts to register (name/domain). Restricted accounts are never returned. */
export const searchRegistrableAccounts = action(z.object({ q: z.string().trim().min(2).max(100) }), async ({ q }, user) => {
  await assertCan(user, "accounts", "view");
  const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
  const rows = await db
    .select({ id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain, ownerId: s.accounts.ownerId })
    .from(s.accounts)
    .where(and(isNull(s.accounts.deletedAt), eq(s.accounts.restricted, false), or(ilike(s.accounts.name, like), ilike(s.accounts.domain, like))))
    .limit(10);
  return rows.map((r) => ({ id: r.id, name: r.name, domain: r.domain, owned: r.ownerId != null && r.ownerId !== user.id, ownedByMe: r.ownerId === user.id }));
});

async function conflictsFor(user: AppUser, accountId: string) {
  const [account] = await db.select().from(s.accounts).where(and(eq(s.accounts.id, accountId), isNull(s.accounts.deletedAt)));
  if (!account) throw new UserError("Account not found.");
  // SEC M-1: a restricted (MNPI) account the caller isn't cleared for is reported as "exists, can't register" — no
  // name, domain, deals or registration state.
  if (account.restricted && !(await canSeeRestricted(user, "account", account.id))) {
    return { account: { ...account, name: null, domain: null }, conflicts: [UNAVAILABLE_ACCOUNT_CONFLICT] };
  }
  const rows = await db
    .select({ ownerId: s.deals.ownerId, pipelineKey: s.pipelines.key, pipelineName: s.pipelines.name, stageName: s.stages.name, restricted: s.deals.restricted })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .where(and(eq(s.deals.accountId, accountId), isNull(s.deals.deletedAt), inArray(s.deals.status, ["open", "hold"])));
  // Don't reveal pipeline/stage of deals the user can't see (e.g. Enterprise or restricted deals for commission reps).
  const openDeals = [];
  for (const d of rows) {
    const visible = !d.restricted && (await can(user, dealModule(d.pipelineKey), "view"));
    openDeals.push(visible ? { ownerId: d.ownerId, pipelineName: d.pipelineName, stageName: d.stageName } : { ownerId: d.ownerId, pipelineName: "", stageName: "", hidden: true });
  }
  const regs = await db.select().from(s.leadRegistrations).where(eq(s.leadRegistrations.accountId, accountId));
  return {
    account,
    conflicts: registrationConflicts({ userId: user.id, account: { ownerId: account.ownerId, restricted: account.restricted }, openDeals, registrations: regs, now: new Date() }),
  };
}

export const checkRegistration = action(z.object({ accountId: z.uuid().optional(), domain: z.string().trim().max(255).optional() }), async (input, user) => {
  await assertCan(user, "accounts", "view");
  let accountId = input.accountId;
  if (!accountId && input.domain) {
    const domain = normalizeDomain(input.domain);
    if (!domain) throw new UserError("Enter a valid domain, e.g. example.com");
    const [acc] = await db.select({ id: s.accounts.id }).from(s.accounts).where(and(eq(s.accounts.domain, domain), isNull(s.accounts.deletedAt)));
    if (!acc) return { exists: false as const, domain, conflicts: [] };
    accountId = acc.id;
  }
  if (!accountId) throw new UserError("Pick an account or enter a domain.");
  const { account, conflicts } = await conflictsFor(user, accountId);
  const hidden = account.name === null;
  return { exists: true as const, accountId: hidden ? undefined : accountId, accountName: account.name, domain: account.domain, conflicts };
});

export const registerLead = action(
  z.object({
    accountId: z.uuid().optional(),
    domain: z.string().trim().max(255).optional(),
    name: z.string().trim().max(200).optional(),
    note: z.string().trim().max(1000).optional(),
  }),
  async (input, user) => {
    await assertCan(user, "accounts", "view");
    let accountId = input.accountId;
    if (!accountId) {
      const domain = normalizeDomain(input.domain);
      if (!domain) throw new UserError("Enter a valid domain, e.g. example.com");
      const [acc] = await db.select({ id: s.accounts.id }).from(s.accounts).where(and(eq(s.accounts.domain, domain), isNull(s.accounts.deletedAt)));
      if (acc) accountId = acc.id;
      else {
        await assertCan(user, "accounts", "create");
        const [created] = await db
          .insert(s.accounts)
          .values({ name: input.name?.trim() || domain, domain, website: `https://${domain}`, source: "Commission registration", createdBy: user.id })
          .returning();
        accountId = created!.id;
        await audit({ actorId: user.id, action: "account.create", entity: "account", entityId: accountId, after: created });
      }
    }
    const { account, conflicts } = await conflictsFor(user, accountId);
    const blocking = conflicts.find((c) => c.severity === "block");
    if (blocking) throw new UserError(blocking.message);
    const [reg] = await db.insert(s.leadRegistrations).values({ accountId, userId: user.id, status: "pending", note: input.note || null }).returning();
    await db.insert(s.approvals).values({
      kind: "lead_registration",
      entity: "lead_registration",
      entityId: reg!.id,
      requestedBy: user.id,
      approverRole: "sales_leader",
      payload: { accountId, accountName: account.name, conflicts: conflicts.map((c) => c.message) },
    });
    const approvers = await db.select({ id: s.user.id }).from(s.user).where(inArray(s.user.role, ["sales_leader", "admin"]));
    if (approvers.length)
      await db.insert(s.notifications).values(
        approvers.map((a) => ({ userId: a.id, kind: "approval", title: `Lead registration: ${account.name}`, body: `${user.name} registered ${account.name}${conflicts.length ? ` (${conflicts.length} conflict${conflicts.length > 1 ? "s" : ""})` : ""}.`, href: "/commissions?tab=registrations" })),
      );
    await audit({ actorId: user.id, action: "lead_registration.create", entity: "lead_registration", entityId: reg!.id, after: { ...reg, conflicts } });
    revalidatePath("/commissions");
    return { id: reg!.id, conflicts };
  },
);

export const decideRegistration = action(
  z.object({ id: z.uuid(), decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(1000).optional() }),
  async ({ id, decision, note }, user) => {
    await assertCan(user, "accounts", "assign", "all");
    await applyRegistrationDecision(user, id, decision, note ?? null, { syncApproval: true });
    revalidatePath("/commissions");
    return { id, status: decision };
  },
);
