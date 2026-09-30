"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { auth } from "@/lib/auth";
import { emailDomainAllowed } from "@/lib/env";
import { ForbiddenError, type AppUser } from "@/lib/rbac/server";
import { requireAdmin, requireSuperAdmin } from "./guard";
import { claimPlaceholder as runClaim } from "./claim";
import { isPlaceholderEmail, summarize } from "./claim-plan";
import { countSuperAdmins, ownedRecordCounts } from "./user-queries";
import {
  changeRoleSchema,
  claimSchema,
  deactivateSchema,
  preProvisionSchema,
  PRIVILEGED_ROLES,
  updateUserOrgSchema,
  userIdSchema,
} from "./users-schemas";

const PATH = "/admin/users";
const isPrivileged = (role: string | null | undefined) => (PRIVILEGED_ROLES as readonly string[]).includes(role ?? "");

async function loadUser(id: string) {
  const [u] = await db.select().from(s.user).where(eq(s.user.id, id));
  if (!u) throw new UserError("User not found.");
  return u;
}

async function assertActiveUser(id: string | null, label: string) {
  if (!id) return;
  const [u] = await db.select({ id: s.user.id, banned: s.user.banned, email: s.user.email }).from(s.user).where(eq(s.user.id, id));
  if (!u || u.banned) throw new UserError(`${label} must be an active user.`);
}

async function assertTeam(id: string | null) {
  if (!id) return;
  const [t] = await db.select({ id: s.teams.id }).from(s.teams).where(eq(s.teams.id, id));
  if (!t) throw new UserError("Team not found.");
}

/** Only super admins may touch admin-level accounts or grant admin-level roles. */
async function guardTarget(actor: AppUser, targetRole: string | null, newRole?: string) {
  await requireAdmin(actor);
  if (isPrivileged(targetRole) || isPrivileged(newRole)) await requireSuperAdmin(actor);
}

function authError(e: unknown): never {
  const msg = (e as { body?: { message?: string }; message?: string })?.body?.message ?? (e as Error)?.message ?? "";
  if (/exist/i.test(msg)) throw new UserError("A user with that email already exists.");
  if (/domain|allowed/i.test(msg)) throw new UserError(msg);
  if (/permission|not allowed|forbidden/i.test(msg)) throw new ForbiddenError();
  throw e;
}

/** AUTH-3: pre-provision a Workspace user (no password — they sign in with Google; the pre-assigned role applies). */
export const preProvisionUser = action(preProvisionSchema, async (input, user) => {
  await guardTarget(user, null, input.role);
  const domains = await db.select({ d: s.allowedDomains.domain }).from(s.allowedDomains);
  if (!emailDomainAllowed(input.email, domains.map((r) => r.d))) throw new UserError("That email isn't on an allowed sign-in domain (Admin → Settings).");
  if (isPlaceholderEmail(input.email)) throw new UserError("Use the person's real Workspace email.");
  await assertTeam(input.teamId);
  await assertActiveUser(input.managerId, "Manager");
  let id: string;
  try {
    const res = await auth.api.createUser({ body: { email: input.email, name: input.name }, headers: await headers() });
    id = res.user.id;
  } catch (e) {
    authError(e);
  }
  // The sign-up hook forces new users to "pending"; apply the admin's choices now.
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
  await audit({ actorId: user.id, action: "admin.user.provision", entity: "user", entityId: id, before: null, after: publicUser(after) });
  revalidatePath(PATH);
  return { id };
});

export const changeRole = action(changeRoleSchema, async (input, user) => {
  const target = await loadUser(input.userId);
  await guardTarget(user, target.role, input.role);
  if (target.id === user.id) throw new UserError("You can't change your own role.");
  if (target.role === input.role) return { id: target.id };
  if (target.role === "super_admin" && (await countSuperAdmins(target.id)) === 0) throw new UserError("Keep at least one active Super Admin.");
  try {
    await auth.api.setRole({ body: { userId: target.id, role: input.role as never }, headers: await headers() });
  } catch (e) {
    authError(e);
  }
  await audit({ actorId: user.id, action: "admin.user.role", entity: "user", entityId: target.id, before: { role: target.role }, after: { role: input.role } });
  revalidatePath(PATH);
  return { id: target.id };
});

