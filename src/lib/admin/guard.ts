import "server-only";
import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { can, ForbiddenError, type AppUser } from "@/lib/rbac/server";

/**
 * Admin console guards (PRD §15, Appendix B "Admin / Config": super_admin = Cfg all, admin = Cfg (no security)).
 * - Config changes need admin:configure.
 * - Security-sensitive changes (permission matrix, field security, allowed domains, impersonation, granting
 *   admin-level roles) are super_admin only.
 * - Impersonation sessions are read-only for admin config (AUTH-7).
 */
export async function requireAdmin(user: AppUser): Promise<void> {
  if (user.impersonatedBy) throw new ForbiddenError("Admin changes are disabled while viewing as another user.");
  if (!(await can(user, "admin", "configure"))) throw new ForbiddenError();
}

export async function requireSuperAdmin(user: AppUser): Promise<void> {
  await requireAdmin(user);
  if (user.role !== "super_admin") throw new ForbiddenError("Only a Super Admin can change security settings.");
}

export async function isAdmin(user: AppUser): Promise<boolean> {
  return can(user, "admin", "configure");
}

export function isSuperAdmin(user: AppUser): boolean {
  return user.role === "super_admin";
}

/** Audit a configuration change (every config change is audited — PRD §15) and refresh the admin pages. */
export async function auditConfig(
  user: AppUser,
  action: string,
  entity: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
  path?: string,
) {
  await audit({ actorId: user.id, action, entity, entityId: entityId ?? undefined, before, after });
  if (path) revalidatePath(path);
}
