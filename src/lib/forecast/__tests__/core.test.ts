import { describe, expect, it } from "vitest";
import {
  addToRollup,
  effectiveCategory,
  emptyRollup,
  forecastWeekOf,
  forecastWindow,
  needsConfirmation,
  nextQuarter,
  overrideNeedsReason,
  previousWeek,
  quarterDiff,
  quarterKey,
  rollUpBy,
  stageOnlySuggestion,
  suggestForecast,
  weekOverWeek,
  type RollupRow,
  type SuggestInput,
} from "../core";

const NOW = new Date("2026-10-01T15:00:00Z"); // Thursday
const d = (iso: string) => new Date(iso);

function base(over: Partial<SuggestInput> = {}): SuggestInput {
  return {
    now: NOW,
    probability: 0.9,
    stageName: "Contract",
    healthScore: 80,
    lastActivityAt: d("2026-09-29T12:00:00Z"),
    createdAt: d("2026-06-01T12:00:00Z"),
    expectedCloseDate: d("2026-11-20T21:00:00Z"),
    currentQuarter: "2026-Q4",
    nextStep: "Send redlines",
    nextStepDueAt: d("2026-10-05T21:00:00Z"),
    signals: [],
    firstForecastQuarter: null,
    ...over,
  };
}

describe("calendar", () => {
  it("weekOf is the local Monday", () => {
    expect(forecastWeekOf(NOW, "America/New_York")).toBe("2026-09-28");
    // Monday 02:00 UTC is still Sunday evening in New York
    expect(forecastWeekOf(d("2026-10-05T02:00:00Z"), "America/New_York")).toBe("2026-09-28");
    expect(forecastWeekOf(d("2026-10-05T02:00:00Z"), "Europe/London")).toBe("2026-10-05");
    // Sunday belongs to the week that started the previous Monday
    expect(forecastWeekOf(d("2026-10-04T15:00:00Z"), "UTC")).toBe("2026-09-28");
    expect(previousWeek("2026-09-28")).toBe("2026-09-21");
    expect(previousWeek("2026-01-05")).toBe("2025-12-29");
  });
  it("quarters", () => {
    expect(quarterKey(d("2026-12-31T21:00:00Z"))).toBe("2026-Q4");
    expect(quarterKey(d("2027-01-01T17:00:00Z"))).toBe("2027-Q1");
    expect(nextQuarter("2026-Q4")).toBe("2027-Q1");
    expect(nextQuarter("2026-Q2")).toBe("2026-Q3");
    expect(quarterDiff("2026-Q4", "2027-Q2")).toBe(2);
    expect(quarterDiff("2027-Q1", "2026-Q4")).toBe(-1);
    expect(forecastWindow(d("2026-09-30T23:30:00Z"), "America/Los_Angeles")).toEqual({ current: "2026-Q3", next: "2026-Q4" });
    expect(forecastWindow(d("2026-10-01T04:30:00Z"), "UTC")).toEqual({ current: "2026-Q4", next: "2027-Q1" });
  });
});

