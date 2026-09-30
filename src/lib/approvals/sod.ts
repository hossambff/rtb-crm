import "server-only";
import { getSetting } from "@/lib/settings";
import { ForbiddenError, type AppUser } from "@/lib/rbac/server";
import { ALLOW_SELF_SUPER_ADMIN_KEY, SELF_DECISION_MESSAGE, selfDecisionAllowed } from "./sod-core";

export async function mayDecideOwn(user: AppUser, requesterId: string | null | undefined): Promise<boolean> {
  if (!requesterId || requesterId !== user.id) return true;
  const allowSelfSuperAdmin = await getSetting<unknown>(ALLOW_SELF_SUPER_ADMIN_KEY, false);
  return selfDecisionAllowed({ requesterId, userId: user.id, role: user.role, allowSelfSuperAdmin });
}

/** Throws unless `user` may decide a request raised by `requesterId` (SEC M-9 / QA-14). */
export async function assertNotSelfDecision(user: AppUser, requesterId: string | null | undefined): Promise<void> {
  if (!(await mayDecideOwn(user, requesterId))) throw new ForbiddenError(SELF_DECISION_MESSAGE);
}
