import { describe, expect, it } from "vitest";
import { checkBudget, DEFAULT_BUDGET, domainsWithinBudget, estimateCents, normalizeBudget, userCapCents } from "../budget-core";
import { coerceAiCriteria, criteriaSchema, describeCriteria, heuristicCriteria, serpQueries } from "../criteria";
import { parseDomainRows, parseDomainText } from "../domain-list";
import { addBusinessDays, crmStatusLabel, emailMatchesName, isGenericEmail, isSeniorTitle, seniorityOf, titleMatchesRoles } from "../core";

describe("budget", () => {
  const s = DEFAULT_BUDGET;
  it("pilot defaults (D8)", () => {
    expect(normalizeBudget(undefined)).toEqual({ orgMonthlyCents: 500, userMonthlyCents: 200, execMonthlyCents: 500, perRunMaxCents: 50, maxDomainsPerRun: 50 });
    expect(normalizeBudget({ orgMonthlyCents: 2000, maxDomainsPerRun: -1 }).orgMonthlyCents).toBe(2000);
    expect(normalizeBudget({ maxDomainsPerRun: -1 }).maxDomainsPerRun).toBe(50);
  });
  it("per-user cap by role; explicit override wins", () => {
    expect(userCapCents("sdr", null, s)).toBe(200);
    expect(userCapCents("sales_leader", null, s)).toBe(500);
    expect(userCapCents("executive", undefined, s)).toBe(500);
    expect(userCapCents("sdr", 900, s)).toBe(900);
  });
  it("allows within caps", () => {
    const d = checkBudget({ estimateCents: 30, orgSpentCents: 100, userSpentCents: 50, userCapCents: 200, settings: s });
    expect(d.allowed).toBe(true);
    expect(d.maxAllowedCents).toBe(50);
  });
  it("blocks over per-run max with request-more", () => {
    const d = checkBudget({ estimateCents: 60, orgSpentCents: 0, userSpentCents: 0, userCapCents: 500, settings: s });
    expect(d).toMatchObject({ allowed: false, blockedBy: "per_run", canRequestMore: true });
  });
  it("blocks over user cap", () => {
    const d = checkBudget({ estimateCents: 40, orgSpentCents: 0, userSpentCents: 180, userCapCents: 200, settings: s });
    expect(d).toMatchObject({ allowed: false, blockedBy: "user_cap", canRequestMore: true, userRemainingCents: 20 });
  });
  it("org cap is a hard stop even with an approved override", () => {
    const d = checkBudget({ estimateCents: 40, orgSpentCents: 480, userSpentCents: 0, userCapCents: 200, settings: s, approvedOverrideCents: 100 });
    expect(d).toMatchObject({ allowed: false, blockedBy: "org_cap", canRequestMore: false });
    expect(d.message).toContain("$0.20");
  });
  it("approved override lifts per-run and user caps", () => {
    const d = checkBudget({ estimateCents: 80, orgSpentCents: 0, userSpentCents: 200, userCapCents: 200, settings: s, approvedOverrideCents: 100 });
    expect(d.allowed).toBe(true);
    // an override smaller than the estimate does not count
    expect(checkBudget({ estimateCents: 80, orgSpentCents: 0, userSpentCents: 0, userCapCents: 500, settings: s, approvedOverrideCents: 60 }).allowed).toBe(false);
  });
  it("estimates round up to whole cents", () => {
    expect(estimateCents(50, 0.002)).toBe(10);
    expect(estimateCents(1, 0.00089)).toBe(1);
    expect(estimateCents(0, 0.01)).toBe(0);
    expect(estimateCents(3, 0.0025)).toBe(1);
  });
  it("caps domains to budget", () => {
    expect(domainsWithinBudget(50, 1.5, 50)).toBe(33);
    expect(domainsWithinBudget(500, 1, 50)).toBe(50);
    expect(domainsWithinBudget(0, 1, 50)).toBe(0);
    expect(domainsWithinBudget(10, 0, 50)).toBe(50);
  });
});

