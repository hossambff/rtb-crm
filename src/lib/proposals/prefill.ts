/**
 * A6 "Generate pro forma": prefill the ENT builder from the deal's commercial fields (pure, unit tested).
 * Returns the partial inputs plus a list of what was filled, so the builder can show the rep what to review.
 */
import { dealValue } from "@/lib/pipeline-math";
import type { GuaranteeType, ProFormaInputs } from "./calc";

export type DealPrefillSource = {
  unit: "muu" | "usd" | "activation";
  muu: number | null;
  usdPerMuu: number | null;
  pipelineUsdPerMuu: number | null;
  revSharePct: number | null;
  pipelineRevSharePct: number | null;
  guaranteeType: string | null;
  guaranteeMonthlyCents: number | null;
  rampMonths: number | null;
  termYears: number | null;
  contractValueCents: number | null;
  annualizedValueCents: number | null;
};

export type PrefillItem = { field: string; label: string; value: string };

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** `hidden` = deal fields the user may not see (field-level security); they are never used. */
export function proFormaPrefill(d: DealPrefillSource, hidden: ReadonlySet<string> = new Set()): { inputs: Partial<ProFormaInputs>; filled: PrefillItem[] } {
  const inputs: Partial<ProFormaInputs> = {};
  const filled: PrefillItem[] = [];
  // "*" hides every deal field for the role; otherwise per field (QA A6: MUU, $/MUU, value and ramp were unchecked).
  const ok = (f: string) => !hidden.has("*") && !hidden.has(f);

  // Revenue: the deal's gross value (pipeline-math convention) as the in-scope digital advertising line.
  if (d.unit === "muu" && ok("muu") && (d.muu ?? 0) > 0) {
    // A hidden deal-level $/MUU never leaks into the estimate: fall back to the pipeline default rate.
    const usdPerMuu = ok("usdPerMuu") ? d.usdPerMuu : null;
    const rate = usdPerMuu ?? d.pipelineUsdPerMuu ?? 1;
    const { grossUsd } = dealValue({ unit: "muu", muu: d.muu, usdPerMuu, pipelineUsdPerMuu: d.pipelineUsdPerMuu, stageProbability: 1 });
    if (grossUsd > 0) {
      inputs.revenue = { display: grossUsd, programmatic: 0, direct: 0, subscriptions: 0, commerce: 0, syndication: 0, other: 0 };
      inputs.scenarioLabel = `From deal: ${Math.round(d.muu!).toLocaleString("en-US")} MUU × $${rate}/MUU (estimate)`;
      filled.push({ field: "revenue.display", label: "Display advertising", value: `${usd(grossUsd)} (MUU × $/MUU, replace with the client's P&L)` });
    }
  } else if (d.unit === "usd") {
    const cents = (ok("annualizedValueCents") ? d.annualizedValueCents : null) ?? (ok("contractValueCents") ? d.contractValueCents : null);
    if (cents && cents > 0) {
      inputs.revenue = { display: cents / 100, programmatic: 0, direct: 0, subscriptions: 0, commerce: 0, syndication: 0, other: 0 };
      filled.push({ field: "revenue.display", label: "Display advertising", value: `${usd(cents / 100)} (deal value)` });
    }
  }

  if (ok("revSharePct")) {
    const share = d.revSharePct ?? d.pipelineRevSharePct;
    if (share != null && Number.isFinite(share)) {
      inputs.revSharePct = Math.min(1, Math.max(0, share));
      filled.push({ field: "revSharePct", label: "Revenue share", value: `${Math.round(inputs.revSharePct * 1000) / 10}%${d.revSharePct == null ? " (pipeline default)" : ""}` });
    }
  }
  if (ok("guaranteeType") && (d.guaranteeType === "fixed_monthly" || d.guaranteeType === "profit_floor" || d.guaranteeType === "none")) {
    inputs.guaranteeType = d.guaranteeType as GuaranteeType;
    const names = { fixed_monthly: "Fixed $/month", profit_floor: "Profit floor", none: "None" } as const;
    let value: string = names[d.guaranteeType];
    if (d.guaranteeType === "fixed_monthly" && ok("guaranteeMonthlyCents") && d.guaranteeMonthlyCents != null) {
      inputs.guaranteeAmount = d.guaranteeMonthlyCents / 100;
      value += ` · ${usd(inputs.guaranteeAmount)}/month`;
    }
    filled.push({ field: "guaranteeType", label: "Guarantee", value });
  }
  if (ok("rampMonths") && d.rampMonths != null && d.rampMonths >= 0) {
    inputs.rampMonths = Math.min(24, Math.round(d.rampMonths));
    filled.push({ field: "rampMonths", label: "Ramp", value: `${inputs.rampMonths} months` });
  }
  if (ok("termYears") && d.termYears != null && d.termYears >= 1) {
    inputs.termYears = Math.min(20, d.termYears);
    filled.push({ field: "termYears", label: "Term", value: `${inputs.termYears} years` });
  }
  return { inputs, filled };
}