describe("suggestForecast", () => {
  it("baseline from stage probability with a reason", () => {
    const s = suggestForecast(base());
    expect(s.category).toBe("commit");
    expect(s.reasons[0]).toBe("Contract at 90% → Commit");
    expect(s.headline).toBe("Contract at 90% → Commit");
    expect(suggestForecast(base({ probability: 0.5, stageName: "Proposal" })).category).toBe("best");
    expect(suggestForecast(base({ probability: 0.1 })).category).toBe("pipeline");
    expect(suggestForecast(base({ probability: 0 })).category).toBe("omitted");
  });
  it("flags approved overrides", () => {
    expect(suggestForecast(base({ overridden: true })).reasons[0]).toContain("approved override");
  });
  it("signals move the category", () => {
    expect(suggestForecast(base({ probability: 0.5, signals: [{ kind: "advance", quote: "send the contract" }] })).category).toBe("commit");
    const r = suggestForecast(base({ signals: [{ kind: "risk", quote: "budget freeze until next year" }] }));
    expect(r.category).toBe("best");
    expect(r.reasons.join(" ")).toContain("“budget freeze until next year”");
    expect(suggestForecast(base({ signals: [{ kind: "lost" }, { kind: "won" }] })).category).toBe("omitted");
  });
  it("health caps", () => {
    expect(suggestForecast(base({ healthScore: 40 })).category).toBe("best");
    expect(suggestForecast(base({ healthScore: 20 })).category).toBe("pipeline");
    expect(suggestForecast(base({ healthScore: null })).category).toBe("commit");
  });
  it("activity recency", () => {
    const idle = suggestForecast(base({ lastActivityAt: d("2026-09-01T12:00:00Z") }));
    expect(idle.category).toBe("best");
    expect(idle.reasons.some((x) => x.startsWith("No activity for 30 days"))).toBe(true);
    expect(suggestForecast(base({ lastActivityAt: null, createdAt: d("2026-06-01T00:00:00Z") })).category).toBe("pipeline");
    expect(suggestForecast(base()).reasons.some((x) => x.startsWith("Active: last touch 2 days ago"))).toBe(true);
  });
  it("close date slips and passed dates", () => {
    const passed = suggestForecast(base({ expectedCloseDate: d("2026-09-20T21:00:00Z") }));
    expect(passed.category).toBe("best");
    expect(passed.reasons.join(" ")).toContain("has passed");
    expect(suggestForecast(base({ firstForecastQuarter: "2026-Q3" })).category).toBe("best");
    const twice = suggestForecast(base({ probability: 0.5, firstForecastQuarter: "2026-Q2" }));
    expect(twice.category).toBe("pipeline");
    expect(twice.reasons.join(" ")).toContain("slipped 2 quarters");
    const thisWeek = suggestForecast(base({ expectedCloseDate: d("2027-01-20T21:00:00Z"), lastWeekQuarter: "2026-Q4", firstForecastQuarter: "2026-Q4" }));
    expect(thisWeek.reasons.join(" ")).toContain("slipped from Q4 2026 to Q1 2027 this week");
  });
  it("commit needs a next step and a this-quarter close", () => {
    expect(suggestForecast(base({ nextStep: null, nextStepDueAt: null })).category).toBe("best");
    expect(suggestForecast(base({ nextStep: null, nextStepDueAt: null, nextStepWaitingReason: "Waiting on legal" })).category).toBe("commit");
    expect(suggestForecast(base({ nextStepDueAt: d("2026-09-25T21:00:00Z") })).category).toBe("best");
    const nextQ = suggestForecast(base({ expectedCloseDate: d("2027-02-10T21:00:00Z") }));
    expect(nextQ.category).toBe("best");
    expect(nextQ.reasons.at(-1)).toContain("Commit is for this quarter");
    expect(nextQ.headline).toBe("Closes Q1 2027 → Best case (Commit is for this quarter)");
  });
  it("is deterministic and never empty", () => {
    const a = suggestForecast(base({ healthScore: 30, signals: [{ kind: "stall" }] }));
    const b = suggestForecast(base({ healthScore: 30, signals: [{ kind: "stall" }] }));
    expect(a).toEqual(b);
    expect(a.reasons.length).toBeGreaterThan(1);
  });
  it("stage-only mode", () => {
    const r = "Proposal at 50% → Best case (stage probability only — suggestions are off)";
    expect(stageOnlySuggestion(0.5, "Proposal")).toEqual({ category: "best", reasons: [r], headline: r });
  });
});

describe("decisions", () => {
  it("effective category: confirmation → last confirmation → suggestion", () => {
    expect(effectiveCategory({ category: "best", lastConfirmed: "commit", suggested: "pipeline" })).toEqual({ category: "best", state: "confirmed" });
    expect(effectiveCategory({ category: null, lastConfirmed: "commit", suggested: "pipeline" })).toEqual({ category: "commit", state: "carried" });
    expect(effectiveCategory({ category: null, lastConfirmed: null, suggested: "pipeline" })).toEqual({ category: "pipeline", state: "unconfirmed" });
  });
  it("needs confirmation only when never confirmed or the suggestion disagrees", () => {
    expect(needsConfirmation({ category: null, lastConfirmed: null, suggested: "best" })).toBe(true);
    expect(needsConfirmation({ category: null, lastConfirmed: "best", suggested: "best" })).toBe(false);
    expect(needsConfirmation({ category: null, lastConfirmed: "commit", suggested: "best" })).toBe(true);
    expect(needsConfirmation({ category: "best", lastConfirmed: "commit", suggested: "best" })).toBe(false);
  });
  it("reason required into / out of commit against the suggestion", () => {
    expect(overrideNeedsReason({ chosen: "commit", suggested: "best", previous: null })).toBe(true);
    expect(overrideNeedsReason({ chosen: "best", suggested: "commit", previous: null })).toBe(true);
    expect(overrideNeedsReason({ chosen: "pipeline", suggested: "best", previous: "commit" })).toBe(true);
    expect(overrideNeedsReason({ chosen: "pipeline", suggested: "best", previous: "best" })).toBe(false);
    expect(overrideNeedsReason({ chosen: "best", suggested: "best", previous: "commit" })).toBe(false);
    expect(overrideNeedsReason({ chosen: "commit", suggested: "commit", previous: null })).toBe(false);
  });
});

