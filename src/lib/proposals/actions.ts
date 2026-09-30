"use server";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, max } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, type AppUser } from "@/lib/rbac/server";
import { approvalRules, assertProposalDeal, proposalWhere } from "./access";
import { assertNotSelfDecision } from "@/lib/approvals/sod";
import { approvalTriggers, canExport, computeProForma, COST_FUNCTIONS, isLocked, normalizeInputs, REVENUE_LINES, type ProFormaInputs } from "./calc";

const usd = z.number().min(0).max(1e12);
const pct = z.number().min(0).max(1);
const inputsSchema = z.object({
  scenarioLabel: z.string().trim().max(200).optional(),
  revenue: z.object(Object.fromEntries(REVENUE_LINES.map((l) => [l, usd])) as Record<(typeof REVENUE_LINES)[number], typeof usd>),
  revShareLines: z.array(z.enum(REVENUE_LINES)).max(REVENUE_LINES.length),
  costs: z
    .array(z.object({ label: z.string().trim().min(1, "Name each cost line").max(120), fn: z.enum(COST_FUNCTIONS), vendor: z.string().trim().max(120).optional(), amount: usd, rtbFundedPct: pct }))
    .max(40),
  smCost: usd,
  smAbsorbPct: pct,
  gaCost: usd,
  gaAbsorbPct: pct,
  revSharePct: pct,
  guaranteeType: z.enum(["profit_floor", "fixed_monthly", "none"]),
  guaranteeAmount: usd,
  rampMonths: z.number().int().min(0).max(24),
  termYears: z.number().min(1, "Term must be at least 1 year").max(20),
  growthPct: z.number().min(-0.5).max(1),
  notes: z.string().max(4000).optional(),
});

/** Evaluate PRO-3 triggers and write the resulting status (+ approvals row / executive notifications). */
async function applyApprovalState(user: AppUser, proposalId: string, inputs: ProFormaInputs, deal: { name: string; restricted: boolean }, version: number) {
  const dealName = deal.name;
  // SEC M-5: executives are not necessarily on a restricted deal's access list — neutral notification text.
  const notifyLabel = deal.restricted ? "restricted deal" : dealName;
  const reasons = approvalTriggers(inputs, await approvalRules());
  const pending = await db
    .select({ id: s.approvals.id })
    .from(s.approvals)
    .where(and(eq(s.approvals.kind, "proposal"), eq(s.approvals.entityId, proposalId), eq(s.approvals.status, "pending")));
  if (reasons.length) {
    await db.update(s.proposals).set({ status: "pending_approval", approvalReason: reasons.join("; ") }).where(eq(s.proposals.id, proposalId));
    if (pending.length) {
      await db.update(s.approvals).set({ payload: { reasons, version, dealName } }).where(inArray(s.approvals.id, pending.map((p) => p.id)));
    } else {
      await db.insert(s.approvals).values({ kind: "proposal", entity: "proposal", entityId: proposalId, requestedBy: user.id, approverRole: "executive", payload: { reasons, version, dealName } });
      const execs = await db.select({ id: s.user.id }).from(s.user).where(eq(s.user.role, "executive"));
      if (execs.length)
        await db.insert(s.notifications).values(
          execs.map((e) => ({ userId: e.id, kind: "approval", title: `Proposal approval: ${notifyLabel} v${version}`, body: deal.restricted ? null : reasons.join("; "), href: `/proposals/${proposalId}` })),
        );
    }
  } else {
    await db.update(s.proposals).set({ status: "draft", approvalReason: null }).where(eq(s.proposals.id, proposalId));
    if (pending.length)
      await db
        .update(s.approvals)
        .set({ status: "rejected", note: "Withdrawn: no longer requires approval", decidedAt: new Date() })
        .where(inArray(s.approvals.id, pending.map((p) => p.id)));
  }
  return reasons;
}

export const createProposal = action(z.object({ dealId: z.uuid("Pick a deal"), inputs: inputsSchema }), async ({ dealId, inputs }, user) => {
  await assertCan(user, "proposals", "create");
  const { deal } = await assertProposalDeal(user, dealId, "create");
  const clean = normalizeInputs(inputs);
  const [{ v }] = await db.select({ v: max(s.proposals.version) }).from(s.proposals).where(eq(s.proposals.dealId, dealId));
  const version = (v ?? 0) + 1;
  const [row] = await db
    .insert(s.proposals)
    .values({ dealId, version, inputs: clean as never, outputs: computeProForma(clean) as never, status: "draft", createdBy: user.id })
    .returning();
  const reasons = await applyApprovalState(user, row!.id, clean, deal, version);
  await audit({ actorId: user.id, action: "proposal.create", entity: "proposal", entityId: row!.id, after: { dealId, version, inputs: clean, reasons } });
  revalidatePath("/proposals");
  return { id: row!.id, version, reasons };
});

