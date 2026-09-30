import { describe, expect, it } from "vitest";
import { findClaimHits, looksLikeDraft, normalizeClaimText, type ClaimRule } from "../claims-core";
import { CLAIM_PATTERNS } from "../claims-patterns";

const RULES: ClaimRule[] = [
  { id: "c1", text: "Paid in 8 seconds / powered by Coinbase", pattern: CLAIM_PATTERNS.paidInSeconds, status: "banned", approvedAlternative: "Real-time payouts are in beta." },
  { id: "c2", text: "$100M audited revenue", pattern: CLAIM_PATTERNS.auditedRevenue100m, status: "banned", approvedAlternative: "~$100M annualized run-rate (unaudited)." },
  { id: "c3", text: "500M audience reach", pattern: "500\\s?m(illion)?\\s+(audience|reach|users)", status: "restricted", approvedAlternative: null },
  { id: "c4", text: "No cost to join the coalition", pattern: "(costs? nothing|free to join|no cost)", status: "approved", approvedAlternative: null },
];
const ids = (t: string) => findClaimHits(t, RULES).map((h) => h.claimId).sort();

describe("QA-02: claim paraphrases", () => {
  it("catches the exact QA repro (Copilot draft)", () => {
    expect(ids("our platform pays publishers in 8 seconds, and RTB has $100M in audited revenue")).toEqual(["c1", "c2"]);
    expect(ids("Draft a short follow-up telling them publishers get paid in 8 seconds and we have $100M audited revenue")).toEqual(["c1", "c2"]);
  });
  it("catches number words, spacing and obfuscation", () => {
    expect(ids("Publishers are paid within eight seconds.")).toEqual(["c1"]);
    expect(ids("payouts in 8 secs")).toEqual(["c1"]);
    expect(ids("Pay​ments settle in a few seconds")).toEqual(["c1"]);
    expect(ids("audited revenue of one hundred million dollars")).toEqual(["c2"]);
    expect(ids("revenue: $100,000,000 (audited)")).toEqual(["c2"]);
    expect(ids("We   have\n$ 100 MM   of audited revenue")).toEqual(["c2"]);
    expect(ids("five hundred million users")).toEqual(["c3"]);
  });
  it("does not flag the approved alternatives or unrelated text", () => {
    expect(ids("Real-time payouts are in beta; ~$100M annualized run-rate (unaudited). It's free to join.")).toEqual([]);
    expect(ids("The meeting took 20 minutes; we paid the invoice last week.")).toEqual([]);
  });
  it("normalizes text", () => {
    expect(normalizeClaimText("Twenty five  Secs")).toBe("25 seconds");
    expect(normalizeClaimText("$100M")).toBe("$100 million");
    expect(normalizeClaimText("a hundred million")).toBe("100 million");
  });
});

describe("QA-02: looksLikeDraft", () => {
  it("detects email drafts in chat text", () => {
    expect(looksLikeDraft("Subject: Quick follow-up\n\nHi Jen,\n...")).toBe(true);
    expect(looksLikeDraft("Hi Jennifer,\n\nGreat speaking today.\n\nBest,\nSam")).toBe(true);
    expect(looksLikeDraft("Your pipeline has 3 deals at risk.")).toBe(false);
  });
});
