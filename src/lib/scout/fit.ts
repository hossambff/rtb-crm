/**
 * Lead Scout Fit Score (PRD §M25.4, SCOUT-9/11/15; ICP per D7). Pure — unit tested.
 *
 * score = Σ weight_f × signal_f, signal ∈ [0,1], weights normalized to 100 (admin-editable in settings scout.fit_weights).
 * Returns the per-factor contribution (points), a plain-English explanation, an estimated opportunity value
 * (est. MUU × $/MUU, always labeled "estimate") and a routing suggestion (NET / SPT / ENT).
 */

export const FIT_FACTORS = ["audience", "vertical", "ownership", "pain", "stack", "lookalike", "geo", "relationship"] as const;
export type FitFactor = (typeof FIT_FACTORS)[number];
export type FitWeights = Record<FitFactor, number>;

export const DEFAULT_FIT_WEIGHTS: FitWeights = { audience: 25, vertical: 15, ownership: 15, pain: 15, stack: 10, lookalike: 10, geo: 5, relationship: 5 };

export const FIT_FACTOR_LABELS: Record<FitFactor, string> = {
  audience: "Audience size",
  vertical: "Vertical fit",
  ownership: "Ownership / decision speed",
  pain: "Pain signals",
  stack: "Stack displaceability",
  lookalike: "Lookalike similarity",
  geo: "Geography / language",
  relationship: "Relationship proximity",
};

export type SweetSpot = { NET: { min: number; max: number }; ENT: { min: number } };
export const DEFAULT_SWEET_SPOT: SweetSpot = { NET: { min: 250_000, max: 25_000_000 }, ENT: { min: 10_000_000 } };

export const DEFAULT_CORE_VERTICALS = ["Finance", "Crypto", "Politics", "News", "Sports", "AI", "Emerging Tech", "Military/Defense"];
export const DEFAULT_SUPPORTED_COUNTRIES = ["US", "GB", "IE", "CA", "AU", "ES", "MX", "AR", "CO", "IN", "PL"];

/** CMS / ad-stack vendors RTB's platform replaces ("the 17 vendors"). Matched case-insensitively as substrings. */
export const DISPLACEABLE_VENDORS = [
  "WordPress VIP", "WordPress", "Arc XP", "Arc Publishing", "Brightspot", "Newspack", "Ghost", "Drupal",
  "Piano", "Zephr", "Taboola", "Outbrain", "Revcontent", "MGID", "Google Ad Manager", "DoubleClick", "GAM", "Prebid",
  "Amazon Publisher Services", "Mediavine", "Raptive", "AdThrive", "Freestar", "Ezoic", "Media.net", "Sovrn",
  "Connatix", "Primis", "JW Player", "Brightcove", "Chartbeat", "Parse.ly", "Admiral", "OneTrust",
];

export type Ownership = "independent" | "founder_led" | "group_owned" | "public_company" | "unknown";

export function normalizeOwnership(raw: string | null | undefined): Ownership {
  const s = (raw ?? "").toLowerCase();
  if (!s) return "unknown";
  if (/founder/.test(s)) return "founder_led";
  if (/indep/.test(s)) return "independent";
  if (/group|owned by|subsidiar|network|conglomerate/.test(s)) return "group_owned";
  if (/public|listed|nasdaq|nyse/.test(s)) return "public_company";
  return "unknown";
}

export type FitInput = {
  estMuu: number | null; // null = unknown
  category: string | null;
  ownership: string | null;
  country: string | null;
  trendPct: number | null; // −0.18 = −18%
  techStack: string[];
  lookalikeSimilarity: number | null; // 0..1
  hasRelationship: boolean; // existing contacts / prior RTB100 or TheStreet relationship
};

export type FitConfig = {
  weights?: Partial<FitWeights>;
  sweetSpot?: SweetSpot;
  coreVerticals?: string[]; // ranked (first = strongest won-deal history)
  supportedCountries?: string[];
  usdPerMuu?: number;
};

export type Routing = "NET" | "SPT" | "ENT";

export type FitResult = {
  score: number; // 0..100 integer
  factors: Record<FitFactor, number>; // points contributed (0..weight)
  signals: Record<FitFactor, number>; // 0..1
  weights: FitWeights; // normalized to 100
  explanation: string;
  routing: Routing;
  routingReason: string;
  estValueUsd: number | null; // estimate (est MUU × $/MUU)
  displaceableVendors: string[];
};

