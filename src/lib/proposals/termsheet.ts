/**
 * Coalition term sheet (NET) — pure domain logic shared by the form (client), preview, generation and actions.
 * No template wording or numbers live here: placeholders, tiers and approval flags all come from the admin-reviewed
 * template row (proposal_templates).
 */
import { dealValue } from "@/lib/pipeline-math";
import { DATE_INPUTS, formatDateLike, INPUT_KEYS, isMapTarget, targetLabel, type Candidate, type InputKey } from "./docx/detect";
import type { Rule } from "./docx/substitute";
import { bandText, lookupTier, type Tier, type TierTable } from "./docx/tiers";

export const TERM_SHEET_KIND = "coalition_term_sheet";
export const TEMPLATE_KINDS = [{ kind: TERM_SHEET_KIND, label: "Coalition term sheet (Network Development)" }] as const;

export type FieldMapEntry = { token: string; input: string; occurrences: number };
export type TemplateApproval = { tierChange: boolean; fields: InputKey[] };
export type TemplateParsed = {
  candidates?: Candidate[];
  tierTables?: TierTable[];
  tiers?: Tier[];
  tierTableIndex?: number | null;
  tiersReviewed?: boolean;
  /** An admin saved (reviewed) the placeholder → field mapping. Required before the template can go live (QA MAJ-19). */
  mappingReviewed?: boolean;
  approval?: TemplateApproval;
  parts?: string[];
  stats?: { paragraphs: number; tables: number; bytes: number };
};

/** The subset of a template row the term sheet logic needs (never the file itself). */
export type TemplateInfo = { id: string; version: number; name: string; sha256: string; fieldMap: FieldMapEntry[]; parsed: TemplateParsed };

export type TermSheetInputs = {
  templateId: string;
  templateVersion: number;
  templateSha256: string;
  values: Record<string, string>;
  /** Values as prefilled from the deal when the version was created (approval comparisons). */
  prefill: Record<string, string>;
  muu: number | null;
  usdPerMuu: number;
  /** Explicit tier chosen by the rep; null = the tier the MUU falls in. */
  tierIndex: number | null;
  notes?: string;
  /**
   * The template mapping this version was generated with (mapped candidates, field map, reviewed tiers, approval
   * flags). Frozen with the version, so later admin edits to the template never change a sent document.
   */
  snapshot: TemplateSnapshot;
};

export type TemplateSnapshot = { candidates: Candidate[]; fieldMap: FieldMapEntry[]; tiers: Tier[]; approval: TemplateApproval };

/** Snapshot of a template's mapping (only mapped candidates are kept). */
/**
 * Why a template can't be activated / used to generate term sheets yet (QA MAJ-19). A freshly uploaded template is a
 * draft: an admin must review and save the field mapping and — when the document has a revenue-share table — the
 * tiers (columns may have been guessed or swapped). Empty = ready. Pure.
 */
export function templateReviewBlockers(t: { fieldMap: FieldMapEntry[]; parsed: TemplateParsed }): string[] {
  const out: string[] = [];
  if (!t.fieldMap.some((f) => f.input !== "ignore" && isMapTarget(f.input))) out.push("Map at least one placeholder to a field.");
  else if (!t.parsed.mappingReviewed) out.push("Review the field mapping and save it.");
  const hasTiers = (t.parsed.tierTables?.length ?? 0) > 0 || (t.parsed.tiers?.length ?? 0) > 0;
  if (hasTiers && !t.parsed.tiersReviewed) out.push("Review the revenue-share tiers (partner vs RTB columns) and save them.");
  return out;
}

export function snapshotOf(t: Pick<TemplateInfo, "fieldMap" | "parsed">): TemplateSnapshot {
  const fieldMap = t.fieldMap.filter((f) => f.input !== "ignore" && isMapTarget(f.input));
  const used = new Set(fieldMap.map((f) => f.token));
  return {
    candidates: (t.parsed.candidates ?? []).filter((c) => used.has(c.id)),
    fieldMap,
    tiers: t.parsed.tiers ?? [],
    approval: normalizeApproval(t.parsed.approval),
  };
}

