/**
 * Canonical deal value math (PRD DEAL-4/5). Pure — shared by boards, analytics, forecasts, Copilot.
 * - MUU motions (unit "muu"): gross = MUU × $/MUU (annual), net = gross × revSharePct.
 * - $ motions (unit "usd"): gross = annualized value (fallback contract value), net = gross.
 * - Activation motions (R100): value = 1 live account; money = 0.
 * probability = override (if approved) else stage probability.
 */
export type DealValueInput = {
  unit: "muu" | "usd" | "activation";
  muu?: number | null;
  usdPerMuu?: number | null; // deal-level override
  pipelineUsdPerMuu?: number | null;
  revSharePct?: number | null; // 0..1
  pipelineRevSharePct?: number | null;
  contractValueCents?: number | null;
  annualizedValueCents?: number | null;
  stageProbability: number; // 0..1
  probabilityOverride?: number | null;
  overrideStatus?: string | null;
};

export type DealValue = {
  probability: number;
  overridden: boolean;
  muu: number;
  grossUsd: number;
  netUsd: number;
  weightedGrossUsd: number;
  weightedNetUsd: number;
  weightedMuu: number;
};

export function dealValue(d: DealValueInput): DealValue {
  const overridden = d.probabilityOverride != null && (d.overrideStatus == null || d.overrideStatus === "approved");
  const probability = clamp01(overridden ? d.probabilityOverride! : d.stageProbability);
  let grossUsd = 0;
  let netUsd = 0;
  const muu = Math.max(0, d.muu ?? 0);
  if (d.unit === "muu") {
    const rate = d.usdPerMuu ?? d.pipelineUsdPerMuu ?? 1;
    grossUsd = muu * rate;
    const share = d.revSharePct ?? d.pipelineRevSharePct ?? 0.5;
    netUsd = grossUsd * clamp01(share);
  } else if (d.unit === "usd") {
    grossUsd = ((d.annualizedValueCents ?? d.contractValueCents ?? 0) as number) / 100;
    netUsd = grossUsd;
  }
  return {
    probability,
    overridden,
    muu,
    grossUsd,
    netUsd,
    weightedGrossUsd: grossUsd * probability,
    weightedNetUsd: netUsd * probability,
    weightedMuu: muu * probability,
  };
}

function clamp01(n: number) {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}