describe("criteria", () => {
  it("normalizes and dedupes domain lists", () => {
    const c = criteriaSchema.parse({ domains: ["https://www.CoinDesk.com/markets", "coindesk.com", "not a domain"], seedDomains: ["thedefensepost.com"] });
    expect(c.domains).toEqual(["coindesk.com"]);
    expect(c.seedDomains).toEqual(["thedefensepost.com"]);
    expect(c.categories).toEqual([]);
  });
  it("rejects min > max", () => {
    expect(criteriaSchema.safeParse({ muuMin: 10, muuMax: 5 }).success).toBe(false);
  });
  it("heuristic NL parse of the PRD example", () => {
    const c = heuristicCriteria("Find 50 independent UK and Irish finance or politics publishers with 1–10M monthly users that aren't in our pipeline.");
    expect(c.countries).toEqual(expect.arrayContaining(["GB", "IE"]));
    expect(c.categories).toEqual(expect.arrayContaining(["Finance", "Politics"]));
    expect(c.ownership).toContain("independent");
    expect(c.muuMin).toBe(1_000_000);
    expect(c.muuMax).toBe(10_000_000);
    expect(c.notInPipeline).toBe(true);
    expect(c.limit).toBe(50);
    expect(c.keywords.length).toBeGreaterThan(0);
  });
  it("heuristic parses seeds and over/under", () => {
    const c = heuristicCriteria("sites like thedefensepost.com over 500k");
    expect(c.seedDomains).toEqual(["thedefensepost.com"]);
    expect(c.muuMin).toBe(500_000);
  });
  it("coerces AI output", () => {
    const c = coerceAiCriteria({
      categories: ["Finance"],
      countries: ["uk", "USA", "IE"],
      languages: ["en", "english"],
      muuMin: 1e6,
      muuMax: 1e7,
      ownership: ["independent"],
      keywords: ["independent finance news", "x"],
      seedDomains: ["https://www.proactiveinvestors.com"],
      notInPipeline: true,
      limit: 50,
    });
    expect(c.countries).toEqual(["GB", "IE"]);
    expect(c.languages).toEqual(["en"]);
    expect(c.keywords).toEqual(["independent finance news"]);
    expect(c.seedDomains).toEqual(["proactiveinvestors.com"]);
  });
  it("serp queries from keywords or categories", () => {
    expect(serpQueries({ keywords: ["premier league fan site"], categories: [], countries: [], ownership: [] })).toEqual(["premier league fan site"]);
    expect(serpQueries({ keywords: [], categories: ["Crypto"], countries: [], ownership: ["independent"] })).toEqual(["independent crypto news site"]);
  });
  it("describes criteria", () => {
    expect(describeCriteria({ categories: ["Finance"], countries: ["US", "GB"], muuMin: 500_000, muuMax: 10_000_000, ownership: ["independent"] })).toBe("Finance · US+GB · 500K–10M MUU · Independent");
    expect(describeCriteria({})).toBe("No filters");
  });
});

describe("domain list parsing", () => {
  it("paste: one per line, header skipped, dupes and junk counted", () => {
    const r = parseDomainText("domain\nhttps://www.coindesk.com/\ncoindesk.com\ntheblock.co\nhello world\n\n");
    expect(r.rows.map((x) => x.domain)).toEqual(["coindesk.com", "theblock.co"]);
    expect(r.duplicates).toBe(1);
    expect(r.invalid).toEqual(["hello world"]);
  });
  it("CSV with MUU column", () => {
    const r = parseDomainText('website,muu\n"decrypt.co","1.2M"\nbankless.com,450k\n');
    expect(r.rows).toEqual([
      { domain: "decrypt.co", muu: 1_200_000 },
      { domain: "bankless.com", muu: 450_000 },
    ]);
  });
  it("single line comma-separated paste", () => {
    expect(parseDomainText("a.com, b.com c.org").rows.map((r) => r.domain)).toEqual(["a.com", "b.com", "c.org"]);
  });
  it("xlsx-style rows", () => {
    expect(parseDomainRows([["Domain"], ["x.com", 300000], [null], ["y.io", ""]]).rows).toEqual([
      { domain: "x.com", muu: 300000 },
      { domain: "y.io", muu: null },
    ]);
  });
});

describe("core helpers", () => {
  it("adds business days skipping weekends", () => {
    // Fri 2026-10-02 + 2 business days = Tue 2026-10-06
    expect(addBusinessDays(new Date("2026-10-02T12:00:00Z"), 2).toISOString().slice(0, 10)).toBe("2026-10-06");
    // Wed + 2 = Fri
    expect(addBusinessDays(new Date("2026-09-30T12:00:00Z"), 2).toISOString().slice(0, 10)).toBe("2026-10-02");
  });
  it("CRM status labels (SCOUT-12)", () => {
    const now = new Date("2026-09-30T00:00:00Z");
    expect(crmStatusLabel(null)).toBe("New");
    expect(crmStatusLabel({ status: "in_crm", accountId: "a" })).toBe("In CRM, no deal");
    expect(crmStatusLabel({ status: "open_deal", ownerName: "Chris", stage: "In Comms" })).toBe("Open deal: Chris, In Comms");
    expect(crmStatusLabel({ status: "lost", lostAt: "2026-03-15T00:00:00Z", lostReason: "Timing" }, now)).toBe("Lost 6 months ago: Timing");
  });
  it("title matching & seniority", () => {
    expect(titleMatchesRoles("Chief Executive Officer & Co-founder", ["CEO"])).toBe(true);
    expect(titleMatchesRoles("Editor-in-Chief", ["Editor-in-Chief"])).toBe(true);
    expect(titleMatchesRoles("Head of Ad Operations", ["Head of Ad Ops"])).toBe(false);
    expect(titleMatchesRoles("Head of Ad Ops, EMEA", ["Head of Ad Ops"])).toBe(true);
    expect(titleMatchesRoles("Staff Writer", ["CEO", "Publisher"])).toBe(false);
    expect(titleMatchesRoles("Anything", [])).toBe(true);
    expect(isSeniorTitle("VP Sales")).toBe(true);
    expect(isSeniorTitle("Staff Writer")).toBe(false);
    expect(seniorityOf("Founder & Publisher")).toBe("c_level");
    expect(seniorityOf("Director of Revenue")).toBe("vp_director");
  });
  it("email ↔ name and generic mailbox detection", () => {
    expect(emailMatchesName("jane.doe@x.com", "Jane Doe")).toBe(true);
    expect(emailMatchesName("jdoe@x.com", "Jane Doe")).toBe(true);
    expect(emailMatchesName("press@x.com", "Jane Doe")).toBe(false);
    expect(isGenericEmail("press@x.com")).toBe(true);
    expect(isGenericEmail("jane@x.com")).toBe(false);
  });
});
