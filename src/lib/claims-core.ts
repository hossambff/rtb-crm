/** Pure claim matching (unit-tested). */
export type ClaimRule = { id: string; text: string; pattern: string | null; status: string; approvedAlternative: string | null };
export type ClaimHit = { claimId: string; claim: string; status: "banned" | "restricted"; match: string; alternative: string | null };

export function findClaimHits(text: string, rules: ClaimRule[]): ClaimHit[] {
  const hits: ClaimHit[] = [];
  for (const r of rules) {
    if (r.status !== "banned" && r.status !== "restricted") continue;
    let re: RegExp | null = null;
    try {
      re = r.pattern ? new RegExp(r.pattern, "i") : null;
    } catch {
      re = null;
    }
    const m = re ? text.match(re) : text.toLowerCase().includes(r.text.toLowerCase()) ? [r.text] : null;
    if (m) hits.push({ claimId: r.id, claim: r.text, status: r.status, match: m[0], alternative: r.approvedAlternative });
  }
  return hits;
}
