import { describe, expect, it } from "vitest";
import {
  activityDeltas,
  briefWindows,
  canPrepFor,
  heuristicCoaching,
  heuristicHeadline,
  mergeCoaching,
  type OneOnOneMetrics,
} from "@/lib/briefs/one-on-one-core";

describe("canPrepFor", () => {
  const rep = { id: "rep", managerId: "mgr", teamId: "t1", role: "ae" };
  it("lets managers prep their direct reports only", () => {
    expect(canPrepFor({ id: "mgr", role: "ae", teamId: null }, rep)).toBe(true);
    expect(canPrepFor({ id: "other", role: "ae", teamId: "t1" }, rep)).toBe(false);
    expect(canPrepFor({ id: "other", role: "sdr", teamId: "t1" }, rep)).toBe(false);
  });
  it("lets sales leaders prep their team, executives everyone", () => {
    expect(canPrepFor({ id: "lead", role: "sales_leader", teamId: "t1" }, rep)).toBe(true);
    expect(canPrepFor({ id: "lead", role: "sales_leader", teamId: "t2" }, rep)).toBe(false);
    expect(canPrepFor({ id: "lead", role: "sales_leader", teamId: null }, { ...rep, teamId: null })).toBe(false);
    expect(canPrepFor({ id: "ceo", role: "executive", teamId: null }, rep)).toBe(true);
    expect(canPrepFor({ id: "root", role: "super_admin", teamId: null }, rep)).toBe(true);
  });
  it("never allows yourself or pending users", () => {
    expect(canPrepFor({ id: "rep", role: "executive", teamId: null }, rep)).toBe(false);
    expect(canPrepFor({ id: "ceo", role: "executive", teamId: null }, { ...rep, role: "pending" })).toBe(false);
  });
});

describe("briefWindows", () => {
  it("compares the trailing 7 days with the 7 before", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const w = briefWindows(now);
    expect(w.current.start.toISOString()).toBe("2026-09-24T12:00:00.000Z");
    expect(w.current.end.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(w.prior.start.toISOString()).toBe("2026-09-17T12:00:00.000Z");
    expect(w.prior.end.toISOString()).toBe(w.current.start.toISOString());
  });
});

describe("activityDeltas", () => {
  it("computes per-kind and total deltas; pct null when last week was 0", () => {
    const rows = activityDeltas({ email: 10, call: 2, meeting: 0, bogus: 99 }, { email: 20, call: 0, meeting: 3 });
    const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(by.email).toMatchObject({ current: 10, prior: 20, delta: -10, pct: -0.5 });
    expect(by.call).toMatchObject({ current: 2, prior: 0, delta: 2, pct: null });
    expect(by.meeting).toMatchObject({ current: 0, prior: 3, delta: -3, pct: -1 });
    expect(by.total).toMatchObject({ current: 12, prior: 23, delta: -11 });
    expect(rows.map((r) => r.kind)).toEqual(["email", "call", "meeting", "linkedin", "note", "total"]);
  });
  it("sanitizes junk", () => {
    const rows = activityDeltas({ email: -4, call: Number.NaN }, {});
    expect(rows.find((r) => r.kind === "total")!.current).toBe(0);
  });
});

const empty = (): OneOnOneMetrics => ({
  won: [],
  lost: [],
  advanced: [],
  slipped: [],
  created: [],
  closeDatePushes: [],
  overdueNextSteps: [],
  overdueTasks: { count: 0, top: [] },
  activity: activityDeltas({}, {}),
  openDeals: { count: 0, valueUsd: 0 },
  risks: [],
});
const deal = (name: string, extra: object = {}) => ({ id: name, name, pipeline: "NET", valueUsd: 1000, ...extra });

describe("heuristicCoaching", () => {
  it("always returns exactly 3 prompts", () => {
    expect(heuristicCoaching(empty())).toHaveLength(3);
  });
  it("leads with the most pressing signals", () => {
    const m = empty();
    m.activity = activityDeltas({ email: 2 }, { email: 10 });
    m.risks = [{ ...deal("TheStreet"), health: 22 }];
    m.overdueNextSteps = [deal("A"), deal("B")];
    m.overdueTasks = { count: 5, top: [] };
    const p = heuristicCoaching(m);
    expect(p[0]).toMatch(/^Activity is down 80% vs last week \(10 → 2\)/);
    expect(p[1]).toBe("What would it take to get TheStreet back on track (health 22)?");
    expect(p[2]).toMatch(/^2 deals have an overdue or missing next step/);
  });
  it("never names a restricted deal", () => {
    const m = empty();
    m.risks = [{ ...deal("Secret merger", { restricted: true }), health: 10 }];
    m.won = [deal("Hidden win", { restricted: true })];
    expect(heuristicCoaching(m).join(" ")).not.toMatch(/Secret|Hidden/);
  });
});

describe("headline & merge", () => {
  it("summarizes the week", () => {
    const m = empty();
    m.won = [deal("X")];
    m.advanced = [deal("Y"), deal("Z")];
    m.activity = activityDeltas({ email: 6 }, { email: 4 });
    expect(heuristicHeadline("Chris Smith", m)).toBe("Chris: won 1 deal, advanced 2; 6 activities (+50% vs last week).");
    expect(heuristicHeadline("Will", empty())).toBe("Will: no stage movement; 0 activities.");
  });
  it("merges AI prompts with fallbacks, deduped and capped at 3", () => {
    expect(mergeCoaching(["  Ask about X ", "ask about x", ""], ["F1", "F2", "F3"])).toEqual(["Ask about X", "F1", "F2"]);
    expect(mergeCoaching(null, ["F1", "F2", "F3", "F4"])).toEqual(["F1", "F2", "F3"]);
  });
});