export const updateUserOrg = action(updateUserOrgSchema, async (input, user) => {
  const target = await loadUser(input.userId);
  await guardTarget(user, target.role);
  if (input.managerId === target.id) throw new UserError("A user can't manage themselves.");
  await assertTeam(input.teamId);
  await assertActiveUser(input.managerId, "Manager");
  const [after] = await db
    .update(s.user)
    .set({
      name: input.name,
      title: input.title || null,
      teamId: input.teamId,
      managerId: input.managerId,
      employmentType: input.employmentType,
      accessExpiresAt: input.accessExpiresAt ? new Date(input.accessExpiresAt) : null,
    })
    .where(eq(s.user.id, target.id))
    .returning();
  await audit({ actorId: user.id, action: "admin.user.update", entity: "user", entityId: target.id, before: publicUser(target), after: publicUser(after) });
  revalidatePath(PATH);
  return { id: target.id };
});

/** AUTH-6: deactivate → reassign open records, ban, revoke sessions and integration tokens. */
export const deactivateUser = action(deactivateSchema, async (input, user) => {
  const target = await loadUser(input.userId);
  await guardTarget(user, target.role);
  if (target.id === user.id) throw new UserError("You can't deactivate yourself.");
  if (target.role === "super_admin" && (await countSuperAdmins(target.id)) === 0) throw new UserError("Keep at least one active Super Admin.");
  const wantsReassign = Object.values(input.include).some(Boolean);
  if (wantsReassign && !input.reassignTo) throw new UserError("Choose who takes over the open records.");
  if (input.reassignTo === target.id) throw new UserError("Choose a different user to take over.");
  await assertActiveUser(input.reassignTo, "The new owner");

  const moved = { deals: 0, tasks: 0, accounts: 0, contacts: 0 };
  if (input.reassignTo && wantsReassign) {
    const to = input.reassignTo;
    await db.transaction(async (tx) => {
      if (input.include.deals)
        moved.deals = (
          await tx
            .update(s.deals)
            .set({ ownerId: to })
            .where(and(eq(s.deals.ownerId, target.id), isNull(s.deals.deletedAt), inArray(s.deals.status, ["open", "hold"])))
            .returning({ id: s.deals.id })
        ).length;
      if (input.include.tasks)
        moved.tasks = (
          await tx
            .update(s.tasks)
            .set({ assigneeId: to })
            .where(and(eq(s.tasks.assigneeId, target.id), eq(s.tasks.status, "open")))
            .returning({ id: s.tasks.id })
        ).length;
      if (input.include.accounts)
        moved.accounts = (
          await tx
            .update(s.accounts)
            .set({ ownerId: to })
            .where(and(eq(s.accounts.ownerId, target.id), isNull(s.accounts.deletedAt)))
            .returning({ id: s.accounts.id })
        ).length;
      if (input.include.contacts)
        moved.contacts = (
          await tx
            .update(s.contacts)
            .set({ ownerId: to })
            .where(and(eq(s.contacts.ownerId, target.id), isNull(s.contacts.deletedAt)))
            .returning({ id: s.contacts.id })
        ).length;
    });
  }
  const h = await headers();
  try {
    await auth.api.banUser({ body: { userId: target.id, banReason: input.reason || "Deactivated by admin" }, headers: h });
    await auth.api.revokeUserSessions({ body: { userId: target.id }, headers: h });
  } catch (e) {
    authError(e);
  }
  // Stop mailbox sync / API usage: mark the user's integrations revoked (tokens stay encrypted, unusable).
  await db.update(s.integrationConnections).set({ status: "revoked" }).where(eq(s.integrationConnections.userId, target.id));
  await audit({
    actorId: user.id,
    action: "admin.user.deactivate",
    entity: "user",
    entityId: target.id,
    before: { banned: Boolean(target.banned) },
    after: { banned: true, reason: input.reason ?? null, reassignedTo: input.reassignTo, moved },
  });
  revalidatePath(PATH);
  return moved;
});