function normalizeSnapshot(raw: unknown): TemplateSnapshot {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<TemplateSnapshot>;
  return {
    candidates: Array.isArray(r.candidates) ? r.candidates.filter((c) => c && typeof c.id === "string" && typeof c.text === "string" && Array.isArray(c.locators)) : [],
    fieldMap: Array.isArray(r.fieldMap) ? r.fieldMap.filter((f) => f && typeof f.token === "string" && typeof f.input === "string") : [],
    tiers: Array.isArray(r.tiers) ? r.tiers.filter((t) => t && typeof t.partnerPct === "number" && typeof t.rtbPct === "number") : [],
    approval: normalizeApproval(r.approval),
  };
}

export type TermSheetEconomics = {
  muu: number | null;
  usdPerMuu: number;
  impliedTierIndex: number | null;
  tierIndex: number | null;
  tier: (Tier & { band: string }) | null;
  overridden: boolean;
  grossUsd: number;
  partnerUsd: number | null;
  rtbUsd: number | null;
};

const MAX_VALUE = 300;

/** Clean one free-text value: single line, no control characters, bounded. */
export function cleanValue(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_VALUE);
}

/** Inputs the active template actually uses (mapped targets), standard keys first in canonical order. */
export function usedTargets(fieldMap: FieldMapEntry[]): string[] {
  const set = new Set(fieldMap.map((f) => f.input).filter((t) => t !== "ignore" && isMapTarget(t)));
  const std = INPUT_KEYS.filter((k) => set.has(k));
  const custom = [...set].filter((t) => t.startsWith("custom:")).sort();
  return [...std, ...custom];
}

export function normalizeTermSheetInputs(raw: unknown): TermSheetInputs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<TermSheetInputs>;
  const values: Record<string, string> = {};
  const prefill: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.values ?? {})) if (isMapTarget(k) && k !== "ignore") values[k] = cleanValue(v);
  for (const [k, v] of Object.entries(r.prefill ?? {})) if (isMapTarget(k) && k !== "ignore") prefill[k] = cleanValue(v);
  const muu = typeof r.muu === "number" && Number.isFinite(r.muu) && r.muu >= 0 ? Math.round(r.muu) : null;
  const usdPerMuu = typeof r.usdPerMuu === "number" && Number.isFinite(r.usdPerMuu) && r.usdPerMuu >= 0 ? r.usdPerMuu : 1;
  const tierIndex = typeof r.tierIndex === "number" && Number.isInteger(r.tierIndex) && r.tierIndex >= 0 ? r.tierIndex : null;
  return {
    templateId: String(r.templateId ?? ""),
    templateVersion: Number(r.templateVersion ?? 0) || 0,
    templateSha256: String(r.templateSha256 ?? ""),
    values,
    prefill,
    muu,
    usdPerMuu,
    tierIndex,
    notes: typeof r.notes === "string" ? r.notes.slice(0, 2000) : undefined,
    snapshot: normalizeSnapshot(r.snapshot),
  };
}

/** Partner economics: tier for the MUU (or the chosen one), and illustrative annual figures (pipeline-math gross). */
export function termSheetEconomics(i: Pick<TermSheetInputs, "muu" | "usdPerMuu" | "tierIndex">, tiers: Tier[]): TermSheetEconomics {
  const implied = lookupTier(tiers, i.muu);
  const chosen = i.tierIndex !== null && i.tierIndex < tiers.length ? i.tierIndex : implied;
  const tier = chosen !== null ? tiers[chosen]! : null;
  const { grossUsd } = dealValue({ unit: "muu", muu: i.muu ?? 0, usdPerMuu: i.usdPerMuu, stageProbability: 1 });
  return {
    muu: i.muu,
    usdPerMuu: i.usdPerMuu,
    impliedTierIndex: implied,
    tierIndex: chosen,
    tier: tier ? { ...tier, band: tier.label || bandText(tier) } : null,
    overridden: chosen !== null && chosen !== implied,
    grossUsd,
    partnerUsd: tier ? (grossUsd * tier.partnerPct) / 100 : null,
    rtbUsd: tier ? (grossUsd * tier.rtbPct) / 100 : null,
  };
}

