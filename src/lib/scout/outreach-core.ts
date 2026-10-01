/**
 * Lead Scout → outreach (V2 §A3), pure core: personal opener heuristics, the AI prompt (site data wrapped as
 * untrusted), and output sanitizing. Unit-tested; no server deps.
 */
import { untrustedField } from "@/lib/untrusted-core";

export const MAX_BATCH = 20;
const LINE_BREAKS = new RegExp("[\\r\\n\\u2028\\u2029]+", "g");
export const MAX_OPENER_CHARS = 400;

export type OpenerInput = {
  contactName: string;
  contactTitle: string | null;
  company: string;
  domain: string | null;
  category: string | null;
  estMuu: number | null;
  trendPct: number | null; // 3-month traffic trend, e.g. -18 = −18 %
  techStack: string[];
  displaceable: string[]; // ad/CMS vendors RTB replaces
  ownership: string | null;
  fitExplanation: string | null;
  serpTitle: string | null; // site title / tagline seen in search (untrusted)
};

function muuPhrase(muu: number): string {
  if (muu >= 1_000_000) return `${(muu / 1_000_000).toFixed(muu >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (muu >= 1_000) return `${Math.round(muu / 1_000)}K`;
  return String(Math.round(muu));
}

function topic(category: string | null): string {
  const c = (category ?? "").trim();
  return c ? `${c.toLowerCase()} ` : "";
}

/**
 * Deterministic opener when AI is unavailable: one specific observation from the fit signals. Estimates are worded as
 * estimates ("roughly"), never as facts, and nothing claims RTB results.
 */
export function heuristicOpener(i: OpenerInput): string {
  const company = i.company.trim() || i.domain || "your site";
  const vendors = i.displaceable.filter(Boolean);
  // POL-08: never tell a cold prospect their traffic is falling — a declining trend just falls through to neutral lines
  if (vendors.length >= 3) {
    return `I noticed ${company} runs ${vendors.length} separate ad and tech vendors (${vendors.slice(0, 3).join(", ")}…). Consolidating that is usually where independent publishers find the quickest revenue wins.`;
  }
  if (i.estMuu != null && i.estMuu >= 100_000) {
    const independent = /independ|founder/i.test(i.ownership ?? "") ? "independent " : "";
    return `${company} reaches roughly ${muuPhrase(i.estMuu)} readers a month, which puts it right in the range where ${independent}${topic(i.category)}publishers get the most out of owning their full media stack.`;
  }
  if (i.trendPct != null && i.trendPct >= 10) {
    return `${company}'s audience has been growing nicely lately. Growth is the best moment to make sure every new visitor is monetized well.`;
  }
  return `I've been reading ${company}'s ${topic(i.category)}coverage and had an idea I think is worth a short conversation.`;
}

/** Prompt for the AI opener. All site/search-derived text is wrapped as untrusted data. */
export function openerPrompt(i: OpenerInput): string {
  const facts = [
    `Company: ${untrustedField("company", i.company, 120)}`,
    `Domain: ${untrustedField("domain", i.domain, 120)}`,
    `Site title/tagline: ${untrustedField("site_title", i.serpTitle, 200)}`,
    `Recipient: ${untrustedField("contact_name", i.contactName, 120)}, ${untrustedField("contact_title", i.contactTitle, 120)}`,
    `Category: ${untrustedField("category", i.category, 60)}`,
    `Estimated monthly unique users (estimate, not verified): ${i.estMuu != null ? muuPhrase(i.estMuu) : "unknown"}`,
    `3-month traffic trend: ${i.trendPct != null ? `${Math.round(i.trendPct)}%` : "unknown"}`,
    `Ownership: ${untrustedField("ownership", i.ownership, 60)}`,
    `Ad/tech vendors detected: ${untrustedField("tech_stack", i.techStack.slice(0, 12).join(", "), 300)}`,
    `Why they fit (internal score note): ${untrustedField("fit_note", i.fitExplanation, 300)}`,
  ].join("\n");
  return [
    "Write the personal opening line(s) of a cold email from an RTB salesperson to this publisher executive.",
    "Rules: 1–2 sentences, at most 45 words. Specific to this publisher, using only the facts below. Plain, warm, peer-to-peer tone.",
    "Do not greet (no 'Hi …'), do not sign off, do not pitch RTB's results or numbers, do not flatter, do not mention data sources, scraping, AI or estimates as precise facts.",
    "If a number is an estimate, say 'roughly'. No placeholders, no brackets, no quotes, no emoji.",
    "",
    facts,
  ].join("\n");
}

/** Clean model or user output into a safe single-paragraph opener ('' if unusable). */
export function sanitizeOpener(text: string | null | undefined): string {
  if (!text) return "";
  let t = text
    .replace(/<\/?untrusted[^>]*>/gi, "")
    .replace(/\{\{|\}\}/g, "")
    .replace(LINE_BREAKS, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  t = t.replace(/^["“”']+|["“”']+$/g, "").trim();
  t = t.replace(/^(hi|hello|hey|dear)\b[^,]{0,40},\s*/i, "");
  if (t.length > MAX_OPENER_CHARS) {
    const cut = t.slice(0, MAX_OPENER_CHARS);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = end > 80 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  }
  return t;
}
