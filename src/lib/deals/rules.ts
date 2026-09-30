/** Small pure business rules for deals (splits, mentions, overrides, coverage). Client-safe, unit tested. */

/** DEAL-6: splits must be unique users with positive % that total exactly 100 (±0.01). */
export function validateSplits(rows: { userId: string; pct: number }[]): string | null {
  if (rows.length === 0) return "Add at least one owner.";
  const ids = new Set<string>();
  for (const r of rows) {
    if (!r.userId) return "Pick a user for every row.";
    if (ids.has(r.userId)) return "Each person can appear only once.";
    ids.add(r.userId);
    if (!(r.pct > 0 && r.pct <= 100)) return "Each split must be between 0 and 100%.";
  }
  const total = rows.reduce((a, r) => a + r.pct, 0);
  if (Math.abs(total - 100) > 0.01) return `Splits total ${Math.round(total * 100) / 100}% — they must total 100%.`;
  return null;
}

/** SEC M-8: does the requested split set differ from the stored one (membership, % or role)? */
export function splitsChanged(
  current: { userId: string; pct: number; role: string | null }[],
  next: { userId: string; pct: number; role?: string | null }[],
): boolean {
  if (current.length !== next.length) return true;
  const byUser = new Map(current.map((c) => [c.userId, c]));
  return next.some((n) => {
    const c = byUser.get(n.userId);
    return !c || Math.abs(c.pct - n.pct) > 0.001 || (c.role ?? "owner") !== (n.role ?? "owner");
  });
}

/** Executives and super admins self-approve probability overrides; everyone else goes to the approval queue. */
export function overrideAutoApproved(role: string): boolean {
  return role === "executive" || role === "super_admin";
}

/**
 * Resolve @mentions in a comment body against a user list. Matches "@Full Name" (longest name first) and returns the
 * mentioned user ids (deduped). Case-insensitive; requires a word boundary after the name.
 */
export function extractMentions(body: string, users: { id: string; name: string }[]): string[] {
  const sorted = [...users].filter((u) => u.name.trim()).sort((a, b) => b.name.length - a.name.length);
  const found = new Set<string>();
  const lower = body.toLowerCase();
  let idx = lower.indexOf("@");
  while (idx !== -1) {
    const rest = lower.slice(idx + 1);
    const hit = sorted.find((u) => {
      const n = u.name.toLowerCase();
      return rest.startsWith(n) && !/[a-z0-9]/.test(rest.charAt(n.length));
    });
    if (hit) found.add(hit.id);
    idx = lower.indexOf("@", idx + 1);
  }
  return [...found];
}

export const STAKEHOLDER_ROLES = ["decision_maker", "champion", "influencer", "finance", "legal", "tech", "blocker"] as const;
export const ROLE_LABELS: Record<string, string> = {
  decision_maker: "Decision maker",
  champion: "Champion",
  influencer: "Influencer",
  finance: "Economic buyer / Finance",
  legal: "Legal",
  tech: "Technical",
  blocker: "Blocker",
};

/** CARD-4 coverage gaps: which key roles are missing among linked stakeholders. */
export function coverageGaps(roles: (string | null)[]): string[] {
  const have = new Set(roles.filter(Boolean));
  const gaps: string[] = [];
  if (!have.has("decision_maker")) gaps.push("No decision maker");
  if (!have.has("champion")) gaps.push("No champion");
  if (!have.has("finance")) gaps.push("No economic buyer");
  return gaps;
}
