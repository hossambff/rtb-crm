import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIT_WEIGHTS,
  FIT_FACTORS,
  audienceSignal,
  computeFit,
  estimateMuu,
  fitStatus,
  geoSignal,
  matchDisplaceable,
  normalizeOwnership,
  normalizeWeights,
  painSignal,
  suggestRouting,
  verticalSignal,
  type FitInput,
} from "../fit";

const base: FitInput = {
  estMuu: 3_400_000,
  category: "Finance",
  ownership: "independent",
  country: "US",
  trendPct: -0.18,
  techStack: ["WordPress VIP", "Taboola", "Outbrain", "Google Ad Manager", "Prebid", "Chartbeat"],
  lookalikeSimilarity: 0.8,
  hasRelationship: false,
};

describe("normalizeWeights", () => {
  it("defaults sum to 100 and match the PRD table", () => {
    const w = normalizeWeights();
    expect(w).toEqual(DEFAULT_FIT_WEIGHTS);
    expect(FIT_FACTORS.reduce((a, f) => a + w[f], 0)).toBeCloseTo(100);
  });
  it("rescales admin weights that don't sum to 100", () => {
    const w = normalizeWeights({ audience: 50, vertical: 50, ownership: 0, pain: 0, stack: 0, lookalike: 0, geo: 0, relationship: 0 });
    expect(w.audience).toBeCloseTo(50);
    expect(w.vertical).toBeCloseTo(50);
    const w2 = normalizeWeights({ audience: 250 });
    expect(FIT_FACTORS.reduce((a, f) => a + w2[f], 0)).toBeCloseTo(100);
    expect(w2.audience).toBeGreaterThan(50);
  });
  it("ignores negative / NaN weights and falls back when all zero", () => {
    expect(normalizeWeights({ audience: -5 }).audience).toBeCloseTo(25);
    expect(normalizeWeights({ audience: Number.NaN }).audience).toBeCloseTo(25);
    const zero = Object.fromEntries(FIT_FACTORS.map((f) => [f, 0]));
    expect(normalizeWeights(zero)).toEqual(DEFAULT_FIT_WEIGHTS);
  });
});

describe("audienceSignal (D7 sweet spot 250K–25M)", () => {
  it("is graded inside the band — larger audiences score higher (QA-10)", () => {
    expect(audienceSignal(250_000)).toBe(0.5);
    expect(audienceSignal(1_000_000)).toBe(0.9);
    expect(audienceSignal(10_000_000)).toBe(1);
    expect(audienceSignal(25_000_000)).toBe(1);
    const [a, b, c] = [audienceSignal(800_000), audienceSignal(3_500_000), audienceSignal(12_000_000)];
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(a).toBeGreaterThan(0.5);
  });
  it("QA-10 repro: 0.8M / 3.5M / 12M produce three different audience points", () => {
    const pts = [800_000, 3_500_000, 12_000_000].map((m) => computeFit({ ...base, estMuu: m }).factors.audience);
    expect(new Set(pts).size).toBe(3);
  });
  it("ramps below the band and is zero for tiny sites", () => {
    expect(audienceSignal(25_000)).toBe(0);
    expect(audienceSignal(10_000)).toBe(0);
    const mid = audienceSignal(80_000);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(audienceSignal(200_000)).toBeGreaterThan(audienceSignal(100_000));
  });
  it("ENT-sized audiences stay at the top", () => {
    expect(audienceSignal(60_000_000)).toBe(1);
  });
  it("unknown MUU is neutral-low", () => {
    expect(audienceSignal(null)).toBe(0.3);
    expect(audienceSignal(0)).toBe(0);
  });
});

describe("factor signals", () => {
  it("vertical ranks core verticals by won-deal order", () => {
    expect(verticalSignal("Finance")).toBe(1);
    expect(verticalSignal("finance")).toBe(1);
    expect(verticalSignal("Military/Defense")).toBe(0.7);
    expect(verticalSignal("Food")).toBe(0.2);
    expect(verticalSignal(null)).toBe(0.3);
  });
  it("ownership normalization", () => {
    expect(normalizeOwnership("Independent")).toBe("independent");
    expect(normalizeOwnership("Founder-led")).toBe("founder_led");
    expect(normalizeOwnership("group_owned")).toBe("group_owned");
    expect(normalizeOwnership("Owned by Reach plc")).toBe("group_owned");
    expect(normalizeOwnership("public_company")).toBe("public_company");
    expect(normalizeOwnership("")).toBe("unknown");
  });
  it("pain rewards decline and vendor sprawl", () => {
    expect(painSignal(-0.2, ["a", "b", "c", "d", "e", "f"])).toBe(1);
    expect(painSignal(-0.1, [])).toBe(0.4);
    expect(painSignal(0.3, [])).toBe(0);
    expect(painSignal(null, [])).toBe(0.2);
    expect(painSignal(null, ["a", "b", "c"])).toBe(0.2);
  });
  it("geo supports UK alias and unknown", () => {
    expect(geoSignal("GB")).toBe(1);
    expect(geoSignal("uk")).toBe(1);
    expect(geoSignal("BR")).toBe(0);
    expect(geoSignal(null)).toBe(0.5);
  });
  it("displaceable vendors: specific wins, short tokens whole-word", () => {
    expect(matchDisplaceable(["WordPress VIP", "Taboola"])).toEqual(expect.arrayContaining(["WordPress VIP", "Taboola"]));
    expect(matchDisplaceable(["WordPress VIP"])).not.toContain("WordPress");
    expect(matchDisplaceable(["Gamification toolkit"])).not.toContain("GAM");
    expect(matchDisplaceable(["GAM 360"])).toContain("GAM");
    expect(matchDisplaceable(["Shopify"])).toEqual([]);
  });
});

