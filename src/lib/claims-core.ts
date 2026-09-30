/** Pure claim matching (unit-tested). */
export type ClaimRule = { id: string; text: string; pattern: string | null; status: string; approvedAlternative: string | null };
export type ClaimHit = { claimId: string; claim: string; status: "banned" | "restricted"; match: string; alternative: string | null };

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUMBER_WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "g");

const INVISIBLES = new RegExp("[\\u200B-\\u200F\\u2060\\uFEFF\\u00AD]", "g");
const SINGLE_QUOTES = new RegExp("[\\u2018\\u2019\\u201A\\u201B\\u2032]", "g");
const DOUBLE_QUOTES = new RegExp("[\\u201C\\u201D\\u201E\\u2033]", "g");
const DASHES = new RegExp("[\\u2010-\\u2015\\u2212]", "g");

/**
 * QA-02 / SEC L-10: canonical form for claim matching, so paraphrases and simple obfuscation still match.
 * - Unicode NFKC, zero-width / soft-hyphen removal, smart quotes and dashes → ASCII, lowercase.
 * - Number words → digits ("eight" → 8, "one hundred" / "a hundred" → 100, "five hundred million" → 500 million).
 * - Thousands separators dropped ("100,000,000" → 100000000 → "100 million"); "$ 100" → "$100";
 *   "mm"/"mn"/"mil"/"millions" → "million" and a trailing "m" after a number → " million".
 * - Whitespace (incl. newlines) collapsed to single spaces.
 */
export function normalizeClaimText(input: string): string {
  let t = input.normalize("NFKC");
  t = t.replace(INVISIBLES, "");
  t = t.replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"').replace(DASHES, "-");
  t = t.toLowerCase();
  t = t.replace(/\s+/g, " ");
  // number words → digits ("twenty five" → "20 5" → "25")
  t = t.replace(NUMBER_WORD_RE, (w) => String(NUMBER_WORDS[w]));
  t = t.replace(/\b(\d0) ([1-9])\b/g, (_, tens: string, unit: string) => String(Number(tens) + Number(unit)));
  t = t.replace(/\ba hundred\b/g, "100").replace(/\b(\d+) hundred\b/g, (_, n: string) => String(Number(n) * 100));
  t = t.replace(/\ba (thousand|million|billion)\b/g, "1 $1");
  // thousands separators and big literals
  t = t.replace(/(\d),(?=\d{3}\b)/g, "$1");
  t = t.replace(/\b(\d+)000000000\b/g, "$1 billion").replace(/\b(\d+)000000\b/g, "$1 million");
  t = t.replace(/\$\s+(?=\d)/g, "$");
  t = t.replace(/\b(\d+(?:\.\d+)?)\s?(mm|mn|mil|millions?|m)\b/g, "$1 million");
  t = t.replace(/\b(\d+(?:\.\d+)?)\s?(bn|billions?|b)\b/g, "$1 billion");
  t = t.replace(/\b(\d+)\s?(secs?|seconds?)\b/g, "$1 seconds");
  return t.replace(/\s+/g, " ").trim();
}

/** Guard against catastrophic patterns and giant inputs: cap text length per rule evaluation. */
const MAX_SCAN_CHARS = 50_000;

export function findClaimHits(text: string, rules: ClaimRule[]): ClaimHit[] {
  const hits: ClaimHit[] = [];
  const raw = text.slice(0, MAX_SCAN_CHARS);
  const norm = normalizeClaimText(raw);
  for (const r of rules) {
    if (r.status !== "banned" && r.status !== "restricted") continue;
    let re: RegExp | null = null;
    try {
      re = r.pattern ? new RegExp(r.pattern, "i") : null;
    } catch {
      re = null;
    }
    const m = re ? (norm.match(re) ?? raw.match(re)) : norm.includes(normalizeClaimText(r.text)) ? [r.text] : null;
    if (m) hits.push({ claimId: r.id, claim: r.text, status: r.status, match: m[0], alternative: r.approvedAlternative });
  }
  return hits;
}

/**
 * QA-02: does assistant text look like (or contain) an outbound draft — email/message/one-pager copy — so the claim
 * guardrail must run on it? Subject/To lines, a greeting + sign-off, or a fenced block.
 */
export function looksLikeDraft(text: string): boolean {
  if (/^\s*(subject|to|cc)\s*:/im.test(text)) return true;
  if (/```/.test(text)) return true;
  const greeting = /^\s*(hi|hello|hey|dear|good (morning|afternoon))\b[^\n]{0,60},?\s*$/im.test(text);
  const signOff = /^\s*(best|best regards|regards|kind regards|thanks|thank you|cheers|sincerely)[,!.]?\s*$/im.test(text);
  return greeting && signOff ? true : /\bdraft\b/i.test(text) && (greeting || signOff);
}
