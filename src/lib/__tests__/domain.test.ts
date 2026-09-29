import { describe, expect, it } from "vitest";
import { classifyStatusValue, normalizeDomain, parseAudience, splitOwners } from "../domain";

describe("normalizeDomain", () => {
  it("strips protocol, www and paths", () => {
    expect(normalizeDomain("https://www.hoopsrumors.com/")).toBe("hoopsrumors.com");
    expect(normalizeDomain("DAZN.com")).toBe("dazn.com");
    expect(normalizeDomain("federalnewsnetwork.com / WTOP")).toBe("federalnewsnetwork.com");
    expect(normalizeDomain("https://thedebrief.org/path?x=1")).toBe("thedebrief.org");
  });
  it("rejects non-domains", () => {
    expect(normalizeDomain("19+ publication sites")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
  });
});

describe("parseAudience", () => {
  it("parses PRD examples", () => {
    expect(parseAudience("450k")).toBe(450_000);
    expect(parseAudience("1.5–2M")).toBe(1_750_000);
    expect(parseAudience("1.5-2M")).toBe(1_750_000);
    expect(parseAudience("100M+")).toBe(100_000_000);
    expect(parseAudience("<100k")).toBe(50_000);
    expect(parseAudience("<100K")).toBe(50_000);
    expect(parseAudience("243.6K")).toBe(243_600);
    expect(parseAudience("150k+")).toBe(150_000);
    expect(parseAudience(43000000)).toBe(43_000_000);
  });
  it("returns null for empties", () => {
    expect(parseAudience("N/A")).toBeNull();
    expect(parseAudience("—")).toBeNull();
    expect(parseAudience("")).toBeNull();
    expect(parseAudience(undefined)).toBeNull();
  });
});

describe("splitOwners", () => {
  it("splits combined owners", () => {
    expect(splitOwners("Chris/Will")).toEqual(["Chris", "Will"]);
    expect(splitOwners("Erik (linkedin)/Andres (email)")).toEqual(["Erik", "Andres"]);
    expect(splitOwners("chris")).toEqual(["Chris"]);
  });
});

describe("classifyStatusValue", () => {
  it("detects non-status values", () => {
    expect(classifyStatusValue("Hot")).toBe("status");
    expect(classifyStatusValue("media@wnco.com")).toBe("email");
    expect(classifyStatusValue("7/20 outreach")).toBe("date");
    expect(classifyStatusValue(new Date())).toBe("date");
    expect(classifyStatusValue("Sheryl fowarded email to PR team")).toBe("note");
  });
});
