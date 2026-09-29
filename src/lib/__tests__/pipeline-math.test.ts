import { describe, expect, it } from "vitest";
import { dealValue } from "../pipeline-math";
import { findClaimHits } from "../claims-core";

describe("dealValue", () => {
  it("MUU motion gross/net/weighted", () => {
    const v = dealValue({ unit: "muu", muu: 10_000_000, pipelineUsdPerMuu: 1, pipelineRevSharePct: 0.4, stageProbability: 0.9 });
    expect(v.grossUsd).toBe(10_000_000);
    expect(v.netUsd).toBe(4_000_000);
    expect(v.weightedGrossUsd).toBe(9_000_000);
    expect(v.weightedNetUsd).toBeCloseTo(3_600_000);
  });
  it("pending override is ignored until approved", () => {
    const pending = dealValue({ unit: "muu", muu: 100, stageProbability: 0.1, probabilityOverride: 0.9, overrideStatus: "pending" });
    expect(pending.probability).toBe(0.1);
    const approved = dealValue({ unit: "muu", muu: 100, stageProbability: 0.1, probabilityOverride: 0.9, overrideStatus: "approved" });
    expect(approved.probability).toBe(0.9);
    expect(approved.overridden).toBe(true);
  });
  it("USD motion uses annualized then contract value", () => {
    expect(dealValue({ unit: "usd", annualizedValueCents: 20_000_000, contractValueCents: 5_000_000, stageProbability: 1 }).grossUsd).toBe(200_000);
    expect(dealValue({ unit: "usd", contractValueCents: 5_000_000, stageProbability: 0.5 }).weightedGrossUsd).toBe(25_000);
  });
});

describe("findClaimHits", () => {
  const rules = [
    { id: "1", text: "Paid in 8 seconds / powered by Coinbase", pattern: "(paid in \\d+ seconds|powered by coinbase)", status: "banned", approvedAlternative: "beta" },
    { id: "2", text: "No cost", pattern: "no cost", status: "approved", approvedAlternative: null },
  ];
  it("flags banned claims, ignores approved", () => {
    const hits = findClaimHits("Partners get paid in 8 seconds and there is no cost.", rules);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.status).toBe("banned");
  });
});
