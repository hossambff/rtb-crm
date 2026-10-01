/**
 * Stage gates (PRD DEAL-2, DEAL-3, DEAL-7, KAN-1). Pure + client-safe: the board uses it to decide whether a drop
 * needs the gate dialog; the server re-evaluates with the same functions before writing.
 */
import type { StageCategory } from "./types";
import { DEFAULT_TZ, parseUserDate } from "@/lib/time";

export type GateFieldKind = "number" | "usd" | "percent" | "date" | "text" | "contact";

/** Known deal columns that admins can list in stages.required_fields. Unknown keys are treated as custom fields. */
export const GATE_FIELDS: Record<string, { label: string; kind: GateFieldKind; help?: string }> = {
  muu: { label: "MUU (monthly unique users)", kind: "number" },
  usdPerMuu: { label: "$ per MUU (annual)", kind: "number" },
  revSharePct: { label: "RTB revenue share %", kind: "percent" },
  contractValueCents: { label: "Contract value", kind: "usd" },
  annualizedValueCents: { label: "Annualized value", kind: "usd" },
  nextPaymentCents: { label: "Next payment amount", kind: "usd" },
  nextPaymentAt: { label: "Next payment date", kind: "date" },
  renewalAt: { label: "Renewal date", kind: "date" },
  expectedCloseDate: { label: "Expected close date", kind: "date" },
  primaryContactId: { label: "Primary contact", kind: "contact" },
  guaranteeType: { label: "Guarantee type", kind: "text" },
  guaranteeMonthlyCents: { label: "Guarantee per month", kind: "usd" },
  rampMonths: { label: "Ramp (months)", kind: "number" },
  termYears: { label: "Contract term (years)", kind: "number" },
  nextStep: { label: "Next step", kind: "text" },
  nextStepDueAt: { label: "Next step due", kind: "date" },
};

export function gateFieldMeta(key: string) {
  return GATE_FIELDS[key] ?? { label: humanize(key), kind: "text" as const };
}

function humanize(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

/** Fields a deal must have to *enter* a stage. Open stages always need a next step + due date (DEAL-3). */
export function requiredForStage(stage: { requiredFields: string[]; category: StageCategory }): string[] {
  const req = [...stage.requiredFields];
  if (stage.category === "open") {
    if (!req.includes("nextStep")) req.push("nextStep");
    if (!req.includes("nextStepDueAt")) req.push("nextStepDueAt");
  }
  return req;
}

export function missingFields(stage: { requiredFields: string[]; category: StageCategory }, filled: Iterable<string>): string[] {
  const have = new Set(filled);
  return requiredForStage(stage).filter((k) => !have.has(k));
}

/** Won / Lost / Hold transitions require a reason (DEAL-7). */
export function needsReason(category: StageCategory): boolean {
  return category !== "open";
}

export function reasonPicklist(category: StageCategory): "lost_reason" | "hold_reason" | null {
  return category === "lost" ? "lost_reason" : category === "hold" ? "hold_reason" : null;
}

export function isFilledValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return Number.isFinite(v) && v > 0;
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Which gate keys are filled on a deal row (+ its custom fields). Numbers must be > 0 to count as filled. */
export function filledKeys(deal: Record<string, unknown> & { customFields?: Record<string, unknown> | null }, extraKeys: string[] = []): string[] {
  const out: string[] = [];
  for (const k of Object.keys(GATE_FIELDS)) if (isFilledValue(deal[k])) out.push(k);
  for (const k of extraKeys) {
    if (k in GATE_FIELDS) continue;
    if (isFilledValue(deal[k]) || isFilledValue(deal.customFields?.[k])) out.push(k);
  }
  return out;
}

/**
 * Parse a raw gate-dialog value into the DB representation.
 * usd → cents (input in dollars), percent → 0..1 (input 0..100), number → number, date → Date, text/contact → string.
 * Returns undefined when the value is empty/invalid.
 */
/** `tz` = the user's zone: a date-only value is stored as 17:00 local that day (src/lib/time.ts, M-06). */
export function parseGateValue(kind: GateFieldKind, raw: unknown, tz = DEFAULT_TZ): number | string | Date | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  switch (kind) {
    case "number": {
      const n = Number(s.replace(/[,_\s]/g, ""));
      return Number.isFinite(n) && n > 0 ? n : undefined;
    }
    case "usd": {
      const n = Number(s.replace(/[$,_\s]/g, ""));
      return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : undefined;
    }
    case "percent": {
      const n = Number(s.replace(/[%\s]/g, ""));
      return Number.isFinite(n) && n > 0 && n <= 100 ? n / 100 : undefined;
    }
    case "date":
      return parseUserDate(s, tz) ?? undefined;
    default:
      return s;
  }
}

/**
 * V2 §B5 (QA MAJ-07): moving into an OPEN stage always asks "what's next?" — prefilled — unless the role can't edit the
 * next step (then the server keeps the current one and the gate decides). Closed stages use the reason dialog instead.
 */
export function shouldPromptNextStep(stage: { category: StageCategory }, hiddenFields: readonly string[]): boolean {
  return stage.category === "open" && !hiddenFields.includes("nextStep") && !hiddenFields.includes("nextStepDueAt") && !hiddenFields.includes("*");
}

/**
 * Prefill for the next-step prompt: the target stage's playbook suggestion when it differs from the current next step
 * (so "Book intro call" doesn't survive into Contract), else the current next step. `alternative` is the other value,
 * offered as a one-click swap in the dialog.
 */
export function nextStepPrefill(current: string | null | undefined, hint: { title: string; dueInDays: number } | null | undefined): { value: string; fromPlaybook: boolean; alternative: string | null } {
  const cur = current?.trim() || "";
  const sug = hint?.title.trim() || "";
  if (sug && sug.toLowerCase() !== cur.toLowerCase()) return { value: sug, fromPlaybook: true, alternative: cur || null };
  return { value: cur || sug, fromPlaybook: !cur && !!sug, alternative: null };
}
