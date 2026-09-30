/**
 * Status → stage normalization (PRD IMP-3, Appendix A). Pure.
 * Stages carry admin-editable `importAliases`; matching is case-insensitive and whitespace/punctuation tolerant.
 * Values that are not statuses (dates, emails, URLs, free-text notes) are classified and routed to notes /
 * last-contacted instead of becoming a stage.
 */
import { classifyStatusValue } from "../domain";
import { cellText, parseLooseDate } from "./cells";

export type StageLite = {
  id?: string;
  key: string;
  name: string;
  sortOrder: number;
  probability: number;
  category: "open" | "won" | "lost" | "hold";
  importAliases: string[];
};

export type StatusMatch =
  | { kind: "stage"; stageKey: string; raw: string; date: Date | null }
  | { kind: "date"; raw: string; date: Date | null }
  | { kind: "email" | "url" | "note"; raw: string }
  | { kind: "unmapped"; raw: string }
  | { kind: "empty" };

export function normStatus(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/[^a-z0-9%/ -]+/g, " ")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extra phrasings seen in the RTB spreadsheets, mapped to a canonical alias (then resolved via importAliases). */
const PHRASES: [RegExp, string][] = [
  [/^(followed up|follow ?up|follow-up|bumped)/, "outreach"],
  [/^(outreach|reached out|emailed|sent email|first campaign email sent|updated campaign email sent|forwarded)/, "outreach"],
  [/^verbal/, "verbal"],
  [/^signed loi/, "signed loi"],
  [/^cold/, "cold"],
  [/^relationship already/, "relationship already"],
  [/^warm deal/, "warm deal"],
  [/^warming/, "warming up"],
  [/^call (set|done|scheduled)/, "call set"],
  [/^(rejected|rejection|declined)/, "rejected"],
  [/^(positive response|referred us)/, "in comms"],
];

/** Build a matcher for one pipeline's stages. */
export function createStageMatcher(stages: StageLite[]) {
  const alias = new Map<string, string>();
  for (const st of stages) {
    alias.set(normStatus(st.key.replace(/_/g, " ")), st.key);
    alias.set(normStatus(st.name), st.key);
  }
  // explicit aliases win over names/keys
  for (const st of stages) for (const a of st.importAliases) alias.set(normStatus(a), st.key);

  const resolve = (s: string): string | null => {
    const n = normStatus(s);
    if (alias.has(n)) return alias.get(n)!;
    for (const [re, canon] of PHRASES) if (re.test(n) && alias.has(canon)) return alias.get(canon)!;
    return null;
  };

  return function match(raw: unknown): StatusMatch {
    if (raw instanceof Date) return { kind: "date", raw: raw.toISOString().slice(0, 10), date: raw };
    const s = cellText(raw);
    if (!s) return { kind: "empty" };
    const direct = resolve(s);
    if (direct) return { kind: "stage", stageKey: direct, raw: s, date: null };
    // "7/29 Outreach", "8/4 Follow up", "Forwarded 8/12" → stage + date
    const dated = s.match(/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.+)$/) ?? s.match(/^(.+?)\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/);
    if (dated) {
      const [datePart, rest] = /\d/.test(dated[1]![0]!) ? [dated[1]!, dated[2]!] : [dated[2]!, dated[1]!];
      const key = resolve(rest);
      if (key) return { kind: "stage", stageKey: key, raw: s, date: parseLooseDate(datePart) };
    }
    const cls = classifyStatusValue(s);
    if (cls === "date") return { kind: "date", raw: s, date: parseLooseDate(s) };
    if (cls === "email" || cls === "url" || cls === "note") return { kind: cls, raw: s };
    if (cls === "empty") return { kind: "empty" };
    return { kind: "unmapped", raw: s };
  };
}

/** v7 tier column (1 / 0.9 / 0.5 / 0.1) → MUU-pipeline stage key. */
export function tierToStageKey(tier: unknown): string | null {
  const n = typeof tier === "number" ? tier : Number(cellText(tier)?.replace(/%/g, ""));
  if (!Number.isFinite(n)) return null;
  const p = n > 1 ? n / 100 : n;
  if (p >= 0.99) return "contract";
  if (p >= 0.85) return "hot";
  if (p >= 0.45) return "in_comms";
  if (p > 0) return "target";
  return null;
}

/**
 * Advancement rank for "keep the most advanced stage" merges.
 * Won beats everything; open/hold ordered by probability then pipeline order; lost is lowest.
 */
export function stageRank(st: Pick<StageLite, "category" | "probability" | "sortOrder">): number {
  if (st.category === "won") return 10_000 + st.sortOrder;
  if (st.category === "lost") return -1;
  return Math.round(st.probability * 1000) + st.sortOrder;
}

export function moreAdvanced<T extends Pick<StageLite, "category" | "probability" | "sortOrder">>(a: T, b: T): T {
  return stageRank(b) > stageRank(a) ? b : a;
}

export function dealStatusFor(category: StageLite["category"]): "open" | "won" | "lost" | "hold" {
  return category;
}
