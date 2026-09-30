/**
 * ENT pro forma calculator (PRD PRO-1). Pure: no server deps, unit tested.
 *
 * Model (RTB client pro forma playbook, NY Post 9.14/9.17 structure):
 *   revenue      = Σ revenue lines (held flat by construction in year 1)
 *   costsBefore  = Σ cost stack + S&M + G&A
 *   EBITDA before              = revenue − costsBefore
 *   RTB-funded                 = Σ(cost line × rtbFundedPct) + S&M × smAbsorbPct + G&A × gaAbsorbPct
 *   EBITDA after (pre-share)   = EBITDA before + RTB-funded           ("uplift" = RTB-funded)
 *   RTB share                  = revSharePct × Σ revenue lines flagged in `revShareLines`
 *   client net after share     = EBITDA after − RTB share
 *   guarantee exposure         = shortfall RTB pays under the guarantee
 *
 * All money in whole USD (not cents). Percentages 0..1.
 */

export const REVENUE_LINES = ["display", "programmatic", "direct", "subscriptions", "commerce", "syndication", "other"] as const;
export type RevenueLine = (typeof REVENUE_LINES)[number];
export const REVENUE_LINE_LABELS: Record<RevenueLine, string> = {
  display: "Display advertising",
  programmatic: "Programmatic",
  direct: "Direct-sold",
  subscriptions: "Subscriptions & membership",
  commerce: "Commerce & affiliate",
  syndication: "Syndication",
  other: "Other (out of scope: print, licensing)",
};
/** Lines the revenue share applies to by default: digital advertising + commerce (NY Post letter §6). */
export const DEFAULT_REV_SHARE_LINES: RevenueLine[] = ["display", "programmatic", "direct", "commerce", "syndication"];

export const COST_FUNCTIONS = ["cms", "video", "ad_ops", "engineering", "membership", "hosting", "other"] as const;
export type CostFunction = (typeof COST_FUNCTIONS)[number];
export const COST_FUNCTION_LABELS: Record<CostFunction, string> = {
  cms: "CMS",
  video: "Video",
  ad_ops: "Ad ops",
  engineering: "Engineering",
  membership: "Membership",
  hosting: "Hosting / CDN",
  other: "Other",
};
/** Functions counted as "platform" (vs people/teams) in the funded-cost breakdown. */
const PLATFORM_FUNCTIONS: CostFunction[] = ["cms", "video", "ad_ops", "engineering", "membership", "hosting"];

export type CostLine = {
  label: string;
  fn: CostFunction;
  vendor?: string;
  amount: number; // annual USD
  rtbFundedPct: number; // 0..1 share of this line RTB takes over
};

export type GuaranteeType = "profit_floor" | "fixed_monthly" | "none";

export type ProFormaInputs = {
  scenarioLabel?: string;
  revenue: Record<RevenueLine, number>;
  revShareLines: RevenueLine[];
  costs: CostLine[];
  smCost: number;
  smAbsorbPct: number; // 0..1
  gaCost: number;
  gaAbsorbPct: number; // 0..1
  revSharePct: number; // 0..1 RTB % of in-scope revenue
  guaranteeType: GuaranteeType;
  /** profit_floor: annual floor in USD (0/empty = today's EBITDA). fixed_monthly: USD per month. */
  guaranteeAmount: number;
  rampMonths: number; // months at 100% to partner (no RTB share)
  termYears: number;
  growthPct: number; // 0..1 per year, applied to rev-share (in-scope) lines from year 2
  notes?: string;
};

export type YearRow = {
  year: number;
  revenue: number;
  inScopeRevenue: number;
  ebitdaBefore: number;
  ebitdaAfter: number;
  rtbShare: number;
  clientNet: number;
  guaranteeExposure: number;
  clientNetWithGuarantee: number;
};

export type ProFormaOutputs = {
  revenueTotal: number;
  inScopeRevenue: number;
  costsBefore: number;
  costsAfter: number;
  platformFunded: number;
  otherFunded: number;
  smAbsorbed: number;
  gaAbsorbed: number;
  rtbFundedTotal: number;
  clientEbitdaBefore: number;
  clientEbitdaAfter: number;
  marginBefore: number;
  marginAfter: number;
  uplift: number;
  ebitdaMultiple: number | null;
  rtbShare: number;
  clientNetAfterShare: number;
  clientNetUplift: number;
  guaranteeFloorAnnual: number;
  guaranteeMonthly: number;
  guaranteeExposure: number;
  years: YearRow[];
  totals: { rtbShare: number; clientNet: number; guaranteeExposure: number; rtbFunded: number };
};

