import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { createAuthUser } from "@/lib/auth/admin-ops";
import { emailDomainAllowed } from "@/lib/env";
import { ForbiddenError } from "@/lib/rbac/server";
import { isPlaceholderEmail } from "./claim-plan";

export type ProvisionInput = {
  email: string;
  name: string;
  title?: string | null;
  role: string;
  teamId: string | null;
  managerId: string | null;
  employmentType: (typeof s.employmentType.enumValues)[number];
  accessExpiresAt?: string | null;
};

/** Allowed sign-in domains: env + Admin → Settings. */
export async function allowedDomainList(): Promise<string[]> {
  const rows = await db.select({ d: s.allowedDomains.domain }).from(s.allowedDomains);
  return rows.map((r) => r.d.toLowerCase());
}

/**
 * AUTH-3 core: pre-provision a Workspace user (no password — they sign in with Google; the pre-assigned role applies).
 * Callers MUST authorize first (Admin → Users: requireAdmin + Super Admin for admin-level roles; Team setup: the
 * leader's own team and seller roles only). Validates domain, placeholder emails, team and manager; audited.
 */
export async function provisionUser(actorId: string, input: ProvisionInput, auditAction = "admin.user.provision"): Promise<{ id: string }> {
  const domains = await allowedDomainList();
  if (!emailDomainAllowed(input.email, domains)) throw new UserError("That email isn't on an allowed sign-in domain (Admin → Settings).");
  if (isPlaceholderEmail(input.email)) throw new UserError("Use the person's real Workspace email.");
  if (input.teamId) {
    const [t] = await db.select({ id: s.teams.id }).from(s.teams).where(eq(s.teams.id, input.teamId));
    if (!t) throw new UserError("Team not found.");
  }
  if (input.managerId) {
    const [m] = await db.select({ banned: s.user.banned }).from(s.user).where(eq(s.user.id, input.managerId));
    if (!m || m.banned) throw new UserError("Manager must be an active user.");
  }
  let id: string;
  try {
    id = (await createAuthUser({ email: input.email, name: input.name })).id;
  } catch (e) {
    const msg = (e as { body?: { message?: string }; message?: string })?.body?.message ?? (e as Error)?.message ?? "";
    if (/exist/i.test(msg)) throw new UserError("A user with that email already exists.");
    if (/domain|allowed/i.test(msg)) throw new UserError(msg);
    if (/permission|not allowed|forbidden/i.test(msg)) throw new ForbiddenError();
    throw e;
  }
  // The sign-up hook forces new users to "pending"; apply the inviter's choices now.
  const [after] = await db
    .update(s.user)
    .set({
      role: input.role,
      title: input.title || null,
      teamId: input.teamId,
      managerId: input.managerId,
      employmentType: input.employmentType,
      accessExpiresAt: input.accessExpiresAt ? new Date(input.accessExpiresAt) : null,
      emailVerified: true,
    })
    .where(eq(s.user.id, id))
    .returning();
  await audit({
    actorId,
    action: auditAction,
    entity: "user",
    entityId: id,
    before: null,
    after: after
      ? { name: after.name, email: after.email, role: after.role, title: after.title, teamId: after.teamId, managerId: after.managerId, employmentType: after.employmentType, accessExpiresAt: after.accessExpiresAt }
      : null,
  });
  return { id };
}
