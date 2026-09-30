import { describe, expect, it } from "vitest";
import {
  applyCap,
  clawbackDue,
  keyFromNote,
  keyNote,
  normalizeRules,
  periodOf,
  planAccruals,
  recipientsFor,
  ruleAmountCents,
  statementTotals,
  whatIf,
  type CommissionEvent,
  type PlanRule,
} from "../calc";
import { registrationConflicts, registrationState } from "../registration";

const ev = (over: Partial<CommissionEvent>): CommissionEvent => ({
  trigger: "deal_won",
  sourceId: "d1",
  at: new Date("2026-09-10T12:00:00Z"),
  pipelineKey: "ADS",
  dealId: "d1",
  contractCents: 10_000_000, // $100k
  netCents: 4_000_000,
  recipients: [{ userId: "u1", pct: 100 }],
  label: "Deal",
  ...over,
});

const base = { userId: "u1", planId: "p1", planName: "Plan", effectiveFrom: new Date("2026-09-01T00:00:00Z") };

describe("rule math", () => {
  it("pct of contract / net / flat", () => {
    expect(ruleAmountCents({ trigger: "deal_won", rateType: "pct_contract", rate: 15 }, ev({}))).toBe(1_500_000);
    expect(ruleAmountCents({ trigger: "deal_won", rateType: "pct_net", rate: 10 }, ev({}))).toBe(400_000);
    expect(ruleAmountCents({ trigger: "r100_live", rateType: "flat", rate: 5000 }, ev({}))).toBe(5000);
  });
  it("caps are cumulative", () => {
    expect(applyCap(1000, 0, 1500)).toBe(1000);
    expect(applyCap(1000, 1000, 1500)).toBe(500);
    expect(applyCap(1000, 2000, 1500)).toBe(0);
    expect(applyCap(1000, 5000, undefined)).toBe(1000);
  });
  it("splits default to owner and normalize above 100%", () => {
    expect(recipientsFor("o", [])).toEqual([{ userId: "o", pct: 100 }]);
    expect(recipientsFor(null, [])).toEqual([]);
    expect(recipientsFor("o", [{ userId: "a", pct: 30 }, { userId: "b", pct: 70 }])).toHaveLength(2);
    expect(recipientsFor("o", [{ userId: "a", pct: 100 }, { userId: "b", pct: 100 }])[0]!.pct).toBe(50);
  });
  it("normalizes untrusted rules JSON", () => {
    const r = normalizeRules([{ trigger: "deal_won", rateType: "bogus", rate: "5" }, { trigger: "nope" }, null]);
    expect(r).toEqual([{ id: expect.stringMatching(/^h/), trigger: "deal_won", pipelineKeys: undefined, rateType: "flat", rate: 5, capCents: undefined, clawbackDays: undefined }]);
  });
  it("period and note keys", () => {
    expect(periodOf(new Date("2026-01-31T23:00:00Z"))).toBe("2026-01");
    expect(keyFromNote(keyNote("0|deal_won|x", "hello"))).toBe("0|deal_won|x");
    expect(keyFromNote("no key")).toBeNull();
  });
});

