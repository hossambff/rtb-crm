import { describe, expect, it } from "vitest";
import {
  accrualKey,
  clawbackDue,
  clawbackEventAt,
  clawbackKey,
  normalizeRules,
  planAccruals,
  ruleIdFromKey,
  type CommissionEvent,
  type PlanRule,
} from "../calc";

/** Regression tests ported from docs/audits/CODE_REVIEW.md Appendix A (CR-01, H-02). */

const base = { userId: "u1", planId: "p1", planName: "Plan", effectiveFrom: new Date("2026-01-01T00:00:00Z") };
const wonEvent: CommissionEvent = {
  trigger: "deal_won",
  sourceId: "deal-1",
  at: new Date("2026-09-10T12:00:00Z"),
  pipelineKey: "NET",
  dealId: "deal-1",
  contractCents: 1_000_000,
  netCents: 500_000,
  recipients: [{ userId: "u1", pct: 100 }],
  label: "Deal 1 won",
};
const ruleA_meeting: PlanRule = { trigger: "meeting_held", rateType: "flat", rate: 5_000 };
const ruleB_won: PlanRule = { trigger: "deal_won", rateType: "pct_contract", rate: 10, clawbackDays: 90 };

describe("CR-01 accrual idempotency survives plan edits", () => {
  it("deleting an earlier rule does not re-accrue the same event (legacy rules without ids)", () => {
    const run1 = planAccruals({ ...base, rules: [ruleA_meeting, ruleB_won], events: [wonEvent], existingKeys: new Set(), periodTotals: new Map() });
    expect(run1).toHaveLength(1);
    const run2 = planAccruals({ ...base, rules: [ruleB_won], events: [wonEvent], existingKeys: new Set(run1.map((d) => d.key)), periodTotals: new Map() });
    expect(run2).toEqual([]);
  });

  it("reordering rules does not re-accrue", () => {
    const run1 = planAccruals({ ...base, rules: [ruleA_meeting, ruleB_won], events: [wonEvent], existingKeys: new Set(), periodTotals: new Map() });
    const run2 = planAccruals({ ...base, rules: [ruleB_won, ruleA_meeting], events: [wonEvent], existingKeys: new Set(run1.map((d) => d.key)), periodTotals: new Map() });
    expect(run2).toEqual([]);
  });

  it("a rule with a stable id keeps its accruals when its rate is edited", () => {
    const v1: PlanRule = { ...ruleB_won, id: "rule-won" };
    const run1 = planAccruals({ ...base, rules: [v1], events: [wonEvent], existingKeys: new Set(), periodTotals: new Map() });
    const v2: PlanRule = { ...v1, rate: 12 };
    const run2 = planAccruals({ ...base, rules: [v2], events: [wonEvent], existingKeys: new Set(run1.map((d) => d.key)), periodTotals: new Map() });
    expect(run2).toEqual([]);
  });

  it("source key = trigger + rule id + event id + split user; rule id is recoverable", () => {
    const [rule] = normalizeRules([{ ...ruleB_won, id: "abc" }]);
    const key = accrualKey(rule!.id, "deal_won", "deal-1", "u1");
    expect(key).toBe("deal_won:abc:deal-1:u1");
    expect(ruleIdFromKey(key)).toBe("abc");
    expect(ruleIdFromKey(clawbackKey(key))).toBe("abc");
  });

  it("split partners get distinct keys for the same event", () => {
    const ev = { ...wonEvent, recipients: [{ userId: "u1", pct: 50 }, { userId: "u2", pct: 50 }] };
    const a = planAccruals({ ...base, userId: "u1", rules: [ruleB_won], events: [ev], existingKeys: new Set(), periodTotals: new Map() });
    const b = planAccruals({ ...base, userId: "u2", rules: [ruleB_won], events: [ev], existingKeys: new Set(), periodTotals: new Map() });
    expect(a[0]!.key).not.toBe(b[0]!.key);
  });

  it("identical duplicate rules get distinct ids (both pay)", () => {
    const rules = normalizeRules([ruleB_won, ruleB_won]);
    expect(rules[0]!.id).not.toBe(rules[1]!.id);
  });
});

describe("H-02 clawback for deal_won after the deal was lost (wonAt cleared)", () => {
  it("uses the last win from stage history when wonAt is null", () => {
    const eventAt = clawbackEventAt({ trigger: "deal_won", lastWinAt: new Date("2026-08-01T00:00:00Z"), accruedAt: new Date("2026-08-02T00:00:00Z") });
    expect(clawbackDue({ eventAt, lostAt: new Date("2026-09-20"), clawbackDays: 90 })).toBe(true);
  });
  it("falls back to the accrual time (never earlier than the event) when history has no win", () => {
    const eventAt = clawbackEventAt({ trigger: "deal_won", lastWinAt: null, accruedAt: new Date("2026-08-02T00:00:00Z") });
    expect(clawbackDue({ eventAt, lostAt: new Date("2026-09-20"), clawbackDays: 90 })).toBe(true);
    expect(clawbackDue({ eventAt, lostAt: new Date("2027-09-20"), clawbackDays: 90 })).toBe(false);
  });
  it("migration_launched uses the go-live date", () => {
    const eventAt = clawbackEventAt({ trigger: "migration_launched", goLiveAt: new Date("2026-01-01"), lastWinAt: new Date("2025-06-01"), accruedAt: new Date("2026-01-02") });
    expect(eventAt.toISOString().slice(0, 10)).toBe("2026-01-01");
  });
});