export function normalizeWeights(w?: Partial<FitWeights>): FitWeights {
  const merged: FitWeights = { ...DEFAULT_FIT_WEIGHTS };
  if (w) for (const f of FIT_FACTORS) if (typeof w[f] === "number" && Number.isFinite(w[f]) && w[f]! >= 0) merged[f] = w[f]!;
  const total = FIT_FACTORS.reduce((a, f) => a + merged[f], 0);
  if (total <= 0) return { ...DEFAULT_FIT_WEIGHTS };
  const out = {} as FitWeights;
  for (const f of FIT_FACTORS) out[f] = (merged[f] / total) * 100;
  return out;
}

export function matchDisplaceable(techStack: string[]): string[] {
  const hits = new Set<string>();
  const lower = techStack.map((t) => t.toLowerCase());
  for (const v of DISPLACEABLE_VENDORS) {
    const lv = v.toLowerCase();
    // short tokens (GAM) must match a whole word
    const ok = lv.length <= 3 ? lower.some((t) => new RegExp(`\\b${lv}\\b`).test(t)) : lower.some((t) => t.includes(lv));
    if (ok) hits.add(v);
  }
  // "WordPress VIP" implies "WordPress": keep only the most specific
  if (hits.has("WordPress VIP")) hits.delete("WordPress");
  if (hits.has("Raptive") && hits.has("AdThrive")) hits.delete("AdThrive");
  return [...hits];
}

/** Audience signal: full inside the NET sweet spot; ramps on log scale below it; big sites still valuable (ENT). */
export function audienceSignal(muu: number | null, spot: SweetSpot = DEFAULT_SWEET_SPOT): number {
  if (muu == null) return 0.3; // unknown: neutral-low, flagged in the explanation
  if (muu <= 0) return 0;
  const { min, max } = spot.NET;
  if (muu >= min && muu <= max) return 1;
  if (muu > max) return 0.8; // above NET band → ENT-sized, still a strong target
  const floor = min / 10; // 25K with default band
  if (muu <= floor) return 0;
  return Math.round((Math.log10(muu / floor) / Math.log10(min / floor)) * 100) / 100;
}

export function verticalSignal(category: string | null, core: string[] = DEFAULT_CORE_VERTICALS): number {
  if (!category) return 0.3;
  const idx = core.findIndex((c) => c.toLowerCase() === category.toLowerCase());
  if (idx < 0) return 0.2;
  if (core.length <= 1) return 1;
  return Math.round((1 - (idx / (core.length - 1)) * 0.3) * 100) / 100; // 1.0 … 0.7 by won-deal rank
}

export function ownershipSignal(o: Ownership): number {
  switch (o) {
    case "independent":
    case "founder_led":
      return 1;
    case "public_company":
      return 0.5;
    case "group_owned":
      return 0.3;
    default:
      return 0.5;
  }
}

export function painSignal(trendPct: number | null, techStack: string[]): number {
  let s = 0;
  if (trendPct != null) {
    if (trendPct <= -0.15) s += 0.6;
    else if (trendPct <= -0.05) s += 0.4;
    else if (trendPct < 0.05) s += 0.15;
  }
  const vendors = techStack.length;
  if (vendors >= 6) s += 0.4;
  else if (vendors >= 3) s += 0.2;
  if (trendPct == null && vendors === 0) return 0.2; // no data: neutral-low
  return Math.min(1, s);
}

export function stackSignal(displaceable: string[], techStackKnown: boolean): number {
  if (!techStackKnown) return 0.2;
  return Math.min(1, displaceable.length / 3);
}

export function geoSignal(country: string | null, supported: string[] = DEFAULT_SUPPORTED_COUNTRIES): number {
  if (!country) return 0.5;
  const c = country.toUpperCase() === "UK" ? "GB" : country.toUpperCase();
  return supported.map((x) => x.toUpperCase()).includes(c) ? 1 : 0;
}

export function suggestRouting(input: { estMuu: number | null; ownership: Ownership; category: string | null }, spot: SweetSpot = DEFAULT_SWEET_SPOT): { routing: Routing; reason: string } {
  if (input.ownership === "group_owned") return { routing: "ENT", reason: "Group-owned — needs group sign-off (ENT)" };
  if (input.estMuu != null && input.estMuu >= spot.ENT.min) return { routing: "ENT", reason: `≥ ${fmtCompact(spot.ENT.min)} MUU routes to Enterprise` };
  if (input.category && /sport/i.test(input.category)) return { routing: "SPT", reason: "Sports site → Sports Network" };
  return { routing: "NET", reason: "Independent / mid-size publisher → Network Development" };
}

