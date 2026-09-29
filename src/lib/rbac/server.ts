import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { auth } from "@/lib/auth";
import { DEFAULT_MATRIX } from "./defaults";
import { PIPELINE_MODULE, ROLES, SCOPE_RANK, type Action, type Matrix, type Module, type Role, type Scope } from "./model";

export type AppUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
  teamId: string | null;
  teamPipelineKeys: string[];
  teamMemberIds: string[];
  employmentType: string | null;
  timezone: string;
  impersonatedBy: string | null;
};

export class ForbiddenError extends Error {
  constructor(message = "You don't have permission to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** Resolve the signed-in user (request-scoped cache). Returns null when signed out. */
export const getCurrentUser = cache(async (): Promise<AppUser | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const [u] = await db.select().from(s.user).where(eq(s.user.id, session.user.id));
  if (!u || u.banned) return null;
  let teamPipelineKeys: string[] = [];
  let teamMemberIds: string[] = [u.id];
  if (u.teamId) {
    const [team] = await db.select().from(s.teams).where(eq(s.teams.id, u.teamId));
    teamPipelineKeys = team?.pipelineTypes ?? [];
    const members = await db.select({ id: s.user.id }).from(s.user).where(eq(s.user.teamId, u.teamId));
    teamMemberIds = members.map((m) => m.id);
  }
  // Managers see their direct reports as "team" too.
  const reports = await db.select({ id: s.user.id }).from(s.user).where(eq(s.user.managerId, u.id));
  teamMemberIds = Array.from(new Set([...teamMemberIds, ...reports.map((r) => r.id)]));
  const role = (ROLES as readonly string[]).includes(u.role) ? (u.role as Role) : "pending";
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    image: u.image,
    role,
    teamId: u.teamId,
    teamPipelineKeys,
    teamMemberIds,
    employmentType: u.employmentType,
    timezone: u.timezone ?? "America/New_York",
    impersonatedBy: (session.session as { impersonatedBy?: string | null }).impersonatedBy ?? null,
  };
});

/** Use in server components/pages: redirects to sign-in / pending screen. */
export async function requireUser(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (user.role === "pending") redirect("/pending");
  return user;
}

/** Effective permission matrix for a role = code defaults overlaid with DB overrides. */
export const getMatrix = cache(async (role: Role): Promise<Matrix> => {
  const base: Matrix = structuredClone(DEFAULT_MATRIX[role] ?? {});
  const overrides = await db.select().from(s.rolePermissions).where(eq(s.rolePermissions.role, role));
  for (const o of overrides) {
    const mod = o.module as Module;
    base[mod] = { ...(base[mod] ?? {}), [o.action as Action]: o.scope as Scope };
  }
  return base;
});

export async function scopeFor(user: AppUser, module: Module, action: Action): Promise<Scope> {
  const matrix = await getMatrix(user.role);
  return matrix[module]?.[action] ?? "none";
}

export async function can(user: AppUser, module: Module, action: Action, min: Scope = "own"): Promise<boolean> {
  return SCOPE_RANK[await scopeFor(user, module, action)] >= SCOPE_RANK[min];
}

/** Throws ForbiddenError unless the user has at least `min` scope on module/action. Returns the granted scope. */
export async function assertCan(user: AppUser, module: Module, action: Action, min: Scope = "own"): Promise<Scope> {
  const scope = await scopeFor(user, module, action);
  if (SCOPE_RANK[scope] < SCOPE_RANK[min]) throw new ForbiddenError();
  return scope;
}

export function dealModule(pipelineKey: string): Module {
  return PIPELINE_MODULE[pipelineKey] ?? "deals_NET";
}

/** Does a concrete record fall inside `scope` for this user? */
export function inScope(
  user: AppUser,
  scope: Scope,
  record: { ownerId?: string | null; teamId?: string | null; splitUserIds?: string[]; pipelineKey?: string },
): boolean {
  switch (scope) {
    case "all":
      return true;
    case "pipeline":
      return record.pipelineKey ? user.teamPipelineKeys.includes(record.pipelineKey) || user.teamPipelineKeys.length === 0 : true;
    case "team":
      return (
        (record.ownerId != null && user.teamMemberIds.includes(record.ownerId)) ||
        (record.teamId != null && record.teamId === user.teamId) ||
        (record.splitUserIds ?? []).some((id) => user.teamMemberIds.includes(id))
      );
    case "own":
      return record.ownerId === user.id || (record.splitUserIds ?? []).includes(user.id);
    default:
      return false;
  }
}

