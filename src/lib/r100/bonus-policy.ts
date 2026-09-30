/**
 * SEC M-14: the R100 bonus (`bonusCents`, `bonusEligible`) is the base of `r100_live` commission accruals, so reps must
 * not set it on their own deals. Only Finance, RevOps admins and sales leadership may change it. Pure — unit tested.
 */
export const R100_BONUS_EDITOR_ROLES = ["super_admin", "admin", "finance", "sales_leader"] as const;
export const R100_BONUS_FIELDS = ["bonusCents", "bonusEligible"] as const;

export function canEditR100Bonus(role: string): boolean {
  return (R100_BONUS_EDITOR_ROLES as readonly string[]).includes(role);
}

/** Bonus fields in `patch` whose value differs from `before` (unchanged echoes from the UI are fine). */
export function changedBonusFields(before: Record<string, unknown> | null | undefined, patch: Record<string, unknown>): string[] {
  return R100_BONUS_FIELDS.filter((k) => k in patch && patch[k] !== undefined && patch[k] !== (before ?? {})[k]);
}

export const R100_BONUS_FORBIDDEN = "Only Finance, admins or sales leadership can change the R100 bonus.";
