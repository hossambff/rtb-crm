import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { canSeeRestricted, dealModule, inScope, scopeFor, type AppUser } from "@/lib/rbac/server";
import { SCOPE_RANK } from "@/lib/rbac/model";
import { UserError } from "@/lib/actions";
import { applyRegistrationDecision } from "@/lib/commissions/registration-service";
import { acceptCandidatesAs } from "@/lib/scout/accept";

export type ApprovalRow = typeof s.approvals.$inferSelect;
export type ApprovalDecision = "approved" | "rejected";

export type ApprovalHandler = {
  /** Who may decide. Default: approverRole match or admin/super_admin. */
  canDecide?: (user: AppUser, approval: ApprovalRow) => Promise<boolean>;
  /** Side effects of the decision (the approvals row itself is updated by the caller). Runs before the status update. */
  apply?: (ctx: { approval: ApprovalRow; decision: ApprovalDecision; user: AppUser; note: string | null }) => Promise<void>;
  /** Human label for the approval's subject, permission-aware (return null to hide). */
  label?: (user: AppUser, approval: ApprovalRow) => Promise<string | null>;
  /** Alerts to auto-resolve once decided (rule + entity + entityIds). */
  resolvesAlerts?: (approval: ApprovalRow) => { ruleCode: string; entity: string; entityIds: string[] } | null;
};

const handlers = new Map<string, ApprovalHandler>();

/**
 * Other modules plug their approval kinds in here, e.g. in `src/lib/proposals/approvals.ts`:
 *   registerApprovalHandler("proposal", { canDecide, apply });
 * and make sure that file is imported by something on the server path (e.g. their actions.ts).
 * Registering twice replaces the previous handler.
 */
export function registerApprovalHandler(kind: string, handler: ApprovalHandler) {
  handlers.set(kind, handler);
}

export function getApprovalHandler(kind: string): ApprovalHandler {
  return handlers.get(kind) ?? {};
}

export async function defaultCanDecide(user: AppUser, approval: ApprovalRow): Promise<boolean> {
  return user.role === approval.approverRole || user.role === "admin" || user.role === "super_admin";
}

/** Separation of duties + handler-specific rule. */
export async function canDecide(user: AppUser, approval: ApprovalRow): Promise<boolean> {
  if (approval.status !== "pending") return false;
  if (approval.requestedBy === user.id && user.role !== "super_admin") return false;
  const h = getApprovalHandler(approval.kind);
  return (h.canDecide ?? defaultCanDecide)(user, approval);
}

/* ───────────── Built-in handlers ───────────── */

