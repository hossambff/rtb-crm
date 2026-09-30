import { describe, expect, it } from "vitest";
import { actorPath, renderInputTemplate, templatePlaceholders } from "../template";
import { isPlatformDomain, mapCategory, mapItems, mapVerdict, trendFromSeries, visitsSeries } from "../mappers";

describe("input templating", () => {
  it("replaces exact placeholders with typed values", () => {
    const out = renderInputTemplate({ websites: "{{domains}}", maxItems: "{{max}}", flag: true }, { domains: ["a.com", "b.com"], max: 20 });
    expect(out).toEqual({ websites: ["a.com", "b.com"], maxItems: 20, flag: true });
  });
  it("flattens array-in-array placeholders and embeds strings", () => {
    const out = renderInputTemplate({ searchTerms: ["{{queries}}"], note: "site:{{domain}} ceo", jobTitle: "{{titlesJoined}}" }, { queries: ["q1", "q2"], domain: "x.com", titlesJoined: "CEO, CFO" });
    expect(out).toEqual({ searchTerms: ["q1", "q2"], note: "site:x.com ceo", jobTitle: "CEO, CFO" });
  });
  it("drops keys for missing exact placeholders; nested objects work", () => {
    const out = renderInputTemplate({ a: "{{missing}}", nested: { b: "{{x}}", c: ["{{missing}}", "keep"] } }, { x: 1 });
    expect(out).toEqual({ nested: { b: 1, c: ["keep"] } });
  });
  it("seeded registry templates render", () => {
    expect(renderInputTemplate({ queries: "{{query}}", maxPagesPerQuery: 1 }, { query: "independent crypto news site" })).toEqual({ queries: "independent crypto news site", maxPagesPerQuery: 1 });
    expect(renderInputTemplate({ companies: "{{companyLinkedinUrls}}", jobTitles: "{{titles}}", maxItems: 10 }, { companyLinkedinUrls: ["https://linkedin.com/company/x"], titles: ["CEO"] })).toEqual({
      companies: ["https://linkedin.com/company/x"],
      jobTitles: ["CEO"],
      maxItems: 10,
    });
  });
  it("lists placeholders", () => {
    expect(templatePlaceholders({ a: "{{domains}}", b: ["x {{query}}"] }).sort()).toEqual(["domains", "query"]);
  });
  it("actor path uses ~", () => {
    expect(actorPath("tri_angle/fast-similarweb-scraper")).toBe("tri_angle~fast-similarweb-scraper");
    expect(actorPath("michael.g/email-verifier-validator")).toBe("michael.g~email-verifier-validator");
  });
});

