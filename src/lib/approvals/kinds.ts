/** Approval kinds — labels shared by the approvals UI, SLA settings and Slack (pure, client-safe). */
export const APPROVAL_KIND_LABELS: Record<string, string> = {
  probability_override: "Probability override",
  proposal: "Proposal",
  lead_registration: "Lead registration",
  scout_budget: "Scout budget",
  stage_gate: "Stage gate",
  scout_accept: "Suggested targets",
};

export function approvalKindLabel(kind: string): string {
  return APPROVAL_KIND_LABELS[kind] ?? kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

const ROLE_HOLDER_LABELS: Record<string, string> = {
  executive: "Executives",
  sales_leader: "Sales leaders",
  finance: "Finance",
  admin: "Admins",
  super_admin: "Super Admins",
};

/** "Who holds it": the approver role as a group label. */
export function approverRoleLabel(role: string): string {
  return ROLE_HOLDER_LABELS[role] ?? role.replace(/_/g, " ");
}

/** One-line summary of an approval's scalar payload (requested %, amounts, reason). Pure, shared by UI and Slack. */
export function approvalDetail(p: Record<string, unknown> | null | undefined): string | null {
  if (!p) return null;
  const parts: string[] = [];
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  if (typeof p.probability === "number") parts.push(`Requested ${pct(p.probability)}`);
  if (typeof p.fromProbability === "number") parts.push(`from ${pct(p.fromProbability)}`);
  if (typeof p.to === "number" && typeof p.probability !== "number") parts.push(`Requested ${pct(p.to)}`);
  if (typeof p.monthlyCents === "number") parts.push(`$${(p.monthlyCents / 100).toFixed(2)}/month`);
  if (typeof p.amountCents === "number") parts.push(`$${(p.amountCents / 100).toFixed(2)} one-time`);
  if (typeof p.reasonText === "string" && p.reasonText) parts.push(`“${p.reasonText.slice(0, 200)}”`);
  else if (typeof p.reason === "string" && p.reason) parts.push(`“${p.reason.slice(0, 200)}”`);
  if (typeof p.dealIds === "string") parts.push(p.dealIds);
  else if (Array.isArray(p.dealIds) && p.dealIds.length > 1) parts.push(`${p.dealIds.length} deals`);
  return parts.length ? parts.join(" · ") : null;
}