describe("planAccruals", () => {
  const rules: PlanRule[] = [{ trigger: "deal_won", pipelineKeys: ["ADS"], rateType: "pct_contract", rate: 10 }];

  it("accrues once per event and is idempotent across runs", () => {
    const existingKeys = new Set<string>();
    const first = planAccruals({ ...base, rules, events: [ev({})], existingKeys, periodTotals: new Map() });
    expect(first).toHaveLength(1);
    expect(first[0]!.amountCents).toBe(1_000_000);
    expect(first[0]!.period).toBe("2026-09");
    const again = planAccruals({ ...base, rules, events: [ev({})], existingKeys: new Set(first.map((d) => d.key)), periodTotals: new Map() });
    expect(again).toHaveLength(0);
  });

  it("respects effectiveFrom, pipeline filter and recipients", () => {
    const events = [
      ev({ sourceId: "old", at: new Date("2026-08-01T00:00:00Z") }),
      ev({ sourceId: "net", pipelineKey: "NET" }),
      ev({ sourceId: "other", recipients: [{ userId: "u2", pct: 100 }] }),
    ];
    expect(planAccruals({ ...base, rules, events, existingKeys: new Set(), periodTotals: new Map() })).toHaveLength(0);
  });

  it("applies split percentage", () => {
    const d = planAccruals({ ...base, rules, events: [ev({ recipients: [{ userId: "u1", pct: 30 }, { userId: "u2", pct: 70 }] })], existingKeys: new Set(), periodTotals: new Map() });
    expect(d[0]!.amountCents).toBe(300_000);
    expect(d[0]!.note).toMatch(/30% split/);
  });

  it("applies a monthly cap across events", () => {
    const capped: PlanRule[] = [{ ...rules[0]!, capCents: 1_500_000 }];
    const d = planAccruals({ ...base, rules: capped, events: [ev({ sourceId: "a" }), ev({ sourceId: "b" }), ev({ sourceId: "c" })], existingKeys: new Set(), periodTotals: new Map() });
    expect(d.map((x) => x.amountCents)).toEqual([1_000_000, 500_000]);
  });
});

describe("clawback", () => {
  it("only within the window after the event", () => {
    const at = new Date("2026-09-01T00:00:00Z");
    expect(clawbackDue({ eventAt: at, lostAt: new Date("2026-10-01T00:00:00Z"), clawbackDays: 90 })).toBe(true);
    expect(clawbackDue({ eventAt: at, lostAt: new Date("2027-01-15T00:00:00Z"), clawbackDays: 90 })).toBe(false);
    expect(clawbackDue({ eventAt: at, lostAt: new Date("2026-10-01T00:00:00Z"), clawbackDays: undefined })).toBe(false);
  });
});

describe("statements & what-if", () => {
  it("totals", () => {
    const t = statementTotals([
      { amountCents: 1000, status: "approved" },
      { amountCents: 500, status: "paid" },
      { amountCents: -1000, status: "clawed_back" },
    ]);
    expect(t).toMatchObject({ gross: 1500, clawbacks: -1000, net: 500, approved: 1000, paid: 500 });
  });
  it("what-if uses deal_won/invoice_paid rules for the pipeline", () => {
    const rules: PlanRule[] = [
      { trigger: "deal_won", pipelineKeys: ["ADS"], rateType: "pct_contract", rate: 2 },
      { trigger: "meeting_held", rateType: "flat", rate: 5000 },
    ];
    expect(whatIf(rules, { pipelineKey: "ADS", contractCents: 20_000_000, netCents: 0, splitPct: 100 })).toBe(400_000);
  });
});

describe("lead registration (COM-6)", () => {
  const now = new Date("2026-09-30T00:00:00Z");
  it("state machine", () => {
    expect(registrationState({ status: "approved", protectedUntil: new Date("2026-10-30") }, now)).toBe("protected");
    expect(registrationState({ status: "approved", protectedUntil: new Date("2026-09-01") }, now)).toBe("expired");
    expect(registrationState({ status: "pending", protectedUntil: null }, now)).toBe("pending");
  });
  it("conflicts shown before submit", () => {
    const c = registrationConflicts({
      userId: "me",
      account: { ownerId: "someone", restricted: false },
      openDeals: [{ ownerId: "someone", pipelineName: "NetDev", stageName: "Hot" }],
      registrations: [{ userId: "other", status: "approved", protectedUntil: new Date("2026-12-01") }],
      now,
    });
    expect(c.map((x) => x.kind)).toEqual(["active_registration", "owned", "open_deal"]);
    expect(c[0]!.severity).toBe("block");
  });
  it("clean account has no conflicts", () => {
    expect(registrationConflicts({ userId: "me", account: { ownerId: null, restricted: false }, openDeals: [], registrations: [], now })).toEqual([]);
  });
});
