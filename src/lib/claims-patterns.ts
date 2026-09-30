/**
 * QA-02: claim-library regexes for the seeded banned claims, written against normalizeClaimText() output
 * (lowercase, number words → digits, "$100M" → "$100 million", "8 secs" → "8 seconds"). Shared by scripts/seed.ts
 * (new databases) and scripts/update-claims.ts (idempotent update of existing rows, matched by claim text).
 * Every quantifier is bounded, so the patterns can't backtrack catastrophically.
 */
export const CLAIM_PATTERNS = {
  paidInSeconds:
    "(\\bpa(y|ys|id|ying|yout|youts)\\b.{0,60}\\b(in|within|under|after) (\\d+ |a few |few |mere )?seconds\\b|\\bsettle(s|d|ment|ments)?\\b.{0,40}\\b(in|within|under) (\\d+ |a few |few )?seconds\\b|\\b(near[- ]?)?instant(ly|aneous)? (publisher |partner )?(pay(outs?|ments?)|settlement)\\b(?!.{0,24}\\b(beta|upcoming|coming soon|pilot|planned)\\b)|\\breal[- ]time (publisher |partner )?(payouts?|settlement)\\b(?!.{0,24}\\b(beta|upcoming|coming soon|pilot|planned)\\b)|powered by coinbase|coinbase[- ]custod)",
  auditedRevenue100m:
    "(\\$?100 million\\b.{0,60}\\baudit(ed|s)?\\b|\\baudit(ed|s)?\\b.{0,60}\\$?100 million\\b|\\$?100\\s?m(illion)?\\s+(of\\s+)?audited)",
} as const;

/** Seeded claim text → current pattern (the update script rewrites rows whose pattern differs). */
export const CLAIM_PATTERN_UPDATES: { text: string; pattern: string }[] = [
  { text: "Paid in 8 seconds / powered by Coinbase", pattern: CLAIM_PATTERNS.paidInSeconds },
  { text: "$100M audited revenue", pattern: CLAIM_PATTERNS.auditedRevenue100m },
];