export const updateProposal = action(z.object({ id: z.uuid(), inputs: inputsSchema }), async ({ id, inputs }, user) => {
  await assertCan(user, "proposals", "edit");
  const [before] = await db.select().from(s.proposals).where(eq(s.proposals.id, id));
  if (!before) throw new UserError("Proposal not found.");
  const { deal } = await assertProposalDeal(user, before.dealId, "edit");
  if (isLocked(before.status)) throw new UserError(`Version ${before.version} is ${before.status} and locked. Create a new version to change it.`);
  const clean = normalizeInputs(inputs);
  await db.update(s.proposals).set({ inputs: clean as never, outputs: computeProForma(clean) as never }).where(eq(s.proposals.id, id));
  const reasons = await applyApprovalState(user, id, clean, deal, before.version);
  await audit({ actorId: user.id, action: "proposal.update", entity: "proposal", entityId: id, before: before.inputs, after: clean });
  revalidatePath("/proposals");
  revalidatePath(`/proposals/${id}`);
  return { id, reasons };
});

/** PRO-2: start a new version from any existing one (the only way to change a locked version). */
export const newVersion = action(z.object({ fromId: z.uuid() }), async ({ fromId }, user) => {
  await assertCan(user, "proposals", "create");
  const [src] = await db.select().from(s.proposals).where(eq(s.proposals.id, fromId));
  if (!src) throw new UserError("Proposal not found.");
  const { deal } = await assertProposalDeal(user, src.dealId, "create");
  const [{ v }] = await db.select({ v: max(s.proposals.version) }).from(s.proposals).where(eq(s.proposals.dealId, src.dealId));
  const version = (v ?? 0) + 1;
  const clean = normalizeInputs(src.inputs);
  const [row] = await db
    .insert(s.proposals)
    .values({ dealId: src.dealId, version, inputs: clean as never, outputs: computeProForma(clean) as never, status: "draft", createdBy: user.id })
    .returning();
  await applyApprovalState(user, row!.id, clean, deal, version);
  await audit({ actorId: user.id, action: "proposal.new_version", entity: "proposal", entityId: row!.id, after: { fromId, version } });
  revalidatePath("/proposals");
  return { id: row!.id, version };
});

/** PRO-3: executive decision. Rejection returns the version to draft with the reason. */
export const decideProposal = action(z.object({ id: z.uuid(), decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(1000).optional() }), async ({ id, decision, note }, user) => {
  await assertCan(user, "proposals", "approve", "all");
  const [p] = await db.select().from(s.proposals).where(eq(s.proposals.id, id));
  if (!p) throw new UserError("Proposal not found.");
  // Approvers need visibility of the proposal (deal access + restricted list), not edit scope on the deal.
  const [visible] = await db
    .select({ id: s.proposals.id })
    .from(s.proposals)
    .innerJoin(s.deals, eq(s.deals.id, s.proposals.dealId))
    .where(and(eq(s.proposals.id, id), await proposalWhere(user, "view")));
  if (!visible) throw new UserError("Proposal not found.");
  if (p.status !== "pending_approval") throw new UserError("This version is not waiting for approval.");
  // SEC M-9 / QA-14: separation of duties — neither the proposal's author nor whoever triggered the approval decides it.
  const requesters = await db
    .select({ by: s.approvals.requestedBy })
    .from(s.approvals)
    .where(and(eq(s.approvals.kind, "proposal"), eq(s.approvals.entityId, id), eq(s.approvals.status, "pending")));
  for (const r of [p.createdBy, ...requesters.map((x) => x.by)]) await assertNotSelfDecision(user, r);
  const now = new Date();
  const patch =
    decision === "approved"
      ? { status: "approved", approvedBy: user.id, approvalReason: p.approvalReason }
      : { status: "draft", approvedBy: null, approvalReason: `Rejected by ${user.name}${note ? `: ${note}` : ""}` };
  await db.transaction(async (tx) => {
    await tx.update(s.proposals).set(patch).where(eq(s.proposals.id, id));
    await tx
      .update(s.approvals)
      .set({ status: decision, decidedBy: user.id, decidedAt: now, note: note ?? null })
      .where(and(eq(s.approvals.kind, "proposal"), eq(s.approvals.entityId, id), eq(s.approvals.status, "pending")));
    if (p.createdBy)
      await tx.insert(s.notifications).values({ userId: p.createdBy, kind: "approval", title: `Proposal v${p.version} ${decision}`, body: note ?? null, href: `/proposals/${id}` });
  });
  await audit({ actorId: user.id, action: `proposal.${decision}`, entity: "proposal", entityId: id, before: { status: p.status }, after: patch });
  revalidatePath("/proposals");
  revalidatePath(`/proposals/${id}`);
  return { id, status: patch.status };
});

/** PRO-2: mark sent → locked. Only exportable versions (approved, or drafts with no approval trigger). */
export const markSent = action(z.object({ id: z.uuid() }), async ({ id }, user) => {
  await assertCan(user, "proposals", "edit");
  const [p] = await db.select().from(s.proposals).where(eq(s.proposals.id, id));
  if (!p) throw new UserError("Proposal not found.");
  await assertProposalDeal(user, p.dealId, "edit");
  const triggers = approvalTriggers(normalizeInputs(p.inputs), await approvalRules());
  if (!canExport(p.status, triggers)) throw new UserError("This version needs executive approval before it can be sent.");
  if (p.status === "sent") return { id };
  await db.update(s.proposals).set({ status: "sent" }).where(eq(s.proposals.id, id));
  await audit({ actorId: user.id, action: "proposal.sent", entity: "proposal", entityId: id, before: { status: p.status }, after: { status: "sent" } });
  revalidatePath("/proposals");
  revalidatePath(`/proposals/${id}`);
  return { id };
});