export function fmtCompact(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

export function computeFit(input: FitInput, config: FitConfig = {}): FitResult {
  const weights = normalizeWeights(config.weights);
  const spot = config.sweetSpot ?? DEFAULT_SWEET_SPOT;
  const ownership = normalizeOwnership(input.ownership);
  const displaceable = matchDisplaceable(input.techStack);
  const signals: Record<FitFactor, number> = {
    audience: audienceSignal(input.estMuu, spot),
    vertical: verticalSignal(input.category, config.coreVerticals ?? DEFAULT_CORE_VERTICALS),
    ownership: ownershipSignal(ownership),
    pain: painSignal(input.trendPct, input.techStack),
    stack: stackSignal(displaceable, input.techStack.length > 0),
    lookalike: input.lookalikeSimilarity == null ? 0 : Math.max(0, Math.min(1, input.lookalikeSimilarity)),
    geo: geoSignal(input.country, config.supportedCountries ?? DEFAULT_SUPPORTED_COUNTRIES),
    relationship: input.hasRelationship ? 1 : 0,
  };
  const factors = {} as Record<FitFactor, number>;
  let total = 0;
  for (const f of FIT_FACTORS) {
    factors[f] = Math.round(weights[f] * signals[f] * 10) / 10;
    total += weights[f] * signals[f];
  }
  const score = Math.max(0, Math.min(100, Math.round(total)));
  const { routing, reason } = suggestRouting({ estMuu: input.estMuu, ownership, category: input.category }, spot);
  const usdPerMuu = config.usdPerMuu ?? 1;
  const estValueUsd = input.estMuu != null ? Math.round(input.estMuu * usdPerMuu) : null;

  // explanation, e.g. "82: 3.4M MUU in core Finance vertical, independent owner, declining traffic −18% (pain), …"
  const parts: string[] = [];
  if (input.estMuu == null) parts.push("MUU unknown");
  else {
    const band = input.estMuu >= spot.NET.min && input.estMuu <= spot.NET.max ? "in the NET sweet spot" : input.estMuu > spot.NET.max ? "above the NET band (ENT-sized)" : "below the sweet spot";
    parts.push(`${fmtCompact(input.estMuu)} est. MUU ${band}`);
  }
  if (input.category) parts.push(signals.vertical >= 0.7 ? `core ${input.category} vertical` : `${input.category} (non-core vertical)`);
  if (ownership === "independent" || ownership === "founder_led") parts.push(ownership === "founder_led" ? "founder-led" : "independent owner");
  else if (ownership === "group_owned") parts.push("group-owned (group sign-off)");
  else if (ownership === "public_company") parts.push("public company");
  if (input.trendPct != null) {
    const pct = Math.round(input.trendPct * 100);
    if (pct <= -5) parts.push(`declining traffic ${pct}% (pain)`);
    else if (pct >= 5) parts.push(`growing traffic +${pct}%`);
    else parts.push("flat traffic");
  }
  if (displaceable.length) parts.push(`${displaceable.length} displaceable vendor${displaceable.length > 1 ? "s" : ""} (${displaceable.slice(0, 3).join(", ")})`);
  else if (input.techStack.length) parts.push(`${input.techStack.length} vendors detected`);
  if (signals.lookalike >= 0.5) parts.push("similar to won/hot partners");
  if (input.country && signals.geo === 0) parts.push(`outside supported markets (${input.country})`);
  if (input.hasRelationship) parts.push("existing relationship");
  const explanation = `${score}: ${parts.join(", ")}.`;

  return { score, factors, signals, weights, explanation, routing, routingReason: reason, estValueUsd, displaceableVendors: displaceable };
}

/** Estimated MUU from monthly visits (SCOUT-7): visits ÷ factor, with per-category override. */
export function estimateMuu(
  monthlyVisits: number | null | undefined,
  category: string | null | undefined,
  defaultFactor = 2.5,
  byCategory: Record<string, number> = {},
): { muu: number | null; factor: number } {
  const override = category ? Object.entries(byCategory).find(([k]) => k.toLowerCase() === category.toLowerCase())?.[1] : undefined;
  const factor = override && override > 0 ? override : defaultFactor > 0 ? defaultFactor : 2.5;
  if (monthlyVisits == null || !Number.isFinite(monthlyVisits) || monthlyVisits < 0) return { muu: null, factor };
  return { muu: Math.round(monthlyVisits / factor), factor };
}

/** Status palette bucket for a Fit Score (color + icon + label in UI). */
export function fitStatus(score: number | null | undefined): "good" | "warning" | "serious" | "critical" {
  if (score == null) return "warning";
  if (score >= 70) return "good";
  if (score >= 50) return "warning";
  if (score >= 30) return "serious";
  return "critical";
}