/** Restricted (MNPI) records: only super_admin or explicit access-list members. */
export async function canSeeRestricted(user: AppUser, entity: "deal" | "account", entityId: string): Promise<boolean> {
  if (user.role === "super_admin") return true;
  const rows = await db
    .select({ u: s.restrictedAccess.userId })
    .from(s.restrictedAccess)
    .where(and(eq(s.restrictedAccess.entity, entity), eq(s.restrictedAccess.entityId, entityId), eq(s.restrictedAccess.userId, user.id)));
  return rows.length > 0;
}

/**
 * SQL filter for deals the user may perform `action` on, across all pipelines.
 * Combines per-pipeline scopes, ownership/splits/team, and restricted-record access lists.
 */
export async function dealAccessWhere(user: AppUser, action: Action = "view"): Promise<SQL> {
  const matrix = await getMatrix(user.role);
  const pipes = await db.select({ id: s.pipelines.id, key: s.pipelines.key }).from(s.pipelines);
  const clauses: SQL[] = [];
  const ownOrSplit = or(
    eq(s.deals.ownerId, user.id),
    exists(db.select({ x: sql`1` }).from(s.dealSplits).where(and(eq(s.dealSplits.dealId, s.deals.id), eq(s.dealSplits.userId, user.id)))),
  )!;
  const team = or(
    inArray(s.deals.ownerId, user.teamMemberIds.length ? user.teamMemberIds : [user.id]),
    user.teamId ? eq(s.deals.teamId, user.teamId) : sql`false`,
    exists(
      db
        .select({ x: sql`1` })
        .from(s.dealSplits)
        .where(and(eq(s.dealSplits.dealId, s.deals.id), inArray(s.dealSplits.userId, user.teamMemberIds.length ? user.teamMemberIds : [user.id]))),
    ),
  )!;
  for (const p of pipes) {
    const scope = matrix[dealModule(p.key)]?.[action] ?? "none";
    if (scope === "none") continue;
    let cond: SQL;
    if (scope === "all") cond = sql`true`;
    else if (scope === "pipeline") cond = user.teamPipelineKeys.length === 0 || user.teamPipelineKeys.includes(p.key) ? sql`true` : ownOrSplit;
    else if (scope === "team") cond = team;
    else cond = ownOrSplit;
    clauses.push(and(eq(s.deals.pipelineId, p.id), cond)!);
  }
  if (clauses.length === 0) return sql`false`;
  const restrictedOk =
    user.role === "super_admin"
      ? sql`true`
      : or(
          eq(s.deals.restricted, false),
          exists(
            db
              .select({ x: sql`1` })
              .from(s.restrictedAccess)
              .where(
                and(
                  eq(s.restrictedAccess.entity, "deal"),
                  eq(s.restrictedAccess.entityId, s.deals.id),
                  eq(s.restrictedAccess.userId, user.id),
                ),
              ),
          ),
        )!;
  return and(isNull(s.deals.deletedAt), or(...clauses)!, restrictedOk)!;
}

/** SQL filter for accounts/contacts style entities with ownerId. */
export async function ownedEntityWhere(
  user: AppUser,
  module: "accounts" | "contacts",
  action: Action,
  ownerCol: typeof s.accounts.ownerId | typeof s.contacts.ownerId,
): Promise<SQL> {
  const scope = await scopeFor(user, module, action);
  switch (scope) {
    case "all":
    case "pipeline":
      return sql`true`;
    case "team":
      return inArray(ownerCol, user.teamMemberIds.length ? user.teamMemberIds : [user.id]);
    case "own":
      return eq(ownerCol, user.id);
    default:
      return sql`false`;
  }
}
