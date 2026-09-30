/**
 * Separation of duties (SEC M-9, QA-14) — pure rule, unit tested.
 *
 * The requester of an approval (proposal, lead registration, probability override, stage gate, …) can never decide it.
 * A super_admin may decide their own request only when the app setting `approvals.allow_self_super_admin` is
 * explicitly `true` (default false).
 */
export const ALLOW_SELF_SUPER_ADMIN_KEY = "approvals.allow_self_super_admin";

export function selfDecisionAllowed(p: { requesterId: string | null | undefined; userId: string; role: string; allowSelfSuperAdmin: unknown }): boolean {
  if (!p.requesterId || p.requesterId !== p.userId) return true;
  return p.role === "super_admin" && p.allowSelfSuperAdmin === true;
}

export const SELF_DECISION_MESSAGE = "You can't decide your own request — another approver has to review it.";
