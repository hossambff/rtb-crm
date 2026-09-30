import { describe, expect, it } from "vitest";
import { buildDirectory, isBlocked, matchParticipants, matchStageName, normalizeBlocklist, normalizeEmail, parentDomain, pickDeal } from "../matching-core";

const dir = buildDirectory(
  [
    { id: "c1", email: "Jane@Reach.co.uk", altEmails: [], accountId: "a-reach" },
    { id: "c2", email: "pat@gmail.com", altEmails: ["pat@work.io"], accountId: "a-work" },
  ],
  [
    { id: "a-reach", domain: "reach.co.uk", altDomains: ["reachplc.com"] },
    { id: "a-post", domain: "https://www.defensepost.com/", altDomains: [] },
  ],
);
const opts = { internalDomains: ["roundtable.io", "blockchainff.com"], blocklist: [] as string[], ownerEmail: "me@roundtable.io" };

describe("normalizeEmail", () => {
  it("extracts bare addresses", () => {
    expect(normalizeEmail('"Doe, Jane" <Jane@X.com>')).toBe("jane@x.com");
    expect(normalizeEmail("not an email")).toBeNull();
  });
});

describe("matchParticipants", () => {
  it("matches by contact email first", () => {
    const r = matchParticipants(["me@roundtable.io", "jane@reach.co.uk"], dir, opts);
    expect(r.relevant).toBe(true);
    expect(r.contactIds).toEqual(["c1"]);
    expect(r.accountId).toBe("a-reach");
    expect(r.externalEmails).toEqual(["jane@reach.co.uk"]);
  });
  it("matches by account domain, alt domains and subdomains", () => {
    expect(matchParticipants(["bob@defensepost.com"], dir, opts).accountId).toBe("a-post");
    expect(matchParticipants(["bob@reachplc.com"], dir, opts).accountId).toBe("a-reach");
    expect(matchParticipants(["bob@mail.defensepost.com"], dir, opts).accountId).toBe("a-post");
  });
  it("personal domains only match via exact contact", () => {
    expect(matchParticipants(["pat@gmail.com"], dir, opts).contactIds).toEqual(["c2"]);
    expect(matchParticipants(["random@gmail.com"], dir, opts).relevant).toBe(false);
  });
  it("skips internal-only and blocklisted threads", () => {
    expect(matchParticipants(["me@roundtable.io", "boss@blockchainff.com"], dir, opts).reason).toBe("internal_only");
    const blocked = matchParticipants(["jane@reach.co.uk"], dir, { ...opts, blocklist: ["reach.co.uk"] });
    expect(blocked).toMatchObject({ relevant: false, reason: "blocked" });
    expect(matchParticipants([], dir, opts).reason).toBe("no_participants");
  });
  it("unknown external domains are not relevant", () => {
    expect(matchParticipants(["x@unknown.com"], dir, opts)).toMatchObject({ relevant: false, reason: "no_match" });
  });
});

describe("blocklist", () => {
  it("normalizes entries and matches domains incl. subdomains", () => {
    const bl = normalizeBlocklist([" @Family.com ", "Friend@Example.org", "*.bank.com", "junk", ""]);
    expect(bl).toEqual(["bank.com", "family.com", "friend@example.org"]);
    expect(isBlocked("mom@family.com", bl)).toBe(true);
    expect(isBlocked("x@secure.bank.com", bl)).toBe(true);
    expect(isBlocked("other@example.org", bl)).toBe(false);
    expect(isBlocked("friend@example.org", bl)).toBe(true);
  });
});

describe("matchStageName", () => {
  const stages = ["Target", "Outreach", "In Comms", "Warming Up", "Hot", "Demo / Beta Review", "Contract", "On Hold"];
  it("maps suggestions onto pipeline stage names", () => {
    expect(matchStageName("hot", stages)).toBe("Hot");
    expect(matchStageName("Contract (redlines in progress)", stages)).toBe("Contract");
    expect(matchStageName("Demo", stages)).toBe("Demo / Beta Review");
    expect(matchStageName("Proposal (send pro forma & NDA)", stages)).toBeNull();
    expect(matchStageName(null, stages)).toBeNull();
  });
});

describe("parentDomain / pickDeal", () => {
  it("parent domains", () => {
    expect(parentDomain("news.example.com")).toBe("example.com");
    expect(parentDomain("example.com")).toBeNull();
    expect(parentDomain("mail.reach.co.uk")).toBe("reach.co.uk");
    expect(parentDomain("reach.co.uk")).toBeNull();
  });
  it("prefers deals owned by/split with the user, else most recent", () => {
    const t = (d: string) => new Date(d);
    const deals = [
      { id: "d1", ownerId: "u2", splitUserIds: [], lastActivityAt: t("2026-09-29"), updatedAt: t("2026-09-01") },
      { id: "d2", ownerId: "u3", splitUserIds: ["u1"], lastActivityAt: null, updatedAt: t("2026-08-01") },
    ];
    expect(pickDeal(deals, "u1")?.id).toBe("d2");
    expect(pickDeal(deals, "u9")?.id).toBe("d1");
    expect(pickDeal([], "u1")).toBeNull();
  });
});