/** Why this version needs approval (admin-flagged fields changed from the prefill; tier changed from the MUU's tier). */
export function termSheetApprovalReasons(i: TermSheetInputs, approval: TemplateApproval | undefined, tiers: Tier[]): string[] {
  if (!approval) return [];
  const reasons: string[] = [];
  if (approval.tierChange) {
    const e = termSheetEconomics(i, tiers);
    if (e.overridden) {
      const from = e.impliedTierIndex !== null ? tiers[e.impliedTierIndex]!.label : "no tier";
      reasons.push(`Revenue-share tier changed from ${from} to ${e.tier?.label ?? "?"}`);
    }
  }
  for (const f of approval.fields) {
    const now = i.values[f] ?? "";
    const was = i.prefill[f] ?? "";
    if (now !== was) reasons.push(`${targetLabel(f)} changed from the deal's value`);
  }
  return reasons;
}

/** The text that replaces a candidate for a given target (dates are formatted like the template writes them). */
export function renderValue(target: string, value: string, cand: Pick<Candidate, "kind" | "text">): string {
  const v = (DATE_INPUTS as string[]).includes(target) ? formatDateLike(cand.kind === "date" ? cand.text : null, value) : value;
  // A tab blank sits right after "Label:" — keep a space between the label and the value.
  return cand.kind === "tabs" ? ` ${v}` : v;
}

/** Build substitution rules from the template's candidates + admin field map + the rep's values. Empty values are skipped. */
export function buildRules(candidates: Candidate[], fieldMap: FieldMapEntry[], values: Record<string, string>): { rules: Rule[]; unfilled: { token: string; target: string }[] } {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const rules: Rule[] = [];
  const unfilled: { token: string; target: string }[] = [];
  for (const f of fieldMap) {
    const c = byId.get(f.token);
    if (!c || f.input === "ignore" || !isMapTarget(f.input)) continue;
    const raw = cleanValue(values[f.input]);
    if (!raw) {
      unfilled.push({ token: c.text, target: f.input });
      continue;
    }
    const value = renderValue(f.input, raw, c);
    if (c.id.startsWith("lit:")) rules.push({ type: "literal", find: c.text, value, key: f.input });
    else
      for (const l of c.locators)
        rules.push({ type: "positional", part: l.part, ordinal: l.ordinal, start: l.start, end: l.end, expect: c.text, value, key: f.input });
  }
  return { rules, unfilled };
}

/** Sanitize the template's approval flags. */
export function normalizeApproval(raw: unknown): TemplateApproval {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<TemplateApproval>;
  return { tierChange: Boolean(r.tierChange), fields: Array.isArray(r.fields) ? r.fields.filter((f): f is InputKey => (INPUT_KEYS as readonly string[]).includes(f)) : [] };
}

/** Status handling (draft → [pending_approval → approved] → sent → signed). */
export function termSheetLocked(status: string): boolean {
  return status === "sent" || status === "signed" || status === "approved" || status === "locked";
}
export function termSheetExportable(status: string, reasons: string[]): boolean {
  if (status === "approved" || status === "sent" || status === "signed" || status === "locked") return true;
  return status === "draft" && reasons.length === 0;
}

/** For each date target, how the template writes its first mapped date (used to preview the formatted value). */
export function dateSamples(candidates: Candidate[], fieldMap: FieldMapEntry[]): Record<string, string | null> {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: Record<string, string | null> = {};
  for (const f of fieldMap) {
    if (!(DATE_INPUTS as string[]).includes(f.input) || out[f.input]) continue;
    const c = byId.get(f.token);
    out[f.input] = c?.kind === "date" ? c.text : null;
  }
  return out;
}
