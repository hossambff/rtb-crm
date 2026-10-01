import "server-only";
import { can, ForbiddenError, type AppUser } from "@/lib/rbac/server";
import type { InviterKind } from "./core";

/**
 * Who may use Team setup, and over whom (no matrix module exists for it):
 * - admins (admin:configure) and executives: everyone; admins may invite and assign placeholders directly.
 * - sales leaders: their team (team members + direct reports — AppUser.teamMemberIds); may invite seller roles into
 *   their own team and set their team's quotas (never their own).
 * Impersonation sessions are read-only here (like the admin console).
 */
export type SetupScope = {
  kind: "all" | "team";
  memberIds: string[] | null; // null = everyone
  teamId: string | null;
  invite: InviterKind | null;
  isAdmin: boolean;
  readOnly: boolean;
};

export async function teamSetupScope(user: AppUser): Promise<SetupScope | null> {
  const isAdmin = await can(user, "admin", "configure");
  const readOnly = Boolean(user.impersonatedBy);
  if (isAdmin || user.role === "executive")
    return {
      kind: "all",
      memberIds: null,
      teamId: user.teamId,
      invite: isAdmin ? (user.role === "super_admin" ? "super_admin" : "admin") : null,
      isAdmin,
      readOnly,
    };
  if (user.role === "sales_leader") return { kind: "team", memberIds: user.teamMemberIds, teamId: user.teamId, invite: "leader", isAdmin: false, readOnly };
  return null;
}

export async function requireSetupScope(user: AppUser, opts: { write?: boolean } = {}): Promise<SetupScope> {
  const scope = await teamSetupScope(user);
  if (!scope) throw new ForbiddenError();
  if (opts.write && scope.readOnly) throw new ForbiddenError("Changes are disabled while viewing as another user.");
  return scope;
}

export function inSetupScope(scope: SetupScope, userId: string): boolean {
  return scope.memberIds === null || scope.memberIds.includes(userId);
}

/** Quotas: admins/executives set anyone's; leaders their team's, never their own. */
export function maySetQuotaFor(user: AppUser, scope: SetupScope, userId: string): boolean {
  if (!inSetupScope(scope, userId)) return false;
  if (scope.kind === "team" && userId === user.id) return false;
  return true;
}