export function emptyInputs(): ProFormaInputs {
  return {
    revenue: { display: 0, programmatic: 0, direct: 0, subscriptions: 0, commerce: 0, syndication: 0, other: 0 },
    revShareLines: [...DEFAULT_REV_SHARE_LINES],
    costs: [
      { label: "CMS & hosting", fn: "cms", amount: 0, rtbFundedPct: 1 },
      { label: "Video platform", fn: "video", amount: 0, rtbFundedPct: 1 },
      { label: "Ad serving & ad ops", fn: "ad_ops", amount: 0, rtbFundedPct: 1 },
      { label: "Platform engineering", fn: "engineering", amount: 0, rtbFundedPct: 1 },
      { label: "Membership platform", fn: "membership", amount: 0, rtbFundedPct: 1 },
      { label: "Content & other operations", fn: "other", amount: 0, rtbFundedPct: 0 },
    ],
    smCost: 0,
    smAbsorbPct: 0,
    gaCost: 0,
    gaAbsorbPct: 0,
    revSharePct: 0.5,
    guaranteeType: "profit_floor",
    guaranteeAmount: 0,
    rampMonths: 0,
    termYears: 5,
    growthPct: 0,
  };
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const clamp01 = (v: number) => Math.min(1, Math.max(0, n(v)));
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Normalize possibly partial/untrusted JSON (from the DB) into a complete inputs object. */
export function normalizeInputs(raw: unknown): ProFormaInputs {
  const base = emptyInputs();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<ProFormaInputs>;
  const revenue = { ...base.revenue };
  for (const line of REVENUE_LINES) revenue[line] = Math.max(0, n(r.revenue?.[line]));
  return {
    scenarioLabel: typeof r.scenarioLabel === "string" ? r.scenarioLabel : undefined,
    revenue,
    revShareLines: Array.isArray(r.revShareLines)
      ? r.revShareLines.filter((l): l is RevenueLine => (REVENUE_LINES as readonly string[]).includes(l))
      : base.revShareLines,
    costs: Array.isArray(r.costs)
      ? r.costs.map((c) => ({
          label: String(c?.label ?? "Cost line"),
          fn: (COST_FUNCTIONS as readonly string[]).includes(c?.fn) ? c.fn : "other",
          vendor: c?.vendor ? String(c.vendor) : undefined,
          amount: Math.max(0, n(c?.amount)),
          rtbFundedPct: clamp01(c?.rtbFundedPct),
        }))
      : base.costs,
    smCost: Math.max(0, n(r.smCost)),
    smAbsorbPct: clamp01(n(r.smAbsorbPct)),
    gaCost: Math.max(0, n(r.gaCost)),
    gaAbsorbPct: clamp01(n(r.gaAbsorbPct)),
    revSharePct: clamp01(r.revSharePct ?? base.revSharePct),
    guaranteeType: r.guaranteeType === "fixed_monthly" || r.guaranteeType === "none" ? r.guaranteeType : "profit_floor",
    guaranteeAmount: Math.max(0, n(r.guaranteeAmount)),
    rampMonths: Math.min(24, Math.max(0, Math.round(n(r.rampMonths)))),
    termYears: Math.min(20, Math.max(1, n(r.termYears) || base.termYears)),
    growthPct: Math.min(1, Math.max(-0.5, n(r.growthPct))),
    notes: typeof r.notes === "string" ? r.notes : undefined,
  };
}

export function computeProForma(raw: ProFormaInputs): ProFormaOutputs {
  const i = normalizeInputs(raw);
  const revenueTotal = REVENUE_LINES.reduce((a, l) => a + i.revenue[l], 0);
  const inScopeRevenue = i.revShareLines.reduce((a, l) => a + i.revenue[l], 0);
  const stack = i.costs.reduce((a, c) => a + c.amount, 0);
  const costsBefore = stack + i.smCost + i.gaCost;

  let platformFunded = 0;
  let otherFunded = 0;
  for (const c of i.costs) {
    const funded = c.amount * c.rtbFundedPct;
    if (PLATFORM_FUNCTIONS.includes(c.fn)) platformFunded += funded;
    else otherFunded += funded;
  }
  const smAbsorbed = i.smCost * i.smAbsorbPct;
  const gaAbsorbed = i.gaCost * i.gaAbsorbPct;
  const rtbFundedTotal = platformFunded + otherFunded + smAbsorbed + gaAbsorbed;
  const costsAfter = costsBefore - rtbFundedTotal;

  const clientEbitdaBefore = revenueTotal - costsBefore;
  const clientEbitdaAfter = revenueTotal - costsAfter;
  const uplift = clientEbitdaAfter - clientEbitdaBefore;

  const guaranteeFloorAnnual =
    i.guaranteeType === "profit_floor" ? (i.guaranteeAmount > 0 ? i.guaranteeAmount : Math.max(0, clientEbitdaBefore)) : i.guaranteeType === "fixed_monthly" ? i.guaranteeAmount * 12 : 0;
  const guaranteeMonthly = guaranteeFloorAnnual / 12;

  const years: YearRow[] = [];
  const yearsCount = Math.max(1, Math.ceil(i.termYears));
  for (let y = 1; y <= yearsCount; y++) {
    const growth = Math.pow(1 + i.growthPct, y - 1);
    const inScope = inScopeRevenue * growth;
    const revenue = revenueTotal - inScopeRevenue + inScope;
    const ebitdaBefore = revenue - costsBefore;
    const ebitdaAfter = revenue - costsAfter;
    // Ramp: first `rampMonths` months at 100% to partner (no RTB share).
    const rampInYear = Math.min(12, Math.max(0, i.rampMonths - (y - 1) * 12));
    const shareMonths = 12 - rampInYear;
    // Partial final year when termYears is fractional.
    const yearFraction = y === yearsCount && i.termYears % 1 !== 0 ? i.termYears % 1 : 1;
    const rtbShare = i.revSharePct * inScope * (shareMonths / 12) * yearFraction;
    const clientNet = ebitdaAfter * yearFraction - rtbShare;
    const exposure = guaranteeExposureFor(i.guaranteeType, {
      floorAnnual: guaranteeFloorAnnual * yearFraction,
      clientNet,
      inScopeRevenue: inScope * yearFraction,
      rtbShare,
    });
    years.push({
      year: y,
      revenue: round2(revenue * yearFraction),
      inScopeRevenue: round2(inScope * yearFraction),
      ebitdaBefore: round2(ebitdaBefore * yearFraction),
      ebitdaAfter: round2(ebitdaAfter * yearFraction),
      rtbShare: round2(rtbShare),
      clientNet: round2(clientNet),
      guaranteeExposure: round2(exposure),
      clientNetWithGuarantee: round2(clientNet + exposure),
    });
  }

  // Steady-state (full year, post-ramp, no growth) headline figures.
  const rtbShare = i.revSharePct * inScopeRevenue;
  const clientNetAfterShare = clientEbitdaAfter - rtbShare;
  const guaranteeExposure = guaranteeExposureFor(i.guaranteeType, {
    floorAnnual: guaranteeFloorAnnual,
    clientNet: clientNetAfterShare,
    inScopeRevenue,
    rtbShare,
  });

  return {
    revenueTotal: round2(revenueTotal),
    inScopeRevenue: round2(inScopeRevenue),
    costsBefore: round2(costsBefore),
    costsAfter: round2(costsAfter),
    platformFunded: round2(platformFunded),
    otherFunded: round2(otherFunded),
    smAbsorbed: round2(smAbsorbed),
    gaAbsorbed: round2(gaAbsorbed),
    rtbFundedTotal: round2(rtbFundedTotal),
    clientEbitdaBefore: round2(clientEbitdaBefore),
    clientEbitdaAfter: round2(clientEbitdaAfter),
    marginBefore: revenueTotal > 0 ? clientEbitdaBefore / revenueTotal : 0,
    marginAfter: revenueTotal > 0 ? clientEbitdaAfter / revenueTotal : 0,
    uplift: round2(uplift),
    ebitdaMultiple: clientEbitdaBefore > 0 ? clientEbitdaAfter / clientEbitdaBefore : null,
    rtbShare: round2(rtbShare),
    clientNetAfterShare: round2(clientNetAfterShare),
    clientNetUplift: round2(clientNetAfterShare - clientEbitdaBefore),
    guaranteeFloorAnnual: round2(guaranteeFloorAnnual),
    guaranteeMonthly: round2(guaranteeMonthly),
    guaranteeExposure: round2(guaranteeExposure),
    years,
    totals: {
      rtbShare: round2(years.reduce((a, y) => a + y.rtbShare, 0)),
      clientNet: round2(years.reduce((a, y) => a + y.clientNet, 0)),
      guaranteeExposure: round2(years.reduce((a, y) => a + y.guaranteeExposure, 0)),
      rtbFunded: round2(rtbFundedTotal * Math.min(yearsCount, i.termYears)),
    },
  };
}

/**
 * Shortfall RTB pays under the guarantee.
 * - profit_floor: client's EBITDA after revenue share must not fall below the floor (default = today's EBITDA).
 * - fixed_monthly: client's retained share of in-scope revenue must reach the fixed $/month minimum.
 */
export function guaranteeExposureFor(
  type: GuaranteeType,
  p: { floorAnnual: number; clientNet: number; inScopeRevenue: number; rtbShare: number },
): number {
  if (type === "profit_floor") return Math.max(0, p.floorAnnual - p.clientNet);
  if (type === "fixed_monthly") return Math.max(0, p.floorAnnual - (p.inScopeRevenue - p.rtbShare));
  return 0;
}

/** Compact $000s display used across the builder, lists and print ("$65,850K"). */
export function usdK(usd: number): string {
  const k = Math.round(usd / 1000);
  return `${k < 0 ? "-" : ""}$${Math.abs(k).toLocaleString("en-US")}K`;
}

/* ───────────── Approval rules (PRD PRO-3) ───────────── */

export type ApprovalRules = { minRevSharePct: number; maxGuaranteeMonthlyUsd: number; maxTermYears: number };
export const DEFAULT_APPROVAL_RULES: ApprovalRules = { minRevSharePct: 0.4, maxGuaranteeMonthlyUsd: 250_000, maxTermYears: 10 };

/** Returns the human-readable reasons this proposal needs executive approval (empty = no approval needed). */
export function approvalTriggers(raw: ProFormaInputs, rules: ApprovalRules = DEFAULT_APPROVAL_RULES): string[] {
  const i = normalizeInputs(raw);
  const out = computeProForma(i);
  const reasons: string[] = [];
  if (i.revSharePct < rules.minRevSharePct)
    reasons.push(`Revenue share ${(i.revSharePct * 100).toFixed(1)}% is below the ${(rules.minRevSharePct * 100).toFixed(0)}% floor`);
  if (i.guaranteeType !== "none" && out.guaranteeMonthly > rules.maxGuaranteeMonthlyUsd)
    reasons.push(`Guarantee of $${Math.round(out.guaranteeMonthly).toLocaleString("en-US")}/month exceeds $${rules.maxGuaranteeMonthlyUsd.toLocaleString("en-US")}/month`);
  if (i.termYears > rules.maxTermYears) reasons.push(`Term of ${i.termYears} years exceeds ${rules.maxTermYears} years`);
  return reasons;
}

/** Can this proposal version be exported/sent? Approved or sent, or a draft that needs no approval. */
export function canExport(status: string, triggers: string[]): boolean {
  if (status === "approved" || status === "sent" || status === "locked") return true;
  return status === "draft" && triggers.length === 0;
}

export function isLocked(status: string): boolean {
  return status === "sent" || status === "locked" || status === "approved";
}

/* ───────────── Version diff (PRD PRO-2) ───────────── */

export type InputDiff = { path: string; label: string; before: unknown; after: unknown };

function flatten(value: unknown, prefix: string, out: Record<string, unknown>) {
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v !== "object" || v === null)) {
      out[prefix] = [...value].sort().join(", ");
      return;
    }
    value.forEach((v, idx) => flatten(v, `${prefix}[${idx}]`, out));
    if (value.length === 0) out[prefix] = "";
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out[prefix] = value ?? null;
}