function dealIdsOf(a: ApprovalRow): string[] {
  const bulk = Array.isArray(a.payload?.dealIds) ? (a.payload.dealIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return bulk.length ? bulk : a.entity === "deal" ? [a.entityId] : [];
}

async function dealsFor(ids: string[]) {
  if (!ids.length) return [];
  return db
    .select({ id: s.deals.id, name: s.deals.name, ownerId: s.deals.ownerId, teamId: s.deals.teamId, restricted: s.deals.restricted, pipelineKey: s.pipelines.key })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .where(and(inArray(s.deals.id, ids), isNull(s.deals.deletedAt)));
}

/** User holds `approve` at ≥ minScope on every deal's pipeline module, the deal is in scope, and MNPI access holds. */
async function canApproveDeals(user: AppUser, ids: string[], minScope: "own" | "all") {
  const deals = await dealsFor(ids);
  if (!deals.length) return false;
  for (const d of deals) {
    const scope = await scopeFor(user, dealModule(d.pipelineKey), "approve");
    if (SCOPE_RANK[scope] < SCOPE_RANK[minScope]) return false;
    if (!inScope(user, scope, { ownerId: d.ownerId, teamId: d.teamId, pipelineKey: d.pipelineKey })) return false;
    if (d.restricted && !(await canSeeRestricted(user, "deal", d.id))) return false;
  }
  return true;
}

async function dealLabel(user: AppUser, a: ApprovalRow) {
  const ids = dealIdsOf(a);
  const deals = await dealsFor(ids.slice(0, 3));
  if (ids.length > 1) return `${ids.length} deals (bulk)`;
  const d = deals[0];
  if (!d) return null;
  if (d.restricted && !(await canSeeRestricted(user, "deal", d.id))) return "Restricted deal";
  return `${d.name} · ${d.pipelineKey}`;
}

// Probability override (PRD DEAL-5 / NS-18 / AT-09): executive-level approval (approve scope "all" on the pipeline).
registerApprovalHandler("probability_override", {
  canDecide: (user, a) => canApproveDeals(user, dealIdsOf(a), "all"),
  label: dealLabel,
  apply: async ({ approval, decision, user }) => {
    for (const id of dealIdsOf(approval)) {
      const [before] = await db.select().from(s.deals).where(eq(s.deals.id, id));
      // Skip deals already decided elsewhere (e.g. from the deal page) or withdrawn — matters for bulk requests.
      if (!before || before.overrideStatus !== "pending") continue;
      const set =
        decision === "approved"
          ? { overrideStatus: "approved", overrideApprovedBy: user.id }
          : { overrideStatus: "rejected", overrideApprovedBy: user.id, probabilityOverride: null };
      const [after] = await db.update(s.deals).set(set).where(eq(s.deals.id, id)).returning();
      await audit({
        actorId: user.id,
        action: `deal.probability_override_${decision}`,
        entity: "deal",
        entityId: id,
        before: { probabilityOverride: before.probabilityOverride, overrideStatus: before.overrideStatus },
        after: { probabilityOverride: after?.probabilityOverride, overrideStatus: after?.overrideStatus, approvalId: approval.id },
      });
    }
  },
  resolvesAlerts: (a) => ({ ruleCode: "NS-18", entity: "deal", entityIds: dealIdsOf(a) }),
});

// Stage gate (stages.requiresApproval): approve scope ≥ own on the pipeline, deal in scope. Approving performs the move
// through the deals module's stage-change service (gates, history, won automation, audit, health) as the approver.
registerApprovalHandler("stage_gate", {
  canDecide: (user, a) => canApproveDeals(user, dealIdsOf(a), "own"),
  label: async (user, a) => {
    const base = await dealLabel(user, a);
    const to = typeof a.payload?.toStage === "string" ? a.payload.toStage : typeof a.payload?.toStageKey === "string" ? a.payload.toStageKey : null;
    return base && to ? `${base} → ${to}` : base;
  },
  apply: async ({ approval, decision, user }) => {
    if (decision !== "approved") return;
    const p = approval.payload ?? {};
    const toStageId = typeof p.toStageId === "string" ? p.toStageId : null;
    if (!toStageId) throw new UserError("This request has no target stage.");
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const fields = p.fields && typeof p.fields === "object" ? (p.fields as Record<string, string>) : undefined;
    const nc = p.newContact && typeof p.newContact === "object" ? (p.newContact as { fullName: string; email?: string; title?: string }) : undefined;
    const { moveDealToStage } = await import("@/lib/deals/stage-service"); // lazy: deals → approvals → deals cycle
    const r = await moveDealToStage(
      user,
      approval.entityId,
      { id: toStageId },
      { fields, newContact: nc, reasonCode: str(p.reasonCode), reasonText: str(p.reasonText) ?? str(p.reason) },
      { approved: true, via: "approval" },
    );
    if (!r.moved) throw new UserError("The deal is already in that stage.");
  },
});

// Proposal approval (PRD M14 / NS-29).
registerApprovalHandler("proposal", {
  canDecide: async (user, a) => {
    const scope = await scopeFor(user, "proposals", "approve");
    if (SCOPE_RANK[scope] < SCOPE_RANK.own) return false;
    const [p] = await db.select({ dealId: s.proposals.dealId }).from(s.proposals).where(eq(s.proposals.id, a.entityId));
    if (!p) return false;
    const [d] = await dealsFor([p.dealId]);
    if (!d) return false;
    if (d.restricted && !(await canSeeRestricted(user, "deal", d.id))) return false;
    return inScope(user, scope, { ownerId: d.ownerId, teamId: d.teamId, pipelineKey: d.pipelineKey });
  },
  label: async (user, a) => {
    const [p] = await db.select({ dealId: s.proposals.dealId, version: s.proposals.version }).from(s.proposals).where(eq(s.proposals.id, a.entityId));
    if (!p) return null;
    const [d] = await dealsFor([p.dealId]);
    if (!d) return null;
    const name = d.restricted && !(await canSeeRestricted(user, "deal", d.id)) ? "Restricted deal" : d.name;
    return `Proposal v${p.version} · ${name}`;
  },
  apply: async ({ approval, decision, user, note }) => {
    const [before] = await db.select().from(s.proposals).where(eq(s.proposals.id, approval.entityId));
    if (!before) return;
    const [after] = await db
      .update(s.proposals)
      .set(decision === "approved" ? { status: "approved", approvedBy: user.id } : { status: "draft", approvalReason: note ?? before.approvalReason })
      .where(eq(s.proposals.id, approval.entityId))
      .returning();
    await audit({ actorId: user.id, action: `proposal.${decision}`, entity: "proposal", entityId: approval.entityId, before, after });
  },
  resolvesAlerts: (a) => ({ ruleCode: "NS-29", entity: "proposal", entityIds: [a.entityId] }),
});

// Commission lead registration (PRD M18 / COM-6): same rule and side effects as Commissions → Registrations
// (accounts.assign = all; protection window, account owner if unowned, requester notified).
registerApprovalHandler("lead_registration", {
  canDecide: async (user) => (await scopeFor(user, "accounts", "assign")) === "all",
  label: async (_user, a) => {
    const [r] = await db
      .select({ account: s.accounts.name })
      .from(s.leadRegistrations)
      .innerJoin(s.accounts, eq(s.accounts.id, s.leadRegistrations.accountId))
      .where(eq(s.leadRegistrations.id, a.entityId));
    return r ? `Registration · ${r.account}` : null;
  },
  apply: async ({ approval, decision, user, note }) => {
    await applyRegistrationDecision(user, approval.entityId, decision, note, { syncApproval: false });
  },
});

// Scout budget request (AT-13), created by Lead Scout's "Request more budget": routed to SVP/exec — scout.assign ≥ team
// covering the requester. Semantics (src/lib/scout/budget.ts): an APPROVED scout_budget row for the same user + entity
// is a one-time override that lifts the per-run/user cap up to payload.amountCents for the next run on that entity
// (consumed via payload.consumedRunId) — so approving needs no extra side effect. A payload.monthlyCents (admin-style
// request) additionally sets the user's standing monthly cap.
registerApprovalHandler("scout_budget", {
  canDecide: async (user, a) => {
    const scope = await scopeFor(user, "scout", "assign");
    if (SCOPE_RANK[scope] < SCOPE_RANK.team) return false;
    return inScope(user, scope, { ownerId: typeof a.payload?.userId === "string" ? a.payload.userId : a.requestedBy });
  },
  label: async (_user, a) => {
    const cents = typeof a.payload?.amountCents === "number" ? a.payload.amountCents : typeof a.payload?.monthlyCents === "number" ? a.payload.monthlyCents : null;
    const who = typeof a.payload?.requesterName === "string" ? a.payload.requesterName : null;
    const what = a.entity === "account" ? "enrichment" : "Lead Scout run";
    return `Scout budget${cents != null ? ` · $${(cents / 100).toFixed(2)}` : ""} for ${what}${who ? ` · ${who}` : ""}`;
  },
  apply: async ({ approval, decision, user }) => {
    if (decision !== "approved") return;
    const target = typeof approval.payload?.userId === "string" ? approval.payload.userId : approval.requestedBy;
    const cents = approval.payload?.monthlyCents;
    if (typeof cents !== "number" || !Number.isFinite(cents) || cents < 0) return; // one-time override: status is enough
    const [before] = await db.select({ c: s.user.monthlyScoutBudgetCents }).from(s.user).where(eq(s.user.id, target));
    await db.update(s.user).set({ monthlyScoutBudgetCents: Math.round(cents) }).where(eq(s.user.id, target));
    await audit({ actorId: user.id, action: "user.scout_budget_set", entity: "user", entityId: target, before, after: { c: Math.round(cents) } });
  },
});

// Scout suggested targets (roles without scout edit, e.g. interns): payload { candidateIds, domains, pipelineKey }.
// Approver needs scout edit covering the requester's searches; approving accepts the candidates through Lead Scout's
// accept service (account + Target deal, ownership protection) with the requester as owner.
registerApprovalHandler("scout_accept", {
  canDecide: async (user, a) => {
    const scope = await scopeFor(user, "scout", "edit");
    if (scope === "all" || scope === "pipeline") return true;
    if (scope === "team") return user.teamMemberIds.includes(a.requestedBy);
    return false;
  },
  label: async (_user, a) => {
    const domains = Array.isArray(a.payload?.domains) ? (a.payload.domains as unknown[]).filter((d): d is string => typeof d === "string") : [];
    if (!domains.length) return "Suggested Lead Scout targets";
    return `Suggested targets · ${domains.slice(0, 3).join(", ")}${domains.length > 3 ? ` +${domains.length - 3}` : ""}`;
  },
  apply: async ({ approval, decision, user }) => {
    if (decision !== "approved") return;
    const ids = Array.isArray(approval.payload?.candidateIds) ? (approval.payload.candidateIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (!ids.length) throw new UserError("No candidates on this request.");
    const pk = approval.payload?.pipelineKey;
    const pipelineKey = pk === "NET" || pk === "SPT" || pk === "ENT" ? pk : undefined;
    const outcomes = await acceptCandidatesAs(user, { ids: ids.slice(0, 200), pipelineKey, ownerId: approval.requestedBy, enrich: false });
    if (outcomes.length && outcomes.every((o) => !o.ok)) throw new UserError(`Could not accept: ${outcomes.map((o) => `${o.domain}: ${o.message}`).slice(0, 3).join("; ")}`);
    await audit({ actorId: user.id, action: "scout_candidate.accept_approved", entity: "approval", entityId: approval.id, after: { outcomes } });
  },
});