describe("roll-ups", () => {
  const rows: RollupRow[] = [
    { dealId: "a", ownerId: "u1", pipelineKey: "NET", period: "2026-Q4", category: "commit", state: "confirmed", grossUsd: 100, weightedUsd: 90 },
    { dealId: "b", ownerId: "u1", pipelineKey: "ENT", period: "2026-Q4", category: "best", state: "unconfirmed", grossUsd: 200, weightedUsd: 100 },
    { dealId: "c", ownerId: "u2", pipelineKey: "NET", period: "2027-Q1", category: "pipeline", state: "carried", grossUsd: 50, weightedUsd: 5 },
  ];
  it("sums by category and total", () => {
    const r = rows.reduce((acc, x) => addToRollup(acc, x), emptyRollup());
    expect(r.total).toEqual({ deals: 3, grossUsd: 350, weightedUsd: 195, unconfirmed: 1 });
    expect(r.commit.weightedUsd).toBe(90);
    expect(r.omitted.deals).toBe(0);
  });
  it("groups", () => {
    const by = rollUpBy(rows, (x) => x.ownerId ?? "none");
    expect(by.get("u1")!.total.deals).toBe(2);
    expect(by.get("u2")!.pipeline.grossUsd).toBe(50);
    const byQ = rollUpBy(rows, (x) => `${x.period}|${x.pipelineKey}`);
    expect([...byQ.keys()].sort()).toEqual(["2026-Q4|ENT", "2026-Q4|NET", "2027-Q1|NET"]);
  });
});

describe("weekOverWeek", () => {
  it("added / removed", () => {
    expect(weekOverWeek(null, { category: "best", weightedUsd: 50, period: "2026-Q4" })).toMatchObject({ kind: "added", deltaWeightedUsd: 50 });
    expect(weekOverWeek({ category: "commit", weightedUsd: 90, period: "2026-Q4" }, null, "Closed won")).toMatchObject({ kind: "removed", reason: "Closed won", deltaWeightedUsd: -90 });
    expect(weekOverWeek(null, null)).toBeNull();
  });
  it("category moves carry the rep's note", () => {
    const c = weekOverWeek({ category: "best", weightedUsd: 50, period: "2026-Q4" }, { category: "commit", weightedUsd: 90, period: "2026-Q4", note: "Verbal yes from CRO" });
    expect(c).toMatchObject({ kind: "upgraded", deltaWeightedUsd: 40, reason: "Best case → Commit — “Verbal yes from CRO”" });
    expect(weekOverWeek({ category: "commit", weightedUsd: 90, period: "2026-Q4" }, { category: "pipeline", weightedUsd: 10, period: "2026-Q4" })?.kind).toBe("downgraded");
  });
  it("slips, value changes, and no-ops", () => {
    expect(weekOverWeek({ category: "best", weightedUsd: 50, period: "2026-Q4" }, { category: "best", weightedUsd: 50, period: "2027-Q1" })).toMatchObject({ kind: "slipped" });
    expect(weekOverWeek({ category: "best", weightedUsd: 50, period: "2027-Q1" }, { category: "best", weightedUsd: 50, period: "2026-Q4" })).toMatchObject({ kind: "pulled_in" });
    expect(weekOverWeek({ category: "best", weightedUsd: 50, period: "2026-Q4" }, { category: "best", weightedUsd: 80, period: "2026-Q4" })).toMatchObject({ kind: "value", deltaWeightedUsd: 30 });
    expect(weekOverWeek({ category: "best", weightedUsd: 50, period: "2026-Q4" }, { category: "best", weightedUsd: 50.4, period: "2026-Q4" })).toBeNull();
  });
});
