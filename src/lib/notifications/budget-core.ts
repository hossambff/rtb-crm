/**
 * Alert budget (docs/V2_SPEC.md §B3) — pure delivery decision for one notification to one user. Unit tested.
 *
 * "Interrupting" = counts on the bell and may ping Slack. "Digest only" = stored, listed, bundled into the next daily
 * digest, but never pings. Critical alerts always interrupt. People-driven kinds (mentions, approvals, assigned tasks,
 * handoffs, help requests, assignments) are never budgeted — somebody is waiting on them. Only machine-generated noise
 * ("alert", "system": autopilot summaries, meeting briefs, sweeps) counts against and is held back by the budget.
 */
export type Severity = "info" | "warning" | "serious" | "critical";
const RANK: Record<Severity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };

/** Kinds the budget applies to (machine-generated noise). */
export const BUDGETED_KINDS = ["alert", "system"] as const;
export function isBudgetedKind(kind: string): boolean {
  return (BUDGETED_KINDS as readonly string[]).includes(kind);
}

export const MIN_BUDGET = 1;
export const MAX_BUDGET = 10;
export function clampBudget(n: unknown, fallback = 3): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, v));
}

export type DeliveryInput = {
  kind: string;
  severity?: Severity | null;
  /** Interrupting budgeted notifications this user already received today (user's local day). */
  sentToday: number;
  budget: number;
  /** User's "Alert me from" setting; alerts below it are bundled. */
  minSeverity?: Severity | null;
  /** Local hour 0..23 in the user's zone and their quiet hours (start === end → none). */
  localHour?: number | null;
  quietStart?: number | null;
  quietEnd?: number | null;
};

export type DeliveryDecision = { digestOnly: boolean; slack: boolean; reason: "critical" | "people" | "within_budget" | "over_budget" | "below_min_severity" };

export function inQuietHours(hour: number | null | undefined, start: number | null | undefined, end: number | null | undefined): boolean {
  if (hour == null || start == null || end == null || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function decideDelivery(i: DeliveryInput): DeliveryDecision {
  const quiet = inQuietHours(i.localHour, i.quietStart, i.quietEnd);
  if (i.severity === "critical") return { digestOnly: false, slack: true, reason: "critical" };
  if (!isBudgetedKind(i.kind)) return { digestOnly: false, slack: !quiet, reason: "people" };
  if (i.kind === "alert" && i.severity && i.minSeverity && RANK[i.severity] < RANK[i.minSeverity])
    return { digestOnly: true, slack: false, reason: "below_min_severity" };
  if (i.sentToday >= clampBudget(i.budget)) return { digestOnly: true, slack: false, reason: "over_budget" };
  return { digestOnly: false, slack: !quiet, reason: "within_budget" };
}

/**
 * Pure: the "Bundled for you" digest section (null when nothing was bundled). MNPI (SEC H-1): rows flagged `sensitive`
 * are never named — they collapse into one neutral line ("2 updates about restricted records — open Roundtable"), so the
 * digest (which may be relayed to Slack) never carries a restricted title.
 */
export function bundledSection(items: { title: string; sensitive?: boolean | null }[], max = 8): string | null {
  if (!items.length) return null;
  const open = items.filter((i) => !i.sensitive);
  const restricted = items.length - open.length;
  const lines = open.slice(0, max).map((i) => `• ${i.title}`);
  if (open.length > max) lines.push(`• …and ${open.length - max} more in Notifications`);
  if (restricted) lines.push(`• ${restricted} update${restricted === 1 ? "" : "s"} about ${restricted === 1 ? "a restricted record" : "restricted records"} — open Roundtable to see ${restricted === 1 ? "it" : "them"}`);
  return `Bundled for you (${items.length} quiet update${items.length === 1 ? "" : "s"}):\n${lines.join("\n")}`;
}
