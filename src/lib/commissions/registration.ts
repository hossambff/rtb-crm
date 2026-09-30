/** Lead registration rules (PRD COM-6). Pure — unit tested. */

export type RegistrationConflict = {
  kind: "owned" | "open_deal" | "active_registration" | "own_registration" | "restricted" | "unavailable";
  severity: "block" | "warn";
  message: string;
};

export function registrationConflicts(p: {
  userId: string;
  account: { ownerId: string | null; restricted: boolean };
  openDeals: { ownerId: string | null; pipelineName: string; stageName: string; hidden?: boolean }[];
  registrations: { userId: string; status: string; protectedUntil: Date | null }[];
  now: Date;
}): RegistrationConflict[] {
  const out: RegistrationConflict[] = [];
  if (p.account.restricted) out.push({ kind: "restricted", severity: "block", message: "This account is restricted and cannot be registered." });
  const active = p.registrations.filter((r) => registrationState(r, p.now) === "pending" || registrationState(r, p.now) === "protected");
  const mine = active.find((r) => r.userId === p.userId);
  if (mine) out.push({ kind: "own_registration", severity: "block", message: "You already have an active registration for this account." });
  const others = active.filter((r) => r.userId !== p.userId);
  if (others.some((r) => registrationState(r, p.now) === "protected"))
    out.push({ kind: "active_registration", severity: "block", message: "Another rep holds protected ownership of this account." });
  else if (others.length)
    out.push({ kind: "active_registration", severity: "warn", message: "Another registration is pending review; a manager will decide." });
  if (p.account.ownerId && p.account.ownerId !== p.userId)
    out.push({ kind: "owned", severity: "warn", message: "The account already has an owner; your request is routed to a manager." });
  for (const d of p.openDeals.filter((d) => d.ownerId !== p.userId).slice(0, 3))
    out.push({
      kind: "open_deal",
      severity: "warn",
      message: d.hidden ? "An open deal exists on this account in another team's pipeline." : `Open ${d.pipelineName} deal in "${d.stageName}".`,
    });
  return out;
}

/** SEC M-1: the only thing a caller without restricted access learns about a restricted account (no name, no kind). */
export const UNAVAILABLE_ACCOUNT_CONFLICT: RegistrationConflict = {
  kind: "unavailable",
  severity: "block",
  message: "This account can't be registered. Ask a manager.",
};

export type RegistrationState = "pending" | "protected" | "expired" | "rejected" | "expiring";

/** Effective state of a registration at `now` (approved + past protectedUntil = expired). */
export function registrationState(r: { status: string; protectedUntil: Date | null }, now: Date): Exclude<RegistrationState, "expiring"> {
  if (r.status === "pending") return "pending";
  if (r.status === "rejected") return "rejected";
  if (r.status === "expired") return "expired";
  if (r.status === "approved") return r.protectedUntil && r.protectedUntil.getTime() < now.getTime() ? "expired" : "protected";
  return "expired";
}

export function daysLeft(until: Date | null, now: Date): number | null {
  if (!until) return null;
  return Math.ceil((until.getTime() - now.getTime()) / 86_400_000);
}

export function protectUntil(now: Date, days: number): Date {
  return new Date(now.getTime() + Math.max(1, days) * 86_400_000);
}
