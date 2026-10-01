/**
 * Placeholder detection (pure, unit tested). Works on the paragraph texts of a template's parts and proposes, for
 * each fill-in field, which proposal input it most likely is. Nothing here knows the wording of any real template:
 * suggestions come only from generic label words ("name", "title", "date", "company", …).
 */
import { findAll } from "./substitute";

export const INPUT_KEYS = [
  "recipientName",
  "recipientTitle",
  "companyLegalName",
  "brands",
  "region",
  "letterDate",
  "ndaEffectiveDate",
  "ccLine",
  "signatoryName",
  "signatoryTitle",
] as const;
export type InputKey = (typeof INPUT_KEYS)[number];
/** A mapping target: a standard input, a custom free-text input ("custom:<label>"), or "ignore" (leave as is). */
export type MapTarget = InputKey | `custom:${string}` | "ignore";

export const INPUT_LABELS: Record<InputKey, string> = {
  recipientName: "Recipient name",
  recipientTitle: "Recipient title",
  companyLegalName: "Company / entity legal name",
  brands: "Brand(s)",
  region: "Region / market",
  letterDate: "Letter date",
  ndaEffectiveDate: "NDA effective date",
  ccLine: "CC line",
  signatoryName: "Signatory name",
  signatoryTitle: "Signatory title",
};
export const DATE_INPUTS: InputKey[] = ["letterDate", "ndaEffectiveDate"];

const CUSTOM_RE = /^custom:[A-Za-z0-9][A-Za-z0-9 _./&()-]{0,39}$/;
export function isMapTarget(v: string): v is MapTarget {
  return v === "ignore" || (INPUT_KEYS as readonly string[]).includes(v) || CUSTOM_RE.test(v);
}
export function targetLabel(t: string): string {
  if (t === "ignore") return "Leave as is";
  if (t.startsWith("custom:")) return t.slice(7);
  return INPUT_LABELS[t as InputKey] ?? t;
}

export type CandidateKind = "bracket" | "underscore" | "tabs" | "date" | "custom";
export type Locator = { part: string; ordinal: number; start: number; end: number };
export type Candidate = {
  /** Stable id: "lit:<text>" for literal tokens (all occurrences), "pos:<part>#<ordinal>@<start>" for one position. */
  id: string;
  kind: CandidateKind;
  /** Exact text found in the document (the characters that will be replaced). */
  text: string;
  /** Surrounding words shown to the admin to recognise the field. */
  context: string;
  occurrences: number;
  locators: Locator[];
  suggested: MapTarget;
};

export type PartText = { name: string; paragraphs: { ordinal: number; text: string; fallback?: boolean }[] };

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const MONTHS_ABBR = "Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const MONTH_ANY = `(?:${MONTHS}|${MONTHS_ABBR})`;
export const DATE_RE = new RegExp(
  `\\b(?:${MONTH_ANY}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_ANY}\\.?,?\\s+\\d{4})\\b`,
  "g",
);
const BRACKET_RE = /\[([^[\]\n\t]{1,60})\]/g;
const UNDERSCORE_RE = /_{4,}/g;
// "Label:" followed by tab(s) that end the paragraph or precede another "Label:" → a tab-blank fill-in field.
const TABS_RE = /([A-Za-z][A-Za-z .()'/&-]{0,40}):[  ]*(\t+)(?=[  ]*$|[  ]*[A-Za-z][A-Za-z .()'/&-]{0,40}:)/g;

const MAX_CANDIDATES = 300;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Suggest a mapping from a label/context string using generic words only. */
export function suggestFor(label: string, kind: CandidateKind, paragraphText = ""): MapTarget {
  const l = label.toLowerCase();
  if (kind === "date") return /effective/i.test(paragraphText) ? "ndaEffectiveDate" : "letterDate";
  if (/\b(by|signature|signed|sign here)\b/.test(l) && kind !== "bracket") return "ignore";
  if (/\bcc\b/.test(l)) return "ccLine";
  if (/\b(brand|brands|publication|title of publication|site|website)s?\b/.test(l) && !/job/.test(l)) return "brands";
  if (/\b(region|market|territory|country|jurisdiction)\b/.test(l)) return "region";
  if (/\beffective\b/.test(l)) return "ndaEffectiveDate";
  if (/\bdate\b/.test(l)) return kind === "bracket" ? "letterDate" : "ndaEffectiveDate";
  if (/\b(company|entity|legal name|party|organi[sz]ation|corporation|publisher|partner)\b/.test(l)) return "companyLegalName";
  if (/\b(title|position|role)\b/.test(l)) return kind === "bracket" ? "recipientTitle" : "signatoryTitle";
  if (/\b(name|recipient|dear|attention|attn)\b/.test(l)) return kind === "bracket" ? "recipientName" : "signatoryName";
  return "ignore";
}

