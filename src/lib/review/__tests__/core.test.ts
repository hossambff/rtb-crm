import { describe, expect, it } from "vitest";
import {
  detectExceptions,
  exceptionCounts,
  latestDecisions,
  outcomeCounts,
  rankForReview,
  recapText,
  valueBeforeFromAudit,
  valueChange,
  type Decision,
  type ReviewDealInput,
} from "../core";

const now = new Date("2026-10-01T15:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000);

const healthy: ReviewDealInput = {
  stageCategory: "open",
  stageEnteredAt: daysAgo(3),
  slaDays: 21,
  expectedCloseDate: inDays(40),
  nextStep: "Send proposal",
  nextStepDueAt: inDays(2),
  nextStepWaitingReason: null,
  healthScore: 72,
  overrideStatus: null,
  valueUsd: 100_000,
};
const kinds = (d: Partial<ReviewDealInput>) => detectExceptions({ ...healthy, ...d }, now).map((e) => e.kind);

describe("detectExceptions", () => {
  it("returns nothing for a healthy deal or a closed one", () => {
    expect(kinds({})).toEqual([]);
    expect(kinds({ stageCategory: "won", healthScore: 10, nextStep: null })).toEqual([]);
  });

  it("flags stalled past SLA only when over the SLA", () => {
    expect(kinds({ stageEnteredAt: daysAgo(21) })).toEqual([]);
    expect(kinds({ stageEnteredAt: daysAgo(22) })).toEqual(["stalled"]);
    expect(kinds({ stageEnteredAt: daysAgo(400), slaDays: null })).toEqual([]);
    expect(detectExceptions({ ...healthy, stageEnteredAt: daysAgo(30) }, now)[0]!.detail).toBe("30 days in stage (SLA 21)");
  });

  it("flags a passed close date and pushes this week", () => {
    expect(kinds({ expectedCloseDate: daysAgo(5) })).toEqual(["slipped_close"]);
    const pushed = detectExceptions(
      {
        ...healthy,
        closeDatePushes: [
          { from: inDays(10), to: inDays(25), at: daysAgo(4) },
          { from: inDays(25), to: inDays(40), at: daysAgo(1) },
        ],
      },
      now,
    );
    expect(pushed.map((e) => e.kind)).toEqual(["slipped_close"]);
    expect(pushed[0]!.detail).toBe("Pushed 2× this week (+30 days)");
    // pulling a date in is not a slip
    expect(kinds({ closeDatePushes: [{ from: inDays(40), to: inDays(20), at: daysAgo(1) }] })).toEqual([]);
  });

  it("flags missing / overdue next steps, respecting a waiting reason", () => {
    expect(kinds({ nextStep: null })).toEqual(["no_next_step"]);
    expect(kinds({ nextStepDueAt: null })).toEqual(["no_next_step"]);
    expect(kinds({ nextStep: "  " })).toEqual(["no_next_step"]);
    expect(kinds({ nextStep: null, nextStepWaitingReason: "Waiting on legal until 15 Oct" })).toEqual([]);
    expect(kinds({ nextStepDueAt: daysAgo(3) })).toEqual(["overdue_next_step"]);
  });

  it("flags low health, pending overrides and big value changes", () => {
    expect(kinds({ healthScore: 39 })).toEqual(["low_health"]);
    expect(kinds({ healthScore: 40 })).toEqual([]);
    expect(kinds({ healthScore: null })).toEqual([]);
    expect(kinds({ overrideStatus: "pending" })).toEqual(["pending_override"]);
    expect(kinds({ overrideStatus: "approved" })).toEqual([]);
    expect(kinds({ valueBeforeUsd: 60_000, valueUsd: 100_000 })).toEqual(["value_change"]);
    expect(kinds({ valueBeforeUsd: 95_000, valueUsd: 100_000 })).toEqual([]);
  });

  it("orders multiple exceptions by kind", () => {
    expect(kinds({ healthScore: 20, nextStep: null, stageEnteredAt: daysAgo(60), overrideStatus: "pending" })).toEqual([
      "stalled",
      "no_next_step",
      "low_health",
      "pending_override",
    ]);
  });
});

describe("valueChange", () => {
  it("applies the thresholds", () => {
    expect(valueChange(null, 100)).toBeNull();
    expect(valueChange(100_000, 100_000)).toBeNull();
    expect(valueChange(10_000, 14_000)).toBeNull(); // 40% but only $4k
    expect(valueChange(40_000, 52_000)).toMatch(/^Value ↑ 30% this week/);
    expect(valueChange(10_000_000, 9_700_000)).toMatch(/^Value ↓ 3% this week \(\$10\.0M → \$9\.70M\)$/);
    expect(valueChange(0, 50_000)).toBe("Value ↑ this week ($0 → $50K)");
  });
});

describe("valueBeforeFromAudit", () => {
  const cur = { unit: "muu" as const, muu: 2_000_000, usdPerMuu: 0.5, stageProbability: 0.3 };
  it("reconstructs the earlier gross value", () => {
    expect(valueBeforeFromAudit(cur, { muu: 1_000_000 })).toBe(500_000);
    expect(valueBeforeFromAudit(cur, { usdPerMuu: 0.25 })).toBe(500_000);
    expect(valueBeforeFromAudit(cur, { nextStep: "x" })).toBeNull();
    expect(valueBeforeFromAudit({ unit: "usd", annualizedValueCents: 10_000_00, stageProbability: 1 }, { annualizedValueCents: null, contractValueCents: 5_000_00 })).toBe(5_000);
  });
});

describe("rankForReview", () => {
  it("drops clean deals and ranks heavier/bigger first, stable by name", () => {
    const mk = (name: string, valueUsd: number, ks: ReviewDealInput) => ({ name, valueUsd, exceptions: detectExceptions(ks, now) });
    const rows = [
      mk("Clean", 1e9, healthy),
      mk("B small no-next", 1_000, { ...healthy, nextStep: null }),
      mk("A small no-next", 1_000, { ...healthy, nextStep: null }),
      mk("Big low health", 5_000_000, { ...healthy, healthScore: 10 }),
      mk("Many problems", 1_000, { ...healthy, healthScore: 10, nextStep: null, stageEnteredAt: daysAgo(90) }),
    ];
    expect(rankForReview(rows).map((r) => r.name)).toEqual(["Big low health", "Many problems", "A small no-next", "B small no-next"]);
    expect(exceptionCounts(rows).no_next_step).toBe(3);
  });
});

describe("decisions & recap", () => {
  const d = (dealId: string, outcome: Decision["outcome"], at: string, extra: Partial<Decision> = {}): Decision => ({ dealId, outcome, at, ...extra });
  const decisions = [
    d("1", "keep", "2026-10-01T10:00:00Z"),
    d("1", "push", "2026-10-01T10:05:00Z", { note: "Budget cycle moved to Q1" }),
    d("2", "escalate", "2026-10-01T10:02:00Z", { taskId: "t1", note: "CEO intro" }),
    d("3", "close_lost", "2026-10-01T10:03:00Z"),
    d("4", "update", "2026-10-01T10:04:00Z", { taskId: "t2" }),
  ];

  it("keeps the latest decision per deal", () => {
    expect(latestDecisions(decisions).get("1")!.outcome).toBe("push");
    expect(outcomeCounts(decisions)).toEqual({ keep: 0, push: 1, update: 1, escalate: 1, close_lost: 1 });
  });

  it("never names deals missing from the visible-name map", () => {
    const names = new Map([
      ["1", "TheStreet"],
      ["2", "Sports Illustrated"],
      ["4", "Men's Journal"],
    ]);
    const { title, body } = recapText({ title: "Pipeline review — 1 Oct", dealCount: 12, decisions, names });
    expect(title).toBe("Pipeline review — 1 Oct");
    expect(body).toContain("Reviewed 4 of 12 deals — 1 close date pushed, 1 next step updated, 1 escalated, 1 closed lost. 2 tasks created.");
    expect(body).toContain("• TheStreet — Budget cycle moved to Q1");
    expect(body).toContain("• Sports Illustrated — CEO intro");
    expect(body).not.toContain("3");
    expect(body).toContain("1 restricted deal not listed.");
  });
});
