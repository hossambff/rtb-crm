import { describe, expect, it } from "vitest";
import { briefDealIds, refilterBrief, type OneOnOneContent } from "../one-on-one-core";

const d = (id: string, name: string, detail: string | null = null) => ({ id, name, pipeline: "NET", valueUsd: 1, detail });
const content = (): OneOnOneContent =>
  ({
    version: 1,
    repId: "r",
    repName: "Rep",
    generatedAt: "2026-10-01T00:00:00Z",
    window: { start: "", end: "" },
    headline: "Big week: Acme Media won",
    coachingPrompts: ["What unlocked Acme Media?", "Plan for Beta?"],
    metrics: {
      won: [d("1", "Acme Media")],
      lost: [],
      advanced: [d("2", "Beta Corp", "Intro → Proposal")],
      slipped: [],
      created: [],
      closeDatePushes: [d("2", "Beta Corp", "+14 days")],
      overdueNextSteps: [d("2", "Beta Corp", "“Send MSA” overdue")],
      overdueTasks: { count: 0, top: [] },
      activity: [],
      openDeals: { count: 1, valueUsd: 1 },
      risks: [{ ...d("2", "Beta Corp", "Proposal · health 41, no activity in 14+ days"), health: 41 }],
    },
  }) as unknown as OneOnOneContent;

describe("1:1 briefs are re-filtered on read (SEC L-3)", () => {
  it("collects every deal id", () => {
    expect(briefDealIds(content().metrics).sort()).toEqual(["1", "2"]);
  });

  it("anonymizes deals the viewer can no longer see and scrubs their names from AI text", () => {
    const r = refilterBrief(content(), new Set(["2"]), new Set());
    expect(r.metrics.won[0]!.name).toBe("A deal you can no longer see");
    expect(r.metrics.won[0]!.restricted).toBe(true);
    expect(r.headline).not.toContain("Acme Media");
    expect(r.coachingPrompts[0]).not.toContain("Acme Media");
    expect(r.metrics.advanced[0]!.name).toBe("Beta Corp");
  });

  it("strips fields now hidden from the viewer's role", () => {
    const r = refilterBrief(content(), new Set(["1", "2"]), new Set(["nextStep", "expectedCloseDate", "healthScore"]));
    expect(r.metrics.closeDatePushes).toEqual([]);
    expect(r.metrics.overdueNextSteps[0]!.detail).toBe("Next step overdue or missing");
    expect(r.metrics.risks[0]!.health).toBeNull();
    expect(r.metrics.risks[0]!.detail).not.toMatch(/health/i);
  });
});
