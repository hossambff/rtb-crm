/**
 * Four-field deal creation + auto-fill (V2 §B4/B5) — pure, client-safe, unit tested.
 * The rep gives account, motion, value and a next step; the system fills priority, expected close, primary contact and
 * source, and remembers what it filled (customFields.__autofill) so the deal page can mark it "auto" and undo it.
 */
import { businessDateInput } from "@/lib/playbooks/core";
import type { Priority, StageDTO } from "./types";

export const AUTOFILL_KEY = "__autofill";
export const AUTOFILL_FIELDS = ["priority", "expectedCloseDate", "primaryContactId", "source"] as const;
export type AutofillField = (typeof AUTOFILL_FIELDS)[number];
export type AutofillEntry = { value: string; label: string; reason: string; engine: string; at: string };
export type Autofill = Partial<Record<AutofillField, AutofillEntry>>;

/** Default next-step due date: +3 business days in the user's zone (YYYY-MM-DD for <input type="date">). */
export const DEFAULT_NEXT_STEP_DAYS = 3;
export function defaultNextStepDue(now: Date, tz: string): string {
  return businessDateInput(now, DEFAULT_NEXT_STEP_DAYS, tz);
}

/** Read the auto-fill markers from a deal's customFields (defensive against hand-edited JSON). */
export function readAutofill(customFields: Record<string, unknown> | null | undefined): Autofill {
  const raw = customFields?.[AUTOFILL_KEY];
  if (!raw || typeof raw !== "object") return {};
  const out: Autofill = {};
  for (const f of AUTOFILL_FIELDS) {
    const e = (raw as Record<string, unknown>)[f] as Partial<AutofillEntry> | undefined;
    if (e && typeof e.value === "string") out[f] = { value: e.value, label: String(e.label ?? e.value), reason: String(e.reason ?? ""), engine: String(e.engine ?? "heuristic"), at: String(e.at ?? "") };
  }
  return out;
}

/** customFields with the given auto-fill markers removed (the whole key goes when empty). */
export function withoutAutofill(customFields: Record<string, unknown> | null | undefined, fields: readonly string[]): Record<string, unknown> {
  const cf = { ...(customFields ?? {}) };
  const cur = readAutofill(cf);
  for (const f of fields) delete (cur as Record<string, unknown>)[f];
  if (Object.keys(cur).length) cf[AUTOFILL_KEY] = cur;
  else delete cf[AUTOFILL_KEY];
  return cf;
}

/* ───────────── Suggestions ───────────── */

export type Suggestion<T> = { value: T; label: string; reason: string } | null;

const PRIORITY_LABEL: Record<Priority, string> = { top10: "Top 10", high: "High", medium: "Medium", low: "Low" };

/**
 * Priority from the account's own priority (the Top-10 list lives there), else from size: MUU ≥ 10M → Top 10 (PRD
 * Appendix C), ≥ 2M high, ≥ 250k medium, else low; $ motions by contract value; R100 by market cap.
 */
export function suggestPriority(i: {
  accountPriority: Priority | null;
  unit: "muu" | "usd" | "activation";
  muu: number | null;
  contractValueCents: number | null;
  marketCapUsd: number | null;
}): Suggestion<Priority> {
  const mk = (p: Priority, reason: string) => ({ value: p, label: PRIORITY_LABEL[p], reason });
  if (i.accountPriority) return mk(i.accountPriority, `Account is marked ${PRIORITY_LABEL[i.accountPriority]}`);
  if (i.unit === "muu" && i.muu && i.muu > 0) {
    const m = i.muu;
    const band = m >= 10_000_000 ? "top10" : m >= 2_000_000 ? "high" : m >= 250_000 ? "medium" : "low";
    return mk(band, `${fmtCompact(m)} MUU`);
  }
  if (i.unit === "usd" && i.contractValueCents && i.contractValueCents > 0) {
    const usd = i.contractValueCents / 100;
    const band = usd >= 250_000 ? "top10" : usd >= 100_000 ? "high" : usd >= 25_000 ? "medium" : "low";
    return mk(band, `$${fmtCompact(usd)} contract value`);
  }
  if (i.unit === "activation" && i.marketCapUsd && i.marketCapUsd > 0) {
    const band = i.marketCapUsd >= 10_000_000_000 ? "high" : i.marketCapUsd >= 1_000_000_000 ? "medium" : "low";
    return mk(band, `$${fmtCompact(i.marketCapUsd)} market cap`);
  }
  return null;
}