describe("output mapping + validation", () => {
  it("traffic: similarweb-style item with monthly history", () => {
    const { records, quarantined } = mapItems("traffic", [
      {
        url: "https://www.coindesk.com",
        title: "CoinDesk",
        category: "Finance/Investing",
        estimatedMonthlyVisits: { "2026-06-01": 10_000_000, "2026-07-01": 9_000_000, "2026-08-01": 8_200_000 },
        topCountryShares: [{ countryCode: "us", value: 0.4 }],
        globalRank: { rank: 1500 },
      },
      { name: "no domain here" },
      "garbage",
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ domain: "coindesk.com", name: "CoinDesk", monthlyVisits: 8_200_000, topCountry: "US", category: "Finance", globalRank: 1500 });
    expect(records[0]!.trendPct).toBeCloseTo(-0.18);
    expect(quarantined).toHaveLength(2);
  });
  it("traffic: explicit outputMapping takes precedence", () => {
    const { records } = mapItems("traffic", [{ site: { host: "theblock.co" }, stats: { v: "2.5M" } }], { domain: "site.host", monthlyVisits: "stats.v" });
    expect(records[0]).toMatchObject({ domain: "theblock.co", monthlyVisits: 2_500_000 });
  });
  it("lookalike: similar-sites arrays fan out", () => {
    const { records } = mapItems("lookalike", [{ domain: "thedefensepost.com", similarSites: [{ site: "defensenews.com", similarity: 87 }, "breakingdefense.com", { site: "" }] }]);
    expect(records.map((r) => r.domain)).toEqual(["defensenews.com", "breakingdefense.com"]);
    expect(records[0]!.similarity).toBeCloseTo(0.87);
    expect(records[0]!.seed).toBe("thedefensepost.com");
  });
  it("serp: organic results → domains", () => {
    const { records } = mapItems("serp", [{ searchQuery: { term: "crypto news" }, organicResults: [{ url: "https://decrypt.co/news", title: "Decrypt" }, { url: "https://www.reddit.com/r/crypto" }] }]);
    expect(records.map((r) => r.domain)).toEqual(["decrypt.co", "reddit.com"]);
    expect(isPlatformDomain("reddit.com")).toBe(true);
    expect(isPlatformDomain("en.wikipedia.org")).toBe(true);
    expect(isPlatformDomain("decrypt.co")).toBe(false);
  });
  it("tech stack: flat and grouped", () => {
    const { records } = mapItems("tech_stack", [
      { domain: "a.com", technologies: [{ name: "WordPress" }, { name: "Taboola" }] },
      { Domain: "b.com", groups: [{ categories: [{ live: [{ Name: "Piano" }, { name: "Prebid" }] }] }] },
    ]);
    expect(records[0]!.technologies).toEqual(["WordPress", "Taboola"]);
    expect(records[1]!.technologies).toEqual(expect.arrayContaining(["Piano", "Prebid"]));
  });
  it("website contacts: emails lowercased, company linkedin extracted, bad emails quarantined", () => {
    const ok = mapItems("website_contacts", [{ url: "https://x.com/about", emails: ["Press@X.com", "jane@x.com"], linkedIns: ["https://www.linkedin.com/company/x-media", "https://linkedin.com/in/jane"] }]);
    expect(ok.records[0]).toMatchObject({ domain: "x.com", emails: ["press@x.com", "jane@x.com"], companyLinkedinUrl: "https://www.linkedin.com/company/x-media" });
    const bad = mapItems("website_contacts", [{ url: "https://x.com", emails: ["not-an-email@"] }]);
    expect(bad.records[0]!.emails).toEqual([]); // malformed addresses are dropped, the page record survives
  });
  it("people: first/last → fullName; missing name quarantined", () => {
    const { records, quarantined } = mapItems("people", [
      { firstName: "Jane", lastName: "Doe", position: "CEO", linkedinUrl: "https://linkedin.com/in/janedoe" },
      { headline: "no name" },
    ]);
    expect(records[0]).toMatchObject({ fullName: "Jane Doe", title: "CEO", linkedinUrl: "https://linkedin.com/in/janedoe", email: null });
    expect(quarantined).toHaveLength(1);
  });
  it("email verification verdicts", () => {
    const { records, quarantined } = mapItems("email_verify", [
      { email: "a@x.com", result: "deliverable" },
      { email: "b@x.com", status: "catch-all" },
      { email: "c@x.com", status: "undeliverable" },
      { email: "d@x.com" },
      { email: "nope", result: "valid" },
    ]);
    expect(records.map((r) => r.verification)).toEqual(["valid", "risky", "invalid", "unknown"]);
    expect(quarantined).toHaveLength(1);
    expect(mapVerdict(true)).toBe("valid");
    expect(mapVerdict("disposable")).toBe("invalid");
  });
  it("email finder + linkedin email", () => {
    expect(mapItems("email_finder", [{ firstName: "Jane", lastName: "Doe", email: "Jane.Doe@X.com", confidence: 92 }]).records[0]).toMatchObject({ fullName: "Jane Doe", email: "jane.doe@x.com", confidence: 0.92 });
    expect(mapItems("email_from_linkedin", [{ url: "https://linkedin.com/in/j", emails: ["j@x.com"] }]).records[0]).toMatchObject({ email: "j@x.com" });
  });
  it("series helpers + category map", () => {
    expect(visitsSeries([{ visits: 1 }, 2, { value: "3" }])).toEqual([1, 2, 3]);
    expect(trendFromSeries([100, 90, 80, 50])).toBeCloseTo(-0.444, 2);
    expect(trendFromSeries([5])).toBeNull();
    expect(mapCategory("News_and_Media/Business_News")).toBe("Business");
    expect(mapCategory("Finance/Investing")).toBe("Finance");
    expect(mapCategory("Sports/Football")).toBe("Sports");
    expect(mapCategory(null)).toBeNull();
  });
});
