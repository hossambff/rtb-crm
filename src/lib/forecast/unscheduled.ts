/**
 * Forecast "Unscheduled" bucket (open deals with no expected close date) — pure, unit tested. Keys are
 * `${pipelineKey}|${ownerId ?? ""}`; a null filter matches everything.
 */
export type Bucket3 = { deals: number; grossUsd: number; weightedUsd: number };

export function sumUnscheduled(by: Record<string, Bucket3>, motion: string | null, ownerId: string | null): Bucket3 {
  const out: Bucket3 = { deals: 0, grossUsd: 0, weightedUsd: 0 };
  for (const [k, b] of Object.entries(by)) {
    const bar = k.indexOf("|");
    const key = k.slice(0, bar);
    const owner = k.slice(bar + 1) || null;
    if (motion && key !== motion) continue;
    if (ownerId && owner !== ownerId) continue;
    out.deals += b.deals;
    out.grossUsd += b.grossUsd;
    out.weightedUsd += b.weightedUsd;
  }
  return out;
}
