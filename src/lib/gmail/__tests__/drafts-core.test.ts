import { describe, expect, it } from "vitest";
import { evaluateDraftGuard, firstNameFromEmail, personalizeDraft, verifiedRecipients, withSignature } from "../drafts-core";

describe("evaluateDraftGuard (QA MIN-23)", () => {
  it("is ok without hits", () => {
    expect(evaluateDraftGuard([], "warn", [])).toEqual({ status: "ok", warnings: [] });
  });
  it("flags restricted claims and MNPI hints in plain language", () => {
    const g = evaluateDraftGuard([{ status: "restricted", match: "500M reach", alternative: "Syndication reach" }], "warn", ["deal terms"]);
    expect(g.status).toBe("flagged");
    expect(g.warnings.join(" ")).toContain("Possible confidential info");
    expect(g.warnings.join(" ")).not.toContain("MNPI");
  });
  it("blocks banned claims in block mode only", () => {
    const hit = [{ status: "banned" as const, match: "paid in 8 seconds", alternative: null }];
    expect(evaluateDraftGuard(hit, "block", []).status).toBe("blocked");
    expect(evaluateDraftGuard(hit, "warn", []).status).toBe("flagged");
  });
});

describe("personalizeDraft / signature / first name", () => {
  it("fills first_name or falls back to there", () => {
    expect(personalizeDraft("Hi {{ first_name }},", "Jane Doe")).toBe("Hi Jane,");
    expect(personalizeDraft("Hi {{first_name}},", null)).toBe("Hi there,");
  });
  it("appends the signature once", () => {
    expect(withSignature("Body", "— Will")).toBe("Body\n\n— Will");
    expect(withSignature("Body\n\n— Will", "— Will")).toBe("Body\n\n— Will");
  });
  it("guesses names but not role mailboxes", () => {
    expect(firstNameFromEmail("jane.doe@x.com")).toBe("Jane");
    expect(firstNameFromEmail("info@x.com")).toBeNull();
  });
});

describe("verifiedRecipients (SEC L-8)", () => {
  const internal = (e: string) => e.endsWith("@roundtable.io");
  it("keeps attendees and known contacts, reports unknown transcript names as unverified", () => {
    const r = verifiedRecipients({
      attendees: ["Jane@Pub.com", "me@roundtable.io"],
      participants: ["jane@pub.com", "ceo@pub.com", "attacker@evil.example", "not-an-email"],
      knownContacts: new Set(["ceo@pub.com"]),
      isInternal: internal,
    });
    expect(r.to).toEqual(["jane@pub.com", "ceo@pub.com"]);
    expect(r.unverified).toEqual(["attacker@evil.example"]);
  });
  it("caps recipients", () => {
    const attendees = Array.from({ length: 8 }, (_, i) => `p${i}@pub.com`);
    expect(verifiedRecipients({ attendees, participants: [], knownContacts: new Set(), isInternal: internal }).to).toHaveLength(5);
  });
});
