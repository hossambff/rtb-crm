import "server-only";
import { cache } from "react";
import { limited, limitedAll } from "./limit";
import { and, eq, exists, inArray, not, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { isFieldHidden } from "@/lib/rbac/model";
import { can, dealAccessWhere, scopeFor, type AppUser } from "@/lib/rbac/server";
import type { AnalyticsFilters } from "./filters";

/**
 * Permission scoping for analytics (PRD §7.2, §14.1: "Charts are role-scoped. Commission reps see only their own").
 * Deal numbers = dealAccessWhere(user, "view") ∩ analytics:view scope (own / team / pipeline / all) ∩ filters.
 */
export type AnalyticsContext = {
  user: AppUser;
  scope: "own" | "team" | "pipeline" | "all";
  /** null = any owner; otherwise the owner ids whose records the user may analyse. */
  ownerIds: string[] | null;
  filters: AnalyticsFilters;
  /** Revenue share is hidden from this role → net basis would leak it; force gross. */
  netAllowed: boolean;
  guaranteeAllowed: boolean;
  revenueAllowed: boolean;
  scoutAllowed: boolean;
  /** Org-level aggregates (snapshots, budgets) are only shown to users who can see everything. */
  orgWide: boolean;
};

export async function analyticsContext(user: AppUser, filters: AnalyticsFilters): Promise<AnalyticsContext | null> {
  const scope = await scopeFor(user, "analytics", "view");
  if (scope === "none") return null;
  const ownerIds = scope === "own" ? [user.id] : scope === "team" ? (user.teamMemberIds.length ? user.teamMemberIds : [user.id]) : null;
  const netAllowed = !isFieldHidden(user.role, "deal", "revSharePct");
  const [revenueAllowed, scoutAllowed] = await limitedAll([can(user, "revenue", "view"), can(user, "scout", "view")]);
  // Owner filter must stay inside the allowed set.
  let owner = filters.owner;
  if (owner && ownerIds && !ownerIds.includes(owner)) owner = null;
  return {
    user,
    scope,
    ownerIds,
    filters: { ...filters, owner, basis: netAllowed ? filters.basis : "gross" },
    netAllowed,
    guaranteeAllowed: !isFieldHidden(user.role, "deal", "guaranteeMonthlyCents"),
    revenueAllowed,
    scoutAllowed,
    orgWide: scope === "all" && !owner && !filters.pipeline,
  };
}

/** dealAccessWhere is computed once per request (every loader needs it; avoids a burst of identical queries). */
const dealViewAccess = cache((user: AppUser) => dealAccessWhere(user, "view"));

/** WHERE for deals (joined with pipelines) respecting access, analytics scope and the pipeline/owner filters. */
export async function dealScopeWhere(ctx: AnalyticsContext, opts: { ignorePipelineFilter?: boolean } = {}): Promise<SQL> {
  const access = await dealViewAccess(ctx.user);
  const parts: SQL[] = [access];
  if (ctx.ownerIds) {
    const ids = ctx.ownerIds;
    parts.push(
      or(
        inArray(s.deals.ownerId, ids),
        exists(db.select({ x: sql`1` }).from(s.dealSplits).where(and(eq(s.dealSplits.dealId, s.deals.id), inArray(s.dealSplits.userId, ids)))),
      )!,
    );
  } else if (ctx.scope === "pipeline" && ctx.user.teamPipelineKeys.length) {
    parts.push(inArray(s.pipelines.key, ctx.user.teamPipelineKeys));
  }
  if (ctx.filters.pipeline && !opts.ignorePipelineFilter) parts.push(eq(s.pipelines.key, ctx.filters.pipeline));
  if (ctx.filters.owner) parts.push(eq(s.deals.ownerId, ctx.filters.owner));
  return and(...parts)!;
}

/** Owner-id filter for user-attributed rows (activities.actorId, tasks.assigneeId, agent_runs.userId …). */
export function ownerFilter(ctx: AnalyticsContext, col: AnyPgColumn): SQL {
  if (ctx.filters.owner) return eq(col, ctx.filters.owner);
  if (ctx.ownerIds) return inArray(col, ctx.ownerIds);
  return sql`true`;
}

/** Hide restricted accounts from brand-level lists unless the user is on the access list. */
export function accountVisibleWhere(user: AppUser): SQL {
  if (user.role === "super_admin") return sql`true`;
  return or(
    not(s.accounts.restricted),
    exists(
      db
        .select({ x: sql`1` })
        .from(s.restrictedAccess)
        .where(and(eq(s.restrictedAccess.entity, "account"), eq(s.restrictedAccess.entityId, s.accounts.id), eq(s.restrictedAccess.userId, user.id))),
    ),
  )!;
}

/** Users the owner filter may offer (within scope). Placeholder owners from imports are included — they own deals. */
export async function ownerOptions(ctx: AnalyticsContext): Promise<{ id: string; name: string }[]> {
  if (ctx.scope === "own") return [];
  const where = ctx.ownerIds ? inArray(s.user.id, ctx.ownerIds) : sql`true`;
  return limited(db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(where).orderBy(s.user.name));
}
