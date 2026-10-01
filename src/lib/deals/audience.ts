import "server-only";
import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import type { Action } from "@/lib/rbac/model";
import { dealModule, inScope, scopeFor, type AppUser } from "@/lib/rbac/server";
import { buildDirectory, type DirectoryUser } from "./audience-core";

export type { DirectoryUser } from "./audience-core";

/**
 * Permission audience of a deal: which users could open it (mentions), edit it (handoff receivers), etc.
 * Evaluates exactly the rules dealAccessWhere / loadDealForWrite apply (role matrix scope on the pipeline's deal module
 * + inScope on owner/team/splits + the restricted access list), but for every active user at once.
 */

/** All active users with their team view (request-cached). */
export const loadDirectory = cache(async (): Promise<DirectoryUser[]> => {
  const [users, teams] = await Promise.all([
    db
      .select({
        id: s.user.id,
        name: s.user.name,
        email: s.user.email,
        image: s.user.image,
        role: s.user.role,
        teamId: s.user.teamId,
        managerId: s.user.managerId,
        employmentType: s.user.employmentType,
        timezone: s.user.timezone,
        banned: s.user.banned,
      })
      .from(s.user),
    db.select({ id: s.teams.id, pipelineTypes: s.teams.pipelineTypes }).from(s.teams),
  ]);
  return buildDirectory(users, teams);
});

export async function directoryUser(id: string | null | undefined): Promise<DirectoryUser | null> {
  if (!id) return null;
  return (await loadDirectory()).find((u) => u.id === id) ?? null;
}

export type DealAudienceRecord = { id: string; ownerId: string | null; teamId: string | null; restricted: boolean; pipelineKey: string; splitUserIds: string[] };

/** Load what the audience check needs for one deal (no permission check — callers have checked the caller already). */
export async function dealAudienceRecord(dealId: string): Promise<DealAudienceRecord | null> {
  const [d] = await db
    .select({ id: s.deals.id, ownerId: s.deals.ownerId, teamId: s.deals.teamId, restricted: s.deals.restricted, pipelineKey: s.pipelines.key, deletedAt: s.deals.deletedAt })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .where(eq(s.deals.id, dealId));
  if (!d || d.deletedAt) return null;
  const splits = await db.select({ userId: s.dealSplits.userId }).from(s.dealSplits).where(eq(s.dealSplits.dealId, dealId));
  return { id: d.id, ownerId: d.ownerId, teamId: d.teamId, restricted: d.restricted, pipelineKey: d.pipelineKey, splitUserIds: splits.map((x) => x.userId) };
}

async function restrictedList(dealId: string): Promise<Set<string>> {
  const rows = await db
    .select({ u: s.restrictedAccess.userId })
    .from(s.restrictedAccess)
    .where(and(eq(s.restrictedAccess.entity, "deal"), eq(s.restrictedAccess.entityId, dealId)));
  return new Set(rows.map((r) => r.u));
}

/** Can `u` perform `action` on the deal (matrix scope + record scope + restricted list)? */
export async function userCanOnDeal(u: AppUser, deal: DealAudienceRecord, action: Action, access?: Set<string>): Promise<boolean> {
  if (deal.restricted && u.role !== "super_admin") {
    const list = access ?? (await restrictedList(deal.id));
    if (!list.has(u.id)) return false;
  }
  const scope = await scopeFor(u, dealModule(deal.pipelineKey), action);
  return inScope(u, scope, { ownerId: deal.ownerId, teamId: deal.teamId, splitUserIds: deal.splitUserIds, pipelineKey: deal.pipelineKey });
}

/**
 * Users who can `action` the deal. For "edit" with `asOwner`, the check is evaluated as if the user owned the deal
 * (handoff receivers: after accepting they own it, so "own" scope is enough).
 */
export async function dealAudience(deal: DealAudienceRecord, action: Action = "view", opts: { asOwner?: boolean } = {}): Promise<DirectoryUser[]> {
  const [dir, access] = await Promise.all([loadDirectory(), deal.restricted ? restrictedList(deal.id) : Promise.resolve(new Set<string>())]);
  const out: DirectoryUser[] = [];
  for (const u of dir) {
    const rec = opts.asOwner ? { ...deal, ownerId: u.id } : deal;
    if (await userCanOnDeal(u, rec, action, access)) out.push(u);
  }
  return out;
}