export const reactivateUser = action(userIdSchema, async (input, user) => {
  const target = await loadUser(input.userId);
  await guardTarget(user, target.role);
  if (isPlaceholderEmail(target.email)) throw new UserError("Placeholders can't be reactivated — claim them into a real user.");
  try {
    await auth.api.unbanUser({ body: { userId: target.id }, headers: await headers() });
  } catch (e) {
    authError(e);
  }
  await db.update(s.integrationConnections).set({ status: "error", lastError: "Reconnect required after reactivation" }).where(eq(s.integrationConnections.userId, target.id));
  await audit({ actorId: user.id, action: "admin.user.reactivate", entity: "user", entityId: target.id, before: { banned: true }, after: { banned: false } });
  revalidatePath(PATH);
  return { id: target.id };
});

export const revokeSessions = action(userIdSchema, async (input, user) => {
  const target = await loadUser(input.userId);
  await guardTarget(user, target.role);
  try {
    await auth.api.revokeUserSessions({ body: { userId: target.id }, headers: await headers() });
  } catch (e) {
    authError(e);
  }
  await audit({ actorId: user.id, action: "admin.user.revoke_sessions", entity: "user", entityId: target.id });
  revalidatePath(PATH);
  return { id: target.id };
});

/** AUTH-7: "view as" — super admin only, fully audited (logged before the session switches). */
export const impersonateUser = action(userIdSchema, async (input, user) => {
  await requireSuperAdmin(user);
  const target = await loadUser(input.userId);
  if (target.id === user.id) throw new UserError("You're already signed in as yourself.");
  if (target.banned) throw new UserError("Can't impersonate a deactivated user.");
  if (target.role === "super_admin") throw new UserError("Super Admin accounts can't be impersonated.");
  await audit({ actorId: user.id, action: "admin.user.impersonate", entity: "user", entityId: target.id, after: { email: target.email, role: target.role } });
  try {
    await auth.api.impersonateUser({ body: { userId: target.id }, headers: await headers() });
  } catch (e) {
    authError(e);
  }
  return { redirect: "/home" };
});

export const loadOwnedCounts = action(userIdSchema, async (input, user) => {
  await requireAdmin(user);
  return ownedRecordCounts(input.userId);
});

/** Claim an import placeholder ("Chris", "Will"…) into a real user: re-points every owned record. */
export const claimPlaceholder = action(claimSchema, async (input, user) => {
  await requireAdmin(user);
  const [ph, target] = await Promise.all([loadUser(input.placeholderId), loadUser(input.targetUserId)]);
  if (isPrivileged(target.role)) await requireSuperAdmin(user);
  const counts = await runClaim(ph.id, target.id);
  await audit({
    actorId: user.id,
    action: "admin.user.claim_placeholder",
    entity: "user",
    entityId: target.id,
    before: { placeholderId: ph.id, placeholderEmail: ph.email, placeholderName: ph.name },
    after: { claimedInto: target.email, counts },
  });
  revalidatePath(PATH);
  return { summary: summarize(counts) };
});

function publicUser(u: typeof s.user.$inferSelect | undefined) {
  if (!u) return null;
  return {
    name: u.name,
    email: u.email,
    role: u.role,
    title: u.title,
    teamId: u.teamId,
    managerId: u.managerId,
    employmentType: u.employmentType,
    accessExpiresAt: u.accessExpiresAt,
    banned: u.banned,
  };
}
