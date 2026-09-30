import "server-only";
import { and, eq, exists, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealAccessWhere, ForbiddenError, inScope, scopeFor, type AppUser } from "@/lib/rbac/server";
import { isFieldHidden, type Action } from "@/lib/rbac/model";
import { getSetting } from "@/lib/settings";
import { DEFAULT_APPROVAL_RULES, type ApprovalRules } from "./calc";

/** SQL filter on proposals (joined to deals) for the user's proposals-module scope + deal visibility. */
export async function proposalWhere(user: AppUser, action: Action = "view"): Promise<SQL> {
  if (isFieldHidden(user.role, "proposal", "*")) return sql`false`;
  const [scope, visible] = await Promise.all([scopeFor(user, "proposals", action), dealAccessWhere(user, "view")]);
  const members = user.teamMemberIds.length ? user.teamMemberIds : [user.id];
  const split = (ids: string[]) =>
    exists(db.select({ x: sql`1` }).from(s.dealSplits).where(and(eq(s.dealSplits.dealId, s.deals.id), inArray(s.dealSplits.userId, ids))));
  let cond: SQL;
  switch (scope) {
    case "all":
    case "pipeline":
      cond = sql`true`;
      break;
    case "team":
      cond = or(inArray(s.deals.ownerId, members), inArray(s.proposals.createdBy, members), split(members))!;
      break;
    case "own":
      cond = or(eq(s.deals.ownerId, user.id), eq(s.proposals.createdBy, user.id), split([user.id]))!;
      break;
    default:
      cond = sql`false`;
  }
  return and(visible, cond)!;
}

/** Check the user can create/edit proposals on this deal (module scope on the deal record + deal visibility). */
export async function assertProposalDeal(user: AppUser, dealId: string, action: "create" | "edit") {
  if (isFieldHidden(user.role, "proposal", "*")) throw new ForbiddenError();
  const scope = await scopeFor(user, "proposals", action);
  if (scope === "none") throw new ForbiddenError();
  const [row] = await db
    .select({ deal: s.deals, pipelineKey: s.pipelines.key })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .where(and(eq(s.deals.id, dealId), await dealAccessWhere(user, "view")));
  if (!row) throw new ForbiddenError("Deal not found or not visible to you.");
  const splits = await db.select({ userId: s.dealSplits.userId }).from(s.dealSplits).where(eq(s.dealSplits.dealId, dealId));
  if (!inScope(user, scope, { ownerId: row.deal.ownerId, teamId: row.deal.teamId, splitUserIds: splits.map((x) => x.userId), pipelineKey: row.pipelineKey }))
    throw new ForbiddenError();
  return row;
}

export async function approvalRules(): Promise<ApprovalRules> {
  const v = await getSetting<Partial<ApprovalRules>>("proposal.approval_rules", DEFAULT_APPROVAL_RULES);
  return { ...DEFAULT_APPROVAL_RULES, ...(v && typeof v === "object" ? v : {}) };
}
