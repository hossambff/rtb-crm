/**
 * Approval routing for restricted (MNPI) subjects (QA MIN-36). Pure — unit tested; the server side is ./routing.ts.
 *
 * Approvers are picked by role, and most of them are not on a restricted deal's / account's access list: they could
 * neither open nor decide the request. So for a restricted subject only approvers who may see it are notified; when
 * none of them can, the request goes to the super_admins (who see every restricted record) under a neutral title.
 */

export type RestrictionFacts = {
  dealRestricted: boolean;
  accountRestricted: boolean;
  /** User ids on the deal's access list. */
  dealList: ReadonlySet<string>;
  /** User ids on the account's access list. */
  accountList: ReadonlySet<string>;
  superAdmins: ReadonlySet<string>;
};

/** May `userId` see the restricted subject? (super_admin, else on the relevant access lists — like dealAccessWhere.) */
export function maySeeRestrictedSubject(userId: string, f: RestrictionFacts): boolean {
  if (f.superAdmins.has(userId)) return true;
  const dealOk = !f.dealRestricted || f.dealList.has(userId);
  const accountOk = !f.accountRestricted || f.accountList.has(userId) || f.dealList.has(userId);
  return dealOk && accountOk;
}

/**
 * The recipients for a restricted approval: the candidates who may see it, or — when none may — every super_admin
 * except `exclude` (the requester). `fallback` tells the caller to use a neutral "needs an approver" title.
 */
export function routeRestrictedApprovers(candidates: string[], f: RestrictionFacts, exclude?: string | null): { recipients: string[]; fallback: boolean } {
  const allowed = Array.from(new Set(candidates.filter((id) => id !== exclude && maySeeRestrictedSubject(id, f))));
  if (allowed.length) return { recipients: allowed, fallback: false };
  return { recipients: [...f.superAdmins].filter((id) => id !== exclude), fallback: true };
}

/** Neutral title for the super_admin fallback (no names, no kind-specific details beyond the kind label). */
export function restrictedFallbackTitle(kindLabel: string): string {
  return `Approval needs a reviewer: ${kindLabel} on a restricted record (no approver on its access list)`;
}
