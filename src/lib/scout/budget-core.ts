/**
 * Apify budget governance (PRD SCOUT-3, SCOUT-21; pilot caps per D8). Pure — unit tested.
 * Server code supplies spend totals; this decides allow / block and why.
 */

export type BudgetSettings = {
  orgMonthlyCents: number;
  userMonthlyCents: number;
  execMonthlyCents: number;
  perRunMaxCents: number;
  maxDomainsPerRun: number;
};

export const DEFAULT_BUDGET: BudgetSettings = { orgMonthlyCents: 500, userMonthlyCents: 200, execMonthlyCents: 500, perRunMaxCents: 50, maxDomainsPerRun: 50 };

/** Roles that get the higher "SVP/exec" per-user cap. */
export const EXEC_BUDGET_ROLES = ["super_admin", "admin", "executive", "sales_leader"];

export function normalizeBudget(raw: unknown): BudgetSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (k: keyof BudgetSettings) => (typeof r[k] === "number" && Number.isFinite(r[k]) && (r[k] as number) >= 0 ? (r[k] as number) : DEFAULT_BUDGET[k]);
  return {
    orgMonthlyCents: n("orgMonthlyCents"),
    userMonthlyCents: n("userMonthlyCents"),
    execMonthlyCents: n("execMonthlyCents"),
    perRunMaxCents: n("perRunMaxCents"),
    maxDomainsPerRun: Math.max(1, Math.round(n("maxDomainsPerRun"))),
  };
}

export function userCapCents(role: string, userOverrideCents: number | null | undefined, b: BudgetSettings): number {
  if (userOverrideCents != null && userOverrideCents >= 0) return userOverrideCents;
  return EXEC_BUDGET_ROLES.includes(role) ? b.execMonthlyCents : b.userMonthlyCents;
}

export type BudgetCheckInput = {
  estimateCents: number;
  orgSpentCents: number; // this month, incl. reserved (running) estimates
  userSpentCents: number;
  userCapCents: number;
  settings: BudgetSettings;
  /** An approved "request more budget" lifts the per-run and per-user caps for this one run (never the org cap). */
  approvedOverrideCents?: number | null;
};

export type BudgetBlock = "org_cap" | "user_cap" | "per_run";

export type BudgetDecision = {
  allowed: boolean;
  blockedBy: BudgetBlock | null;
  message: string;
  orgRemainingCents: number;
  userRemainingCents: number;
  /** Largest spend this run may make right now (min of all applicable caps). */
  maxAllowedCents: number;
  /** When blocked by per-run or user cap, a manager can approve more (org cap is a hard stop, D8). */
  canRequestMore: boolean;
};

export function checkBudget(i: BudgetCheckInput): BudgetDecision {
  const orgRemainingCents = Math.max(0, i.settings.orgMonthlyCents - i.orgSpentCents);
  const userRemainingCents = Math.max(0, i.userCapCents - i.userSpentCents);
  const override = i.approvedOverrideCents != null && i.approvedOverrideCents >= i.estimateCents ? i.approvedOverrideCents : null;
  const perRun = override ?? i.settings.perRunMaxCents;
  const userRoom = override != null ? orgRemainingCents : userRemainingCents;
  const maxAllowedCents = Math.max(0, Math.min(orgRemainingCents, userRoom, perRun));
  const base = { orgRemainingCents, userRemainingCents, maxAllowedCents };
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  if (i.estimateCents > orgRemainingCents)
    return { ...base, allowed: false, blockedBy: "org_cap", canRequestMore: false, message: `Estimated ${usd(i.estimateCents)} exceeds the ${usd(orgRemainingCents)} left in the org's ${usd(i.settings.orgMonthlyCents)} monthly Apify budget.` };
  if (override == null && i.estimateCents > i.settings.perRunMaxCents)
    return { ...base, allowed: false, blockedBy: "per_run", canRequestMore: true, message: `Estimated ${usd(i.estimateCents)} is over the ${usd(i.settings.perRunMaxCents)} per-run limit. Reduce the batch or request SVP approval.` };
  if (override == null && i.estimateCents > userRemainingCents)
    return { ...base, allowed: false, blockedBy: "user_cap", canRequestMore: true, message: `Estimated ${usd(i.estimateCents)} exceeds your remaining ${usd(userRemainingCents)} this month (cap ${usd(i.userCapCents)}).` };
  return { ...base, allowed: true, blockedBy: null, canRequestMore: false, message: `Estimated ${usd(i.estimateCents)} — within budget.` };
}

/** Cents estimate for `results` items at a per-result USD cost (always rounded up, min 1¢ when > 0). */
export function estimateCents(results: number, costPerResultUsd: number): number {
  if (results <= 0 || costPerResultUsd <= 0) return 0;
  return Math.max(1, Math.ceil(results * costPerResultUsd * 100));
}

/** How many domains fit in `budgetCents` given a per-domain cost in cents (fractional allowed). */
export function domainsWithinBudget(budgetCents: number, perDomainCents: number, maxDomains: number): number {
  if (perDomainCents <= 0) return maxDomains;
  return Math.max(0, Math.min(maxDomains, Math.floor(budgetCents / perDomainCents)));
}

export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
