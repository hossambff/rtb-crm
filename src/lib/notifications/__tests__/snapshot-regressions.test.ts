import { describe, expect, it } from "vitest";
import { aggregateSnapshot, snapshotDelta, snapshotWeightedCents, type SnapshotDeal } from "../snapshot-core";

/** Regression tests ported from docs/audits/CODE_REVIEW.md Appendix A (H-01) and M-10. */

const deal = (over: Partial<SnapshotDeal>): SnapshotDeal => ({
  pipelineKey: "NET",
  stageKey: "demo",
  unit: "muu",
  muu: 1_000_000,
  usdPerMuu: null,
  pipelineUsdPerMuu: 1,
  revSharePct: null,
  pipelineRevSharePct: 0.5,
  contractValueCents: null,
  annualizedValueCents: null,
  stageProbability: 0.5,
  probabilityOverride: null,
  overrideStatus: null,
  ...over,
});

describe("H-01 executive snapshot semantics", () => {
  it("excl. overrides = weighted at stage probability ($1M MUU deal at 50% → $500k)", () => {
    const [row] = aggregateSnapshot([deal({})], [{ pipelineKey: "NET", stageKey: "demo" }]);
    expect(snapshotWeightedCents(row!, false)).toBe(50_000_000);
  });

  it("incl. overrides honors an approved 90% override on a 10% stage ($900k)", () => {
    const [row] = aggregateSnapshot([deal({ stageProbability: 0.1, probabilityOverride: 0.9, overrideStatus: "approved" })], [{ pipelineKey: "NET", stageKey: "demo" }]);
    expect(snapshotWeightedCents(row!, true)).toBe(90_000_000);
    expect(snapshotWeightedCents(row!, false)).toBe(10_000_000);
  });

  it("won deals are not pipeline", () => {
    const rows = aggregateSnapshot(
      [deal({}), deal({ stageKey: "won", stageCategory: "won", muu: 2_000_000, stageProbability: 1 })],
      [
        { pipelineKey: "NET", stageKey: "demo", category: "open" },
        { pipelineKey: "NET", stageKey: "won", category: "won" },
      ],
    );
    expect(rows.map((r) => r.stageKey)).toEqual(["demo"]);
    expect(rows[0]!.grossCents).toBe(100_000_000);
  });
});

describe("M-10 weekly digest counts open deals only", () => {
  it("open 5 + lost 40 + won 10 → 5", () => {
    const deals = [
      ...Array.from({ length: 5 }, () => deal({ stageCategory: "open" })),
      ...Array.from({ length: 40 }, () => deal({ stageKey: "lost", stageCategory: "lost" })),
      ...Array.from({ length: 10 }, () => deal({ stageKey: "won", stageCategory: "won" })),
    ];
    const cur = aggregateSnapshot(deals, [{ pipelineKey: "NET", stageKey: "demo", category: "open" }]);
    const [d] = snapshotDelta(cur, []);
    expect(d!.count).toBe(5);
  });
});
