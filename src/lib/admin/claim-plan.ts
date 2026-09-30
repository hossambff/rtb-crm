/**
 * Pure part of placeholder claiming (unit-tested). Placeholder users are created by imports for owner names found in
 * the spreadsheets ("Chris", "Will", …) with emails ending in `.placeholder@roundtable.invalid`. Claiming re-points
 * every ownership/attribution column from the placeholder to the real user.
 */
export const PLACEHOLDER_SUFFIX = ".placeholder@roundtable.invalid";

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return Boolean(email && email.toLowerCase().endsWith(PLACEHOLDER_SUFFIX));
}

/** Every (table, column) that references a user id and should follow the person. audit_log is never rewritten. */
export const USER_REF_COLUMNS = [
  { table: "deals", column: "owner_id" },
  { table: "deals", column: "created_by" },
  { table: "deals", column: "override_approved_by" },
  { table: "deal_stage_history", column: "changed_by" },
  { table: "tasks", column: "assignee_id" },
  { table: "tasks", column: "created_by" },
  { table: "accounts", column: "owner_id" },
  { table: "accounts", column: "created_by" },
  { table: "contacts", column: "owner_id" },
  { table: "contacts", column: "relationship_owner_id" },
  { table: "activities", column: "actor_id" },
  { table: "comments", column: "author_id" },
  { table: "meetings", column: "owner_id" },
  { table: "transcripts", column: "uploaded_by" },
  { table: "migration_projects", column: "owner_id" },
  { table: "commission_accruals", column: "user_id" },
  { table: "lead_registrations", column: "user_id" },
  { table: "scout_searches", column: "owner_id" },
  { table: "enrichment_runs", column: "requested_by" },
  { table: "alerts", column: "recipient_id" },
  { table: "notifications", column: "user_id" },
  { table: "teams", column: "lead_id" },
  { table: "user", column: "manager_id" },
] as const;

/**
 * Tables whose primary key includes the user id: rows are moved only when the target doesn't already have one for
 * the same parent; otherwise they're merged (deal splits add their percentages) and the placeholder row is dropped.
 */
export const USER_KEYED_TABLES = [
  { table: "deal_splits", key: "deal_id", column: "user_id", merge: "sum_pct" },
  { table: "commission_assignments", key: "plan_id", column: "user_id", merge: "keep_target" },
  { table: "restricted_access", key: "entity_id", column: "user_id", merge: "keep_target" },
] as const;

/** Merge two deal-split rows for the same deal; percentages add and cap at 100. */
export function mergeSplitPct(targetPct: number, placeholderPct: number): number {
  return Math.min(100, Math.round((targetPct + placeholderPct) * 100) / 100);
}

export type ClaimSummary = Record<string, number>;

export function summarize(counts: ClaimSummary): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`);
  return parts.length ? parts.join(", ") : "no records";
}
