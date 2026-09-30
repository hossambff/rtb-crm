/** Pure aggregation for nightly pipeline snapshots (unit tested). */
import { dealValue } from "@/lib/pipeline-math";

export type SnapshotDeal = {
  pipelineKey: string;
  stageKey: string;
  unit: "muu" | "usd" | "activation";
  muu: number | null;
  usdPerMuu: number | null;
  pipelineUsdPerMuu: number | null;
  revSharePct: number | null;
  pipelineRevSharePct: number | null;
  contractValueCents: number | null;
  annualizedValueCents: number | null;
  stageProbability: number;
  probabilityOverride: number | null;
  overrideStatus: string | null;
  /** Stage category; only `open` deals are pipeline (H-01/M-10). Omitted = treated as open (legacy callers). */
  stageCategory?: string;
};

export type SnapshotRow = {
  pipelineKey: string;
  stageKey: string;
  dealCount: number;
  muu: number;
  grossCents: number;
  weightedCents: number;
  overrideWeightedCents: number;
};

/**
 * Column semantics (H-01) — keep readers and the writer in one place:
 * - `weightedCents`          = weighted at the STAGE probability (overrides ignored) → "excl. overrides"
 * - `overrideWeightedCents`  = weighted honoring APPROVED probability overrides      → "incl. overrides"
 */
export function snapshotWeightedCents(row: Pick<SnapshotRow, "weightedCents" | "overrideWeightedCents">, includeOverrides: boolean): number {
  return includeOverrides ? row.overrideWeightedCents : row.weightedCents;
}

/**
 * Per pipeline × OPEN stage: count, MUU, gross $, weighted $ at stage probability, and weighted $ honoring approved
 * probability overrides. Won / lost / hold stages are not pipeline and are excluded (H-01, M-10). Every known open
 * stage gets a row (zeros included) so charts have stable axes.
 */
export function aggregateSnapshot(deals: SnapshotDeal[], stages: { pipelineKey: string; stageKey: string; category?: string }[]): SnapshotRow[] {
  const rows = new Map<string, SnapshotRow>();
  const key = (p: string, st: string) => `${p}|${st}`;
  for (const st of stages)
    if ((st.category ?? "open") === "open") rows.set(key(st.pipelineKey, st.stageKey), { pipelineKey: st.pipelineKey, stageKey: st.stageKey, dealCount: 0, muu: 0, grossCents: 0, weightedCents: 0, overrideWeightedCents: 0 });
  for (const d of deals) {
    if ((d.stageCategory ?? "open") !== "open") continue;
    const k = key(d.pipelineKey, d.stageKey);
    let r = rows.get(k);
    if (!r) {
      r = { pipelineKey: d.pipelineKey, stageKey: d.stageKey, dealCount: 0, muu: 0, grossCents: 0, weightedCents: 0, overrideWeightedCents: 0 };
      rows.set(k, r);
    }
    const base = { ...d, stageProbability: d.stageProbability };
    const plain = dealValue({ ...base, probabilityOverride: null, overrideStatus: null });
    const withOverride = dealValue(base);
    r.dealCount++;
    r.muu += plain.muu;
    r.grossCents += Math.round(plain.grossUsd * 100);
    r.weightedCents += Math.round(plain.weightedGrossUsd * 100);
    r.overrideWeightedCents += Math.round(withOverride.weightedGrossUsd * 100);
  }
  return [...rows.values()];
}

/** Week-over-week pipeline movement per pipeline from two snapshot sets. */
export function snapshotDelta(current: SnapshotRow[], previous: SnapshotRow[]) {
  const agg = (rows: SnapshotRow[]) => {
    const m = new Map<string, { count: number; weightedCents: number }>();
    for (const r of rows) {
      const v = m.get(r.pipelineKey) ?? { count: 0, weightedCents: 0 };
      v.count += r.dealCount;
      v.weightedCents += r.overrideWeightedCents;
      m.set(r.pipelineKey, v);
    }
    return m;
  };
  const cur = agg(current);
  const prev = agg(previous);
  const keys = Array.from(new Set([...cur.keys(), ...prev.keys()])).sort();
  return keys.map((k) => {
    const c = cur.get(k) ?? { count: 0, weightedCents: 0 };
    const p = prev.get(k) ?? { count: 0, weightedCents: 0 };
    return { pipelineKey: k, count: c.count, countDelta: c.count - p.count, weightedCents: c.weightedCents, weightedDeltaCents: c.weightedCents - p.weightedCents };
  });
}
