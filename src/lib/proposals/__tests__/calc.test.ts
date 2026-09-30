import { describe, expect, it } from "vitest";
import { approvalTriggers, canExport, computeProForma, diffInputs, normalizeInputs, type ProFormaInputs } from "../calc";
import { NY_POST_FIXTURE } from "../fixtures";

const M = 1_000_000;

describe("computeProForma — NY Post (9.17.26 pro forma, $250M flat)", () => {
  const out = computeProForma(NY_POST_FIXTURE);

  it("reproduces revenue and today's EBITDA", () => {
    expect(out.revenueTotal).toBe(250 * M);
    expect(out.costsBefore).toBe(220 * M);
    expect(out.clientEbitdaBefore).toBe(30 * M);
    expect(out.marginBefore).toBeCloseTo(0.12, 4);
  });

  it("RTB funds $38.0M of platform costs and $65.85M in total", () => {
    expect(out.platformFunded).toBe(38 * M);
    expect(out.smAbsorbed).toBe(15_600_000);
    expect(out.gaAbsorbed).toBe(6_250_000);
    expect(out.otherFunded).toBe(6 * M);
    expect(out.rtbFundedTotal).toBe(65_850_000);
  });

  it("EBITDA before revenue share rises $30.0M → $95.85M (38.3%)", () => {
    expect(out.clientEbitdaAfter).toBe(95_850_000);
    expect(out.uplift).toBe(65_850_000);
    expect(out.marginAfter).toBeCloseTo(0.3834, 3);
    expect(out.costsAfter).toBe(154_150_000);
  });

  it("at 50% the Post keeps $46.85M (RTB share $49.0M on digital ads + commerce)", () => {
    expect(out.inScopeRevenue).toBe(98 * M);
    expect(out.rtbShare).toBe(49 * M);
    expect(out.clientNetAfterShare).toBe(46_850_000);
    expect(out.clientNetUplift).toBe(16_850_000);
  });

  it("profit-floor guarantee (≥ today's $30M) carries no exposure at 50%", () => {
    expect(out.guaranteeFloorAnnual).toBe(30 * M);
    expect(out.guaranteeMonthly).toBe(2_500_000);
    expect(out.guaranteeExposure).toBe(0);
    expect(out.years.every((y) => y.guaranteeExposure === 0)).toBe(true);
  });

  it("multi-year table covers the term with flat revenue", () => {
    expect(out.years).toHaveLength(5);
    expect(out.years[4]!.clientNet).toBe(46_850_000);
    expect(out.totals.rtbShare).toBe(5 * 49 * M);
  });
});

describe("computeProForma — ramp, growth, guarantee exposure", () => {
  it("ramp months pay 100% to the partner", () => {
    const out = computeProForma({ ...NY_POST_FIXTURE, rampMonths: 6 });
    expect(out.years[0]!.rtbShare).toBe(24_500_000);
    expect(out.years[1]!.rtbShare).toBe(49 * M);
  });

  it("growth applies to in-scope lines from year 2", () => {
    const out = computeProForma({ ...NY_POST_FIXTURE, growthPct: 0.1, termYears: 2 });
    expect(out.years[0]!.inScopeRevenue).toBe(98 * M);
    expect(out.years[1]!.inScopeRevenue).toBeCloseTo(107_800_000, 0);
    expect(out.years[1]!.revenue).toBeCloseTo(259_800_000, 0);
  });

  it("a very high share triggers profit-floor exposure", () => {
    const out = computeProForma({ ...NY_POST_FIXTURE, revSharePct: 0.8 });
    // 95.85 − 78.4 = 17.45 < 30 → RTB pays 12.55
    expect(out.clientNetAfterShare).toBeCloseTo(17_450_000, 0);
    expect(out.guaranteeExposure).toBeCloseTo(12_550_000, 0);
  });

  it("fixed monthly guarantee compares against the client's retained in-scope revenue", () => {
    const out = computeProForma({ ...NY_POST_FIXTURE, guaranteeType: "fixed_monthly", guaranteeAmount: 5 * M });
    // floor 60M/yr vs retained 98 − 49 = 49 → exposure 11M
    expect(out.guaranteeFloorAnnual).toBe(60 * M);
    expect(out.guaranteeExposure).toBe(11 * M);
  });

  it("no guarantee → no exposure", () => {
    const out = computeProForma({ ...NY_POST_FIXTURE, guaranteeType: "none", revSharePct: 1 });
    expect(out.guaranteeExposure).toBe(0);
  });

  it("fractional term produces a partial final year", () => {
    const out = computeProForma({ ...NY_POST_FIXTURE, termYears: 1.5 });
    expect(out.years).toHaveLength(2);
    expect(out.years[1]!.rtbShare).toBe(24_500_000);
  });
});

describe("approval rules (PRO-3)", () => {
  it("NY Post needs approval for the guarantee size only", () => {
    const reasons = approvalTriggers(NY_POST_FIXTURE);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/Guarantee/);
  });
  it("flags rev share below 40% and term above 10y", () => {
    const small: ProFormaInputs = { ...NY_POST_FIXTURE, guaranteeType: "none", revSharePct: 0.35, termYears: 12 };
    const reasons = approvalTriggers(small);
    expect(reasons.some((r) => /floor/.test(r))).toBe(true);
    expect(reasons.some((r) => /Term/.test(r))).toBe(true);
  });
  it("a clean draft is exportable, a triggered draft is not", () => {
    expect(canExport("draft", [])).toBe(true);
    expect(canExport("draft", ["x"])).toBe(false);
    expect(canExport("pending_approval", ["x"])).toBe(false);
    expect(canExport("approved", ["x"])).toBe(true);
  });
});

describe("diffInputs (PRO-2)", () => {
  it("lists only changed fields with readable labels", () => {
    const b = { ...NY_POST_FIXTURE, revSharePct: 0.45, costs: NY_POST_FIXTURE.costs.map((c, i) => (i === 1 ? { ...c, amount: 9_500_000 } : c)) };
    const d = diffInputs(NY_POST_FIXTURE, b);
    expect(d.map((x) => x.label)).toEqual(expect.arrayContaining(["Revenue share", 'Cost "Digital platform, CDN & hosting": amount']));
    expect(d).toHaveLength(2);
  });
  it("normalizes partial JSON", () => {
    const i = normalizeInputs({ revenue: { display: "x" }, revSharePct: 7 });
    expect(i.revenue.display).toBe(0);
    expect(i.revSharePct).toBe(1);
    expect(diffInputs({}, {})).toEqual([]);
  });
});