const PATH_LABELS: Record<string, string> = {
  revSharePct: "Revenue share",
  revShareLines: "Revenue share applies to",
  smCost: "S&M cost",
  smAbsorbPct: "S&M absorbed by RTB",
  gaCost: "G&A cost",
  gaAbsorbPct: "G&A absorbed by RTB",
  guaranteeType: "Guarantee type",
  guaranteeAmount: "Guarantee amount",
  rampMonths: "Ramp (months)",
  termYears: "Term (years)",
  growthPct: "Growth per year",
  scenarioLabel: "Scenario",
  notes: "Notes",
};

function labelFor(path: string, inputs: ProFormaInputs): string {
  if (PATH_LABELS[path]) return PATH_LABELS[path]!;
  const rev = path.match(/^revenue\.(\w+)$/);
  if (rev) return `Revenue: ${REVENUE_LINE_LABELS[rev[1] as RevenueLine] ?? rev[1]}`;
  const cost = path.match(/^costs\[(\d+)\]\.(\w+)$/);
  if (cost) {
    const line = inputs.costs[Number(cost[1])];
    const field = { label: "name", fn: "function", vendor: "vendor", amount: "amount", rtbFundedPct: "RTB-funded %" }[cost[2]!] ?? cost[2];
    return `Cost "${line?.label ?? `#${Number(cost[1]) + 1}`}": ${field}`;
  }
  return path;
}

/** Field-level diff between two versions' inputs (normalized first so defaults don't show as changes). */
export function diffInputs(aRaw: unknown, bRaw: unknown): InputDiff[] {
  const a = normalizeInputs(aRaw);
  const b = normalizeInputs(bRaw);
  const fa: Record<string, unknown> = {};
  const fb: Record<string, unknown> = {};
  flatten(a, "", fa);
  flatten(b, "", fb);
  const keys = Array.from(new Set([...Object.keys(fa), ...Object.keys(fb)]));
  const diffs: InputDiff[] = [];
  for (const k of keys) {
    const before = fa[k] ?? null;
    const after = fb[k] ?? null;
    if (before === after) continue;
    if ((before === null || before === "") && (after === null || after === "")) continue;
    diffs.push({ path: k, label: labelFor(k, b.costs.length >= a.costs.length ? b : a), before, after });
  }
  return diffs;
}
