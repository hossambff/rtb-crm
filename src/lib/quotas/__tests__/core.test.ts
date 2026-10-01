import { describe, expect, it } from "vitest";
import { attainment, defaultQuotaLines, formatTarget, fromStoredTarget, isPeriod, mayPropose, metricsForMotion, nextPeriod, periodLabel, periodOf, toStoredTarget } from "../core";

describe("quota metric defaults", () => {
  it("per motion", () => {
    expect(metricsForMotion("NET")[0]).toBe("muu");
    expect(metricsForMotion("ENT")).toContain("revenue_usd");
    expect(metricsForMotion("SPT")[0]).toBe("muu");
    expect(metricsForMotion("ADS")[0]).toBe("revenue_usd");
    expect(metricsForMotion("R100")[0]).toBe("activations");
    expect(metricsForMotion("")[0]).toBe("meetings");
  });
  it("SDRs and interns get one meetings line; others one line per motion", () => {
    expect(defaultQuotaLines("sdr", ["NET", "ADS"])).toEqual([{ pipelineKey: "", metric: "meetings" }]);
    expect(defaultQuotaLines("intern", [])).toEqual([{ pipelineKey: "", metric: "meetings" }]);
    expect(defaultQuotaLines("ae", ["NET", "ADS", "R100"])).toEqual([
      { pipelineKey: "NET", metric: "muu" },
      { pipelineKey: "ADS", metric: "revenue_usd" },
      { pipelineKey: "R100", metric: "activations" },
    ]);
  });
});

describe("period keys", () => {
  it("computes and rolls quarters", () => {
    expect(periodOf(new Date("2026-10-01T00:00:00Z"))).toBe("2026-Q4");
    expect(periodOf(new Date("2026-03-31T12:00:00Z"))).toBe("2026-Q1");
    expect(nextPeriod("2026-Q4")).toBe("2027-Q1");
    expect(nextPeriod("2026-Q2")).toBe("2026-Q3");
    expect(periodLabel("2026-Q4")).toBe("Q4 2026");
    expect(isPeriod("2026-Q4")).toBe(true);
    expect(isPeriod("2026-Q5")).toBe(false);
  });
});

describe("targets", () => {
  it("revenue is stored in cents", () => {
    expect(toStoredTarget("revenue_usd", 250000)).toBe(25_000_000);
    expect(fromStoredTarget("revenue_usd", 25_000_000)).toBe(250000);
    expect(toStoredTarget("muu", 1_200_000.4)).toBe(1_200_000);
  });
  it("formats compactly", () => {
    expect(formatTarget("revenue_usd", 25_000_000)).toBe("$250k");
    expect(formatTarget("muu", 1_200_000)).toBe("1.2M MUU");
    expect(formatTarget("activations", 40)).toBe("40 activations");
    expect(formatTarget("meetings", 1)).toBe("1 meeting");
  });
  it("attainment and proposal rules", () => {
    expect(attainment(50, 200)).toBe(0.25);
    expect(attainment(5, 0)).toBeNull();
    expect(mayPropose(null)).toBe(true);
    expect(mayPropose({ status: "proposed" })).toBe(true);
    expect(mayPropose({ status: "set" })).toBe(false);
  });
});
