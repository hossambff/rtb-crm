import type { ProFormaInputs } from "./calc";

/**
 * Reference scenario: "New York Post x RTB - Pro Forma (Proposal Draft 9.17.26)", $250M NYP Holdings scenario held flat
 * (public-data estimates, FY2025 run-rate). Used as the calculator's regression fixture and as a builder template.
 * Revenue lines: digital advertising 66,000 → display; commerce & affiliate 32,000; print circulation 72,000 + print ads
 * 33,000 + licensing/Sports+/events 47,000 → other (out of scope). Revenue share applies to digital ads + commerce.
 */
export const NY_POST_FIXTURE: ProFormaInputs = {
  scenarioLabel: "$250M scenario, held flat (public-data estimates)",
  revenue: { display: 66_000_000, programmatic: 0, direct: 0, subscriptions: 0, commerce: 32_000_000, syndication: 0, other: 152_000_000 },
  revShareLines: ["display", "programmatic", "direct", "commerce", "syndication"],
  costs: [
    { label: "Content & print operations", fn: "other", amount: 121_000_000, rtbFundedPct: 0 },
    { label: "Digital platform, CDN & hosting", fn: "hosting", amount: 8_000_000, rtbFundedPct: 1 },
    { label: "Ad serving, exchange & partner rev-shares", fn: "ad_ops", amount: 9_000_000, rtbFundedPct: 1 },
    { label: "Digital ad ops & programmatic", fn: "ad_ops", amount: 6_000_000, rtbFundedPct: 1 },
    { label: "Platform engineering", fn: "engineering", amount: 12_000_000, rtbFundedPct: 1 },
    { label: "Sports+/e-edition platform & support", fn: "membership", amount: 3_000_000, rtbFundedPct: 1 },
    { label: "Product & data teams", fn: "other", amount: 6_000_000, rtbFundedPct: 1 },
    { label: "Events, studio & other", fn: "other", amount: 4_000_000, rtbFundedPct: 0 },
  ],
  smCost: 26_000_000,
  smAbsorbPct: 0.6,
  gaCost: 25_000_000,
  gaAbsorbPct: 0.25,
  revSharePct: 0.5,
  guaranteeType: "profit_floor",
  guaranteeAmount: 0,
  rampMonths: 0,
  termYears: 5,
  growthPct: 0,
};
