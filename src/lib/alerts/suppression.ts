/**
 * Alert suppression after a user decision (H-05). Pure — unit tested.
 *
 * A closed alert row that records a person's decision suppresses re-raising the same alert:
 * - dismissed ("Dismissed: <reason>")      → suppressed until the condition CLEARS; if it later re-occurs, that is a
 *                                            new occurrence and alerts (and notifies) again;
 * - resolved by a person ("Done…", "Approval …") → suppressed for a cool-down (default 24 h, rule param
 *                                            `cooldownHours`); if the condition still holds after it, the alert is
 *                                            re-raised QUIETLY (no second notification for an unchanged condition).
 * Auto-resolved / merged / duplicate rows never suppress.
 *
 * Storage (no extra column): a suppression is "live" while its `snoozed_until` is NULL. The sweep sets
 * `snoozed_until = now()` on the closed row when the condition clears (or the cool-down re-raise happens) — i.e. on a
 * closed alert, snoozed_until means "suppression lifted at". The dismiss/resolve actions clear snoozed_until.
 */

export const DEFAULT_RESOLVE_COOLDOWN_H = 24;
/** `resolution` prefixes written when a PERSON closed the alert (alerts/actions.ts, approvals/service.ts). */
export const SUPPRESSING_RESOLUTION_PREFIXES = ["Done", "Approval"] as const;

export type SuppressionRow = {
  id: string;
  ruleCode: string;
  entity: string;
  entityId: string;
  recipientId: string | null;
  state: string;
  resolution: string | null;
  resolvedAt: Date | null;
};

export function isSuppressing(row: Pick<SuppressionRow, "state" | "resolution">): boolean {
  if (row.state === "dismissed") return true;
  return row.state === "resolved" && SUPPRESSING_RESOLUTION_PREFIXES.some((p) => (row.resolution ?? "").startsWith(p));
}

/** "suppress" = don't raise; "expired" = the resolve cool-down is over and the condition still holds (raise quietly). */
export function suppressionDecision(row: Pick<SuppressionRow, "state" | "resolvedAt">, now: Date, cooldownMs: number): "suppress" | "expired" {
  if (row.state === "dismissed") return "suppress";
  if (!row.resolvedAt) return "suppress";
  return now.getTime() - row.resolvedAt.getTime() < cooldownMs ? "suppress" : "expired";
}

/** Lookup by exact recipient (fan-out rules) or by rule + record (entity-deduped rules). Latest decision wins. */
export function indexSuppressions(rows: SuppressionRow[]) {
  const byKey = new Map<string, SuppressionRow>();
  const byTriple = new Map<string, SuppressionRow>();
  const newer = (a: SuppressionRow | undefined, b: SuppressionRow) => !a || (b.resolvedAt?.getTime() ?? 0) >= (a.resolvedAt?.getTime() ?? 0);
  for (const r of rows) {
    if (!isSuppressing(r)) continue;
    const key = `${r.ruleCode}|${r.entity}|${r.entityId}|${r.recipientId ?? ""}`;
    const triple = `${r.ruleCode}|${r.entity}|${r.entityId}`;
    if (newer(byKey.get(key), r)) byKey.set(key, r);
    if (newer(byTriple.get(triple), r)) byTriple.set(triple, r);
  }
  return {
    find(c: { ruleCode: string; entity: string; entityId: string; recipientId: string }, dedupe: "entity" | "recipient"): SuppressionRow | undefined {
      const key = `${c.ruleCode}|${c.entity}|${c.entityId}|${c.recipientId}`;
      return byKey.get(key) ?? (dedupe === "entity" ? byTriple.get(`${c.ruleCode}|${c.entity}|${c.entityId}`) : undefined);
    },
  };
}
