import { describe, expect, it } from "vitest";
import { approvalLookupFromHref, pickVerifiedClaimant, slackEmailMatches } from "../core";
import { alertsChannelMessage, infoModal } from "../blocks";

const D = "11ff1828-0000-4000-8000-000000000001";

describe("Slack identity (SEC M-4)", () => {
  it("matches emails case-insensitively; empty never matches", () => {
    expect(slackEmailMatches("Ana@Roundtable.io", " ana@roundtable.io ")).toBe(true);
    expect(slackEmailMatches("ana@roundtable.io", "bob@roundtable.io")).toBe(false);
    expect(slackEmailMatches("", "")).toBe(false);
    expect(slackEmailMatches(null, "x@y.z")).toBe(false);
  });
  it("only the claimant whose email matches the Slack profile wins", () => {
    const claims = [
      { userId: "claimer", email: "mallory@roundtable.io" },
      { userId: "owner", email: "ana@roundtable.io" },
    ];
    expect(pickVerifiedClaimant(claims, "ana@roundtable.io")).toBe("owner");
    expect(pickVerifiedClaimant([claims[0]!], "ana@roundtable.io")).toBeNull(); // a false self-claim never acts
    expect(pickVerifiedClaimant([], "ana@roundtable.io")).toBeNull();
    expect(pickVerifiedClaimant(claims, null)).toBeNull();
  });
});

describe("approvalLookupFromHref (QA MAJ-15)", () => {
  it("maps subject links to the pending request to look up", () => {
    expect(approvalLookupFromHref(`/deals/${D}`)).toEqual({ kinds: ["probability_override", "stage_gate"], entity: "deal", entityId: D });
    expect(approvalLookupFromHref(`/proposals/${D}`)).toEqual({ kinds: ["proposal"], entity: "proposal", entityId: D });
    expect(approvalLookupFromHref(`/proposals/term-sheets/${D}`)).toMatchObject({ kinds: ["proposal"], entityId: D });
    expect(approvalLookupFromHref("/commissions?tab=registrations")).toEqual({ kinds: ["lead_registration"] });
    expect(approvalLookupFromHref("/scout?tab=budget")).toEqual({ kinds: ["scout_budget"] });
    expect(approvalLookupFromHref("/scout")).toEqual({ kinds: ["scout_accept"] });
  });
  it("ignores anything else", () => {
    for (const h of [null, "", "/home", `/deals/${D}/edit`, "//evil.com/deals/x", "https://x.com", "/scout?tab=outreach", "/deals/not-a-uuid"]) expect(approvalLookupFromHref(h)).toBeNull();
  });
});

describe("alerts channel message (QA MAJ-16)", () => {
  it("is null with nothing to post, caps the list, escapes text", () => {
    expect(alertsChannelMessage([], "https://app.example.com")).toBeNull();
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Alert <${i}>`, href: "/tasks?tab=alerts", ruleCode: "NS-02" }));
    const m = alertsChannelMessage(many, "https://app.example.com", 10)!;
    const s = JSON.stringify(m);
    expect(m.text).toBe("Critical · 12 critical alerts");
    expect(s).toContain("and 2 more");
    expect(s).toContain("&lt;0&gt;");
    expect(s).not.toContain("Alert <0>");
    expect(s).toContain("never posted to Slack");
  });
});

describe("reject flow info modal (QA MIN-37)", () => {
  it("is a close-only modal", () => {
    const v = infoModal("You can't decide this request.");
    expect(v.type).toBe("modal");
    expect(v.submit).toBeUndefined();
    expect(JSON.stringify(v)).toContain("You can't decide this request.");
  });
});