describe("computeFit", () => {
  it("scores a textbook NET target highly with an explanation", () => {
    const r = computeFit(base);
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.explanation.startsWith(`${r.score}:`)).toBe(true);
    expect(r.explanation).toContain("3.4M est. MUU in the NET sweet spot");
    expect(r.explanation).toContain("core Finance vertical");
    expect(r.explanation).toContain("independent owner");
    expect(r.explanation).toContain("declining traffic -18% (pain)");
    expect(r.explanation).toMatch(/displaceable vendors/);
    expect(r.routing).toBe("NET");
  });
  it("factor contributions sum to the score (±rounding) and never exceed weights", () => {
    const r = computeFit(base);
    const sum = FIT_FACTORS.reduce((a, f) => a + r.factors[f], 0);
    expect(Math.abs(sum - r.score)).toBeLessThanOrEqual(1);
    for (const f of FIT_FACTORS) expect(r.factors[f]).toBeLessThanOrEqual(r.weights[f] + 1e-9);
  });
  it("perfect signals → 100, nothing → low", () => {
    const perfect = computeFit({ ...base, estMuu: 12_000_000, hasRelationship: true, lookalikeSimilarity: 1, techStack: [...base.techStack] });
    expect(perfect.score).toBe(100);
    const poor = computeFit({ estMuu: 5_000, category: "Food", ownership: "group owned", country: "BR", trendPct: 0.4, techStack: ["Shopify"], lookalikeSimilarity: null, hasRelationship: false });
    expect(poor.score).toBeLessThan(20);
    expect(poor.routing).toBe("ENT");
  });
  it("respects admin weights", () => {
    const onlyAudience = { audience: 100, vertical: 0, ownership: 0, pain: 0, stack: 0, lookalike: 0, geo: 0, relationship: 0 };
    expect(computeFit({ ...base, estMuu: 10_000_000 }, { weights: onlyAudience }).score).toBe(100);
    expect(computeFit({ ...base, estMuu: 1_000_000 }, { weights: onlyAudience }).score).toBe(90);
    expect(computeFit({ ...base, estMuu: 10_000 }, { weights: onlyAudience }).score).toBe(0);
  });
  it("estimated value = est MUU × $/MUU", () => {
    expect(computeFit(base, { usdPerMuu: 1 }).estValueUsd).toBe(3_400_000);
    expect(computeFit(base, { usdPerMuu: 0.5 }).estValueUsd).toBe(1_700_000);
    expect(computeFit({ ...base, estMuu: null }).estValueUsd).toBeNull();
  });
  it("unknown MUU is flagged and still scorable (domain lists without Apify)", () => {
    const r = computeFit({ ...base, estMuu: null, trendPct: null, techStack: [] });
    expect(r.explanation).toContain("MUU unknown");
    expect(r.score).toBeGreaterThan(0);
  });
  it("custom sweet spot", () => {
    const spot = { NET: { min: 100_000, max: 1_000_000 }, ENT: { min: 5_000_000 } };
    expect(computeFit({ ...base, estMuu: 150_000 }, { sweetSpot: spot }).signals.audience).toBeGreaterThan(0.5);
    expect(computeFit({ ...base, estMuu: 6_000_000 }, { sweetSpot: spot }).signals.audience).toBe(1);
  });
  it("explanation agrees with routing for ≥10M (QA-10)", () => {
    const r = computeFit({ ...base, estMuu: 12_000_000 });
    expect(r.routing).toBe("ENT");
    expect(r.explanation).toContain("Enterprise-sized");
    expect(r.explanation).not.toContain("NET sweet spot");
  });
});

describe("routing (D7)", () => {
  it("≥10M MUU → ENT", () => {
    expect(suggestRouting({ estMuu: 10_000_000, ownership: "independent", category: "Finance" }).routing).toBe("ENT");
    expect(suggestRouting({ estMuu: 9_999_999, ownership: "independent", category: "Finance" }).routing).toBe("NET");
  });
  it("group-owned → ENT regardless of size", () => {
    expect(suggestRouting({ estMuu: 400_000, ownership: "group_owned", category: "News" }).routing).toBe("ENT");
  });
  it("sports → SPT", () => {
    expect(suggestRouting({ estMuu: 800_000, ownership: "independent", category: "Sports" }).routing).toBe("SPT");
  });
});

describe("estimateMuu (SCOUT-7)", () => {
  it("visits ÷ default factor 2.5", () => {
    expect(estimateMuu(2_500_000, "Finance")).toEqual({ muu: 1_000_000, factor: 2.5 });
  });
  it("per-category override (case-insensitive)", () => {
    expect(estimateMuu(3_000_000, "news", 2.5, { News: 3.0, Sports: 2.0 })).toEqual({ muu: 1_000_000, factor: 3 });
    expect(estimateMuu(2_000_000, "Sports", 2.5, { News: 3.0, Sports: 2.0 }).muu).toBe(1_000_000);
  });
  it("unknown visits → null MUU, invalid factor falls back", () => {
    expect(estimateMuu(null, "News").muu).toBeNull();
    expect(estimateMuu(1000, null, 0).factor).toBe(2.5);
  });
});

describe("fitStatus", () => {
  it("buckets", () => {
    expect(fitStatus(85)).toBe("good");
    expect(fitStatus(55)).toBe("warning");
    expect(fitStatus(35)).toBe("serious");
    expect(fitStatus(10)).toBe("critical");
    expect(fitStatus(null)).toBe("warning");
  });
});
