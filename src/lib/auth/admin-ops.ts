import "server-only";
import { auth } from "./index";

/**
 * SEC H-1: server-side user-lifecycle writes for the Admin → Users server actions.
 *
 * Only super_admin holds Better Auth admin statements, and /api/auth/admin/* mutations are blocked over HTTP. The app's
 * own actions (src/lib/admin/users-actions.ts) enforce the app rules (admin:configure, super_admin for privileged
 * roles, no self role change, keep one super admin) and audit, then call these helpers, which write through Better
 * Auth's internal adapter (the same writes the admin endpoints perform, database hooks included) without needing the
 * caller to hold Better Auth admin permissions. Never call these without the app-level guard.
 */
async function adapter() {
  return (await auth.$context).internalAdapter;
}

/** Pre-provision a user without a password (Google sign-in). The user.create hook forces role "pending". */
export async function createAuthUser(input: { email: string; name: string }): Promise<{ id: string }> {
  const a = await adapter();
  const email = input.email.trim().toLowerCase();
  if (await a.findUserByEmail(email)) throw new Error("A user with that email already exists.");
  const user = await a.createUser({ email, name: input.name }, { method: "admin" });
  return { id: user.id };
}

export async function setAuthUserRole(userId: string, role: string): Promise<void> {
  await (await adapter()).updateUser(userId, { role });
}

export async function banAuthUser(userId: string, reason: string): Promise<void> {
  const a = await adapter();
  await a.updateUser(userId, { banned: true, banReason: reason, banExpires: null });
  await a.deleteUserSessions(userId);
}

export async function unbanAuthUser(userId: string): Promise<void> {
  await (await adapter()).updateUser(userId, { banned: false, banReason: null, banExpires: null });
}

export async function revokeAuthUserSessions(userId: string): Promise<void> {
  await (await adapter()).deleteUserSessions(userId);
}
