import "server-only";
import { and, eq, exists, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { canSeeRestricted, dealAccessWhere, inScope, scopeFor, type AppUser } from "@/lib/rbac/server";
import type { Action, Scope } from "@/lib/rbac/model";

/** SQL: deals within the user's revenue-module scope for `action`, intersected with normal deal visibility. */
export async function revenueDealWhere(user: AppUser, action: Action = "view"): Promise<SQL> {
  const [scope, visible] = await Promise.all([scopeFor(user, "revenue", action), dealAccessWhere(user, "view")]);
  return and(visible, scopeCond(user, scope))!;
}

function scopeCond(user: AppUser, scope: Scope): SQL {
  const members = user.teamMemberIds.length ? user.teamMemberIds : [user.id];
  const split = (ids: string[]) =>
    exists(db.select({ x: sql`1` }).from(s.dealSplits).where(and(eq(s.dealSplits.dealId, s.deals.id), inArray(s.dealSplits.userId, ids))));
  switch (scope) {
    case "all":
    case "pipeline":
      return sql`true`;
    case "team":
      return or(inArray(s.deals.ownerId, members), user.teamId ? eq(s.deals.teamId, user.teamId) : sql`false`, split(members))!;
    case "own":
      return or(eq(s.deals.ownerId, user.id), split([user.id]))!;
    default:
      return sql`false`;
  }
}

/** Assert the user can perform `action` on invoices of this deal. Returns the deal. */
export async function assertRevenueDeal(user: AppUser, dealId: string, action: Action) {
  const scope = await scopeFor(user, "revenue", action);
  if (scope === "none") return null;
  const [deal] = await db.select().from(s.deals).where(eq(s.deals.id, dealId));
  if (!deal || deal.deletedAt) return null;
  const splits = await db.select({ userId: s.dealSplits.userId }).from(s.dealSplits).where(eq(s.dealSplits.dealId, dealId));
  if (!inScope(user, scope, { ownerId: deal.ownerId, teamId: deal.teamId, splitUserIds: splits.map((x) => x.userId) })) return null;
  if (deal.restricted && !(await canSeeRestricted(user, "deal", deal.id))) return null;
  return deal;
}
