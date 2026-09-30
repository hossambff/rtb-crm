import { describe, expect, it } from "vitest";
import { columnTotals, sortCards, stageSlice, trimPerStage } from "../board-shape";
import { allLimited } from "../concurrency";
import type { BoardDeal } from "../types";

function deal(p: Partial<BoardDeal>): BoardDeal {
  return {
    id: p.id ?? Math.random().toString(36).slice(2),
    name: p.name ?? "Deal",
    pipelineKey: "NET",
    stageId: p.stageId ?? "s1",
    status: "open",
    accountId: null,
    accountName: null,
    accountDomain: null,
    accountCategory: null,
    ownerId: null,
    owners: [],
    priority: p.priority ?? null,
    nextStep: "x",
    nextStepDueAt: null,
    nextStepWaitingReason: null,
    overdueDays: p.overdueDays ?? 0,
    daysInStage: 0,
    stageEnteredAt: "",
    lastActivityAt: null,
    healthScore: null,
    healthExplanation: null,
    restricted: false,
    muu: p.muu ?? 0,
    grossUsd: p.grossUsd ?? 0,
    netUsd: "netUsd" in p ? p.netUsd : (p.grossUsd ?? 0) / 2,
    weightedUsd: p.weightedUsd ?? 0,
    weightedMuu: 0,
    probability: 0.1,
    overridden: false,
    overridePending: false,
    contractValueCents: null,
    filled: [],
    canEdit: true,
    createdAt: "",
  };
}

describe("board shaping", () => {
  it("orders by priority, then overdue, then weighted value", () => {
    const list = [
      deal({ name: "low-big", priority: "low", weightedUsd: 9e9 }),
      deal({ name: "none", weightedUsd: 1 }),
      deal({ name: "top", priority: "top10" }),
      deal({ name: "high-overdue", priority: "high", overdueDays: 4 }),
      deal({ name: "high", priority: "high", weightedUsd: 100 }),
    ].sort(sortCards);
    expect(list.map((d) => d.name)).toEqual(["top", "high-overdue", "high", "low-big", "none"]);
  });
  it("totals cover all deals; net becomes null when hidden on any card", () => {
    const t = columnTotals([deal({ stageId: "a", muu: 10, grossUsd: 10, weightedUsd: 1 }), deal({ stageId: "a", muu: 5, grossUsd: 4, weightedUsd: 2 }), deal({ stageId: "b", grossUsd: 3, netUsd: undefined })]);
    expect(t.a).toEqual({ count: 2, muu: 15, gross: 14, net: 7, weighted: 3 });
    expect(t.b!.net).toBeNull();
  });
  it("trims per stage and slices for show-more", () => {
    const many = Array.from({ length: 120 }, (_, i) => deal({ id: `d${i}`, stageId: i % 2 ? "odd" : "even", weightedUsd: i }));
    const trimmed = trimPerStage(many, 50);
    expect(trimmed.filter((d) => d.stageId === "odd")).toHaveLength(50);
    expect(trimmed.filter((d) => d.stageId === "even")[0]!.id).toBe("d118");
    const next = stageSlice(many, "even", 50, 100);
    expect(next).toHaveLength(10);
    expect(next.some((d) => trimmed.includes(d))).toBe(false);
  });
});

describe("allLimited", () => {
  it("keeps order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const task = (v: number) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return v;
    };
    const out = await allLimited([task(1), task(2), task(3), task(4), task(5)] as const, 2);
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });
});