/**
 * Expected close = today + the SLA days of the current stage and every later open stage up to the first won stage
 * (parking lots like Cold / Nurture are skipped). Null when the pipeline has no SLAs.
 */
export function expectedCloseFromSla(stages: Pick<StageDTO, "id" | "key" | "sortOrder" | "category" | "slaDays">[], currentStageId: string, now: Date): Suggestion<Date> {
  const sorted = [...stages].sort((a, b) => a.sortOrder - b.sortOrder);
  const idx = sorted.findIndex((s) => s.id === currentStageId);
  if (idx < 0) return null;
  let days = 0;
  let steps = 0;
  for (const st of sorted.slice(idx)) {
    if (st.category === "won") break;
    if (st.category !== "open" || /cold|nurture/i.test(st.key)) continue;
    days += st.slaDays ?? 0;
    steps++;
  }
  if (days <= 0) return null;
  const d = new Date(now.getTime() + days * 86_400_000);
  return { value: d, label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }), reason: `Stage SLAs: ${steps} stage${steps === 1 ? "" : "s"}, ${days} days to close` };
}

export type ContactCandidate = { id: string; name: string; title: string | null; lastContactedAt: Date | string | null; lastEmailAt?: Date | string | null; status?: string | null; doNotContact?: boolean };

const SENIOR = /\b(ceo|chief|founder|co-?founder|owner|publisher|president|managing director|general manager|editor[- ]in[- ]chief|partner)\b/i;
const MID = /\b(vp|vice president|head|director|svp|evp|cro|cmo|cfo|coo|cto)\b/i;

/** Seniority × recency score: the most senior person we've recently talked to wins. */
export function contactScore(c: ContactCandidate, now: Date): number {
  if (c.status === "left_company" || c.doNotContact) return -1;
  let score = 0;
  if (c.title && SENIOR.test(c.title)) score += 3;
  else if (c.title && MID.test(c.title)) score += 2;
  const latest = [c.lastEmailAt, c.lastContactedAt].map((d) => (d ? new Date(d).getTime() : 0)).reduce((a, b) => Math.max(a, b), 0);
  if (latest) {
    const days = (now.getTime() - latest) / 86_400_000;
    score += days <= 14 ? 4 : days <= 60 ? 2 : days <= 180 ? 1 : 0;
  }
  return score;
}

export function pickPrimaryContact(candidates: ContactCandidate[], now: Date): Suggestion<string> {
  const usable = candidates.filter((c) => contactScore(c, now) >= 0);
  if (!usable.length) return null;
  const ranked = usable.map((c) => ({ c, score: contactScore(c, now) })).sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  const top = ranked[0]!;
  const recent = top.c.lastEmailAt || top.c.lastContactedAt;
  const reason =
    usable.length === 1
      ? "Only contact on the account"
      : [top.c.title ? top.c.title : null, recent ? "recent email" : null].filter(Boolean).join(" · ") || "Best match on the account";
  return { value: top.c.id, label: top.c.name, reason };
}

/** Source from how the account came in; only values that exist in the source picklist are suggested. */
export function suggestSource(i: { accountSource: string | null; inboundEmail: boolean; role: string; picklist: string[] }): Suggestion<string> {
  const has = (v: string) => i.picklist.find((p) => p.toLowerCase() === v.toLowerCase()) ?? null;
  const pick = (v: string, reason: string) => {
    const value = has(v);
    return value ? { value, label: value, reason } : null;
  };
  const src = (i.accountSource ?? "").toLowerCase();
  if (src.includes("scout")) return pick("Lead Scout", "Account came from Lead Scout");
  if (src.includes("import")) return pick("Import", "Account was imported");
  if (i.inboundEmail) return pick("Inbound", "They emailed us first");
  if (i.role === "commission_rep") return pick("Commission registration", "Registered by a commission rep");
  return pick("Outbound", "Rep-sourced");
}

function fmtCompact(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}