/** Detect placeholder candidates across parts (document, headers, footers). */
export function detectPlaceholders(parts: PartText[]): Candidate[] {
  const literal = new Map<string, Candidate>();
  const positional: Candidate[] = [];
  for (const part of parts) {
    const paras = part.paragraphs;
    paras.forEach((p, idx) => {
      if (p.fallback || !p.text.trim()) return;
      const text = p.text;
      // Bracket tokens: grouped by exact text; every occurrence gets the same value.
      for (const m of text.matchAll(BRACKET_RE)) {
        const inner = m[1]!.trim();
        if (!inner || /^\d+(\.\d+)*$/.test(inner)) continue; // [1], [2.3] are references, not fields
        const tok = m[0];
        const at = m.index!;
        const loc = { part: part.name, ordinal: p.ordinal, start: at, end: at + tok.length };
        const cur = literal.get(tok);
        if (cur) {
          cur.occurrences++;
          cur.locators.push(loc);
        } else
          literal.set(tok, {
            id: `lit:${tok}`,
            kind: "bracket",
            text: tok,
            context: clip(squash(text), 140),
            occurrences: 1,
            locators: [loc],
            suggested: suggestFor(inner, "bracket", text),
          });
      }
      // Dates: positional (the same date can mean "letter date" in one place and "effective date" in another).
      for (const m of text.matchAll(DATE_RE)) {
        const at = m.index!;
        positional.push(pos(part.name, p, at, m[0], "date", clip(squash(text), 140), suggestFor("", "date", text)));
      }
      // Underscore blanks: label = text just before (same paragraph) or the neighbouring line (signature blocks).
      for (const m of text.matchAll(UNDERSCORE_RE)) {
        const at = m.index!;
        const before = squash(text.slice(Math.max(0, at - 50), at));
        const after = squash(text.slice(at + m[0].length, at + m[0].length + 40));
        const neighbour = squash(paras[idx + 1]?.text ?? "") || squash(paras[idx - 1]?.text ?? "");
        const label = before || after || neighbour;
        const context = before || after ? `${before} ____ ${after}`.trim() : `____ (next line: ${clip(neighbour, 60)})`;
        positional.push(pos(part.name, p, at, m[0], "underscore", clip(context, 140), suggestFor(lastLabel(before) || label, "underscore", text)));
      }
      for (const m of text.matchAll(TABS_RE)) {
        const tabs = m[2]!;
        const at = m.index! + m[0].length - tabs.length;
        positional.push(pos(part.name, p, at, tabs, "tabs", clip(`${m[1]}: ⇥`, 140), suggestFor(m[1]!, "tabs", text)));
      }
    });
  }
  return [...literal.values(), ...positional].slice(0, MAX_CANDIDATES);
}

function lastLabel(before: string): string {
  const m = /([A-Za-z][A-Za-z .()'/&-]{0,30}):?\s*$/.exec(before);
  return m ? m[1]!.trim() : "";
}

function pos(part: string, p: { ordinal: number }, at: number, text: string, kind: CandidateKind, context: string, suggested: MapTarget): Candidate {
  return {
    id: `pos:${part}#${p.ordinal}@${at}`,
    kind,
    text,
    context,
    occurrences: 1,
    locators: [{ part, ordinal: p.ordinal, start: at, end: at + text.length }],
    suggested,
  };
}

/** A custom literal token the admin typed (e.g. a market phrase). Null when it does not occur in the document. */
export function customCandidate(parts: PartText[], token: string): Candidate | null {
  const tok = token.replace(/\s+/g, " ").trim();
  if (tok.length < 2 || tok.length > 200) return null;
  const locators: Locator[] = [];
  for (const part of parts)
    for (const p of part.paragraphs) {
      if (p.fallback) continue;
      for (const at of findAll(p.text, tok)) locators.push({ part: part.name, ordinal: p.ordinal, start: at, end: at + tok.length });
    }
  if (!locators.length) return null;
  return { id: `lit:${tok}`, kind: "custom", text: tok, context: "Added by an admin", occurrences: locators.length, locators, suggested: "ignore" };
}

/* ───────────── Dates in the template's own style ───────────── */

const MONTH_NAMES = MONTHS.split("|");

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

/** Parse an ISO "yyyy-mm-dd" (no timezone shifting). */
export function parseIsoDate(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/**
 * Format `iso` like `sample` (a date as written in the template): keeps day-first vs month-first, ordinal suffixes,
 * the comma, "of", and abbreviated vs full month names. Falls back to "September 30, 2026" style.
 */
export function formatDateLike(sample: string | null, iso: string): string {
  const p = parseIsoDate(iso);
  if (!p) return iso.trim();
  const full = MONTH_NAMES[p.m - 1]!;
  const s = (sample ?? "").trim();
  const monthFirst = new RegExp(`^(${MONTH_ANY})(\\.?)\\s+\\d{1,2}(st|nd|rd|th)?(,?)\\s+\\d{4}$`, "i").exec(s);
  const dayFirst = new RegExp(`^\\d{1,2}(st|nd|rd|th)?\\s+(of\\s+)?(${MONTH_ANY})(\\.?)(,?)\\s+\\d{4}$`, "i").exec(s);
  const monthText = (written: string, dot: string) => {
    if (written.length > 4 || MONTH_NAMES.some((n) => n.toLowerCase() === written.toLowerCase())) return full;
    const abbr = written.toLowerCase() === "sept" && p.m === 9 ? "Sept" : full.slice(0, 3);
    return `${abbr}${dot}`;
  };
  if (monthFirst) {
    const day = monthFirst[3] ? ordinal(p.d) : String(p.d);
    return `${monthText(monthFirst[1]!, monthFirst[2]!)} ${day}${monthFirst[4]} ${p.y}`;
  }
  if (dayFirst) {
    const day = dayFirst[1] ? ordinal(p.d) : String(p.d);
    return `${day} ${dayFirst[2] ? "of " : ""}${monthText(dayFirst[3]!, dayFirst[4]!)}${dayFirst[5]} ${p.y}`;
  }
  return `${full} ${p.d}, ${p.y}`;
}
