import { describe, expect, it } from "vitest";
import {
  expiryFrom,
  firstName,
  generateShareToken,
  hashShareToken,
  isPreviewBot,
  isWellFormedToken,
  linkState,
  muuBand,
  normalizeShareFields,
  projectShareCard,
  SHARE_FIELDS,
  type ShareSourceDeal,
} from "../core";

const deal: ShareSourceDeal = {
  name: "TheStreet — NET 2026",
  accountName: "TheStreet",
  restricted: false,
  deleted: false,
  status: "open",
  stageName: "Proposal",
  stageCategory: "open",
  nextStep: "Send   the\ncontract",
  nextStepDueAt: new Date("2026-10-05T16:00:00Z"),
  expectedCloseDate: new Date("2026-11-20T16:00:00Z"),
  muu: 12_400_000,
  ownerName: "Chris Smith",
};

describe("tokens", () => {
  it("are 256-bit base64url and hash to sha256 hex", () => {
    const t = generateShareToken();
    expect(isWellFormedToken(t)).toBe(true);
    expect(t).toHaveLength(43);
    expect(hashShareToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashShareToken(t)).toBe(hashShareToken(t));
    expect(generateShareToken()).not.toBe(t);
  });
  it("rejects malformed tokens before any lookup", () => {
    expect(isWellFormedToken("abc")).toBe(false);
    expect(isWellFormedToken("a".repeat(42) + "=")).toBe(false);
    expect(isWellFormedToken("../../etc/passwd")).toBe(false);
    expect(isWellFormedToken(null)).toBe(false);
  });
});

describe("fields & states", () => {
  it("normalizes to the allow-list in canonical order", () => {
    expect(normalizeShareFields(["owner", "stage", "revSharePct", "stage", 3])).toEqual(["stage", "owner"]);
  });
  it("link states", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    expect(linkState({ expiresAt: new Date("2026-10-02T00:00:00Z"), revokedAt: null }, now)).toBe("active");
    expect(linkState({ expiresAt: new Date("2026-09-30T00:00:00Z"), revokedAt: null }, now)).toBe("expired");
    expect(linkState({ expiresAt: new Date("2026-10-02T00:00:00Z"), revokedAt: now }, now)).toBe("revoked");
  });
  it("expiry options", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    expect(expiryFrom(7, now).toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(expiryFrom(999, now).toISOString()).toBe("2026-10-31T00:00:00.000Z"); // falls back to 30
  });
  it("bands and first names", () => {
    expect(muuBand(12_400_000)).toBe("10–25M monthly users");
    expect(muuBand(500_000)).toBe("Under 1M monthly users");
    expect(muuBand(250_000_000)).toBe("100M+ monthly users");
    expect(muuBand(null)).toBeNull();
    expect(firstName("Chris Smith")).toBe("Chris");
    expect(firstName("erik@roundtable.io")).toBeNull();
    expect(firstName("Erik (placeholder)")).toBeNull();
  });
});

describe("projectShareCard", () => {
  it("never renders restricted or deleted deals", () => {
    expect(projectShareCard({ ...deal, restricted: true }, SHARE_FIELDS)).toBeNull();
    expect(projectShareCard({ ...deal, deleted: true }, SHARE_FIELDS)).toBeNull();
  });
  it("only includes allow-listed fields, coarsened", () => {
    const c = projectShareCard(deal, SHARE_FIELDS)!;
    expect(c).toEqual({
      title: "TheStreet",
      status: "open",
      stage: "Proposal",
      nextStep: "Send the contract",
      nextStepDue: "Oct 5",
      closeDate: "Nov 2026",
      muu: "10–25M monthly users",
      owner: "Chris",
    });
  });
  it("omits everything not selected", () => {
    expect(projectShareCard(deal, ["stage"])).toEqual({ title: "TheStreet", status: "open", stage: "Proposal" });
  });
  it("leaks no internal ids or unknown keys even if the source object carries them", () => {
    const sneaky = { ...deal, id: "uuid-1", revSharePct: 0.4, guaranteeMonthlyCents: 100 } as ShareSourceDeal;
    const s = JSON.stringify(projectShareCard(sneaky, SHARE_FIELDS));
    expect(s).not.toContain("uuid-1");
    expect(s).not.toContain("0.4");
    expect(s).not.toContain("guarantee");
    expect(s).not.toContain(String(deal.muu));
  });
  it("closed deals drop forward-looking fields", () => {
    const c = projectShareCard({ ...deal, status: "won" }, SHARE_FIELDS)!;
    expect(c.status).toBe("won");
    expect(c.nextStep).toBeUndefined();
    expect(c.closeDate).toBeUndefined();
  });
});

describe("isPreviewBot", () => {
  it("detects unfurlers and crawlers", () => {
    expect(isPreviewBot("Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)")).toBe(true);
    expect(isPreviewBot("facebookexternalhit/1.1")).toBe(true);
    expect(isPreviewBot("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
    expect(isPreviewBot(null)).toBe(true);
  });
  it("lets browsers through", () => {
    expect(isPreviewBot("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe(false);
    expect(isPreviewBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")).toBe(false);
  });
});

describe("projectShareCard — MNPI scan on the shared next step (SEC L-12)", () => {
  it("drops a next step that mentions non-public / internal figures", () => {
    expect(projectShareCard({ ...deal, nextStep: "Confirm terms before the unannounced earnings call" }, SHARE_FIELDS)!.nextStep).toBeUndefined();
    expect(projectShareCard({ ...deal, nextStep: "Walk through weighted pipeline $4.2M with CFO" }, SHARE_FIELDS)!.nextStep).toBeUndefined();
  });
  it("keeps an ordinary next step", () => {
    expect(projectShareCard({ ...deal, nextStep: "Send the signed MSA" }, SHARE_FIELDS)!.nextStep).toBe("Send the signed MSA");
  });
});
