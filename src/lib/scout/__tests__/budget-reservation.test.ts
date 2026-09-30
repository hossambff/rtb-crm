import { describe, expect, it } from "vitest";
import { checkBudget, DEFAULT_BUDGET } from "../budget-core";

/**
 * H-04 regression (CODE_REVIEW Appendix, audit S2): a started run reserves its FULL allowed spend (maxAllowedCents),
 * not its estimate, so the next run sees the reservation and the org cap can't be overshot.
 */
describe("H-04 scout org cap with reservations", () => {
  const settings = { ...DEFAULT_BUDGET, orgMonthlyCents: 1000, perRunMaxCents: 50, userMonthlyCents: 1000 };

  it("run B sees run A's full reservation, not its estimate", () => {
    const a = checkBudget({ estimateCents: 10, orgSpentCents: 950, userSpentCents: 0, userCapCents: 1000, settings });
    expect(a.allowed).toBe(true);
    expect(a.maxAllowedCents).toBe(50);
    // reserveRun records A with output.maxAllowedCents = 50 → month-to-date spend for B = 950 + 50
    const b = checkBudget({ estimateCents: 10, orgSpentCents: 950 + a.maxAllowedCents, userSpentCents: 0, userCapCents: 1000, settings });
    expect(b.allowed).toBe(false);
    expect(b.blockedBy).toBe("org_cap");
    // worst case total never exceeds the cap
    expect(950 + a.maxAllowedCents + (b.allowed ? b.maxAllowedCents : 0)).toBeLessThanOrEqual(settings.orgMonthlyCents);
  });

  it("after A finishes, spend reconciles to its actual cost and frees headroom", () => {
    const actualA = 12;
    const b = checkBudget({ estimateCents: 10, orgSpentCents: 950 + actualA, userSpentCents: 0, userCapCents: 1000, settings });
    expect(b.allowed).toBe(true);
    expect(b.maxAllowedCents).toBe(38);
  });
});
