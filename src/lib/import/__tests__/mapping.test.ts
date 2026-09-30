import { describe, expect, it } from "vitest";
import { createStageMatcher, moreAdvanced, stageRank, tierToStageKey } from "../status";
import { applyTemplate, columnIds, columnLetter, suggestMapping } from "../fields";
import { canonicalRep, equalSplits, matchUserByFirstName, parseOwners, placeholderEmail } from "../owners";
import { ADS_STAGES, MUU_STAGES, R100_STAGES } from "./fixtures";

describe("status → stage (Appendix A, IMP-3)", () => {
  const m = createStageMatcher(MUU_STAGES);
  it("maps seed aliases case-insensitively", () => {
    for (const [raw, key] of [
      ["Hot", "hot"],
      ["HOT ", "hot"],
      ["Old Lead", "cold"],
      ["Reached out", "outreach"],
      ["Call set", "in_comms"],
      ["Met", "in_comms"],
      ["Stuck", "on_hold"],
      ["On Pause", "on_hold"],
      ["Beta", "demo"],
      ["New", "target"],
      ["Rejected", "lost"],
      ["Migrating", "migrating"],
      ["Launched", "live"],
      ["contract sent", "contract"],
    ] as const)
      expect(m(raw), raw).toMatchObject({ kind: "stage", stageKey: key });
  });
  it("splits dated statuses into stage + last-contacted date", () => {
    const r = m("7/29 Outreach");
    expect(r).toMatchObject({ kind: "stage", stageKey: "outreach" });
    expect(r.kind === "stage" && r.date?.toISOString().slice(0, 10)).toBe("2026-07-29");
    expect(m("Forwarded 8/12")).toMatchObject({ kind: "stage", stageKey: "outreach" });
    expect(m("followed up 8/31")).toMatchObject({ kind: "stage", stageKey: "outreach" });
  });
  it("classifies non-status values instead of inventing stages", () => {
    expect(m(new Date(Date.UTC(2026, 7, 17)))).toMatchObject({ kind: "date" });
    expect(m("2026-08-17")).toMatchObject({ kind: "date" });
    expect(m("media@wnco.com")).toMatchObject({ kind: "email" });
    expect(m("https://www.delmontefoods.com/")).toMatchObject({ kind: "url" });
    expect(m("Revisit: too small / no contacts / not independent")).toMatchObject({ kind: "note" });
    expect(m("Zombie")).toMatchObject({ kind: "unmapped", raw: "Zombie" });
    expect(m("")).toEqual({ kind: "empty" });
    expect(m(null)).toEqual({ kind: "empty" });
  });
  it("handles R100 and ADS vocabularies", () => {
    const r = createStageMatcher(R100_STAGES);
    expect(r("Cold, Keep comms")).toMatchObject({ stageKey: "cold" });
    expect(r("Made First Post")).toMatchObject({ stageKey: "first_post" });
    expect(r("Relationship already")).toMatchObject({ stageKey: "relationship" });
    expect(r("Profile Activated")).toMatchObject({ stageKey: "profile_activated" });
    const a = createStageMatcher(ADS_STAGES);
    expect(a("Verbal - closing now")).toMatchObject({ stageKey: "verbal" });
    expect(a("Signed LOI")).toMatchObject({ stageKey: "loi" });
    expect(a("Warm deal")).toMatchObject({ stageKey: "warm" });
  });
  it("maps v7 tiers 1 / 0.9 / 0.5 / 0.1", () => {
    expect(tierToStageKey(1)).toBe("contract");
    expect(tierToStageKey(0.9)).toBe("hot");
    expect(tierToStageKey("50%")).toBe("in_comms");
    expect(tierToStageKey(0.1)).toBe("target");
    expect(tierToStageKey(null)).toBeNull();
  });
  it("ranks stages so merges keep the most advanced", () => {
    const byKey = Object.fromEntries(MUU_STAGES.map((s) => [s.key, s]));
    expect(moreAdvanced(byKey.target!, byKey.hot!).key).toBe("hot");
    expect(moreAdvanced(byKey.migrating!, byKey.contract!).key).toBe("migrating");
    expect(moreAdvanced(byKey.on_hold!, byKey.lost!).key).toBe("on_hold");
    expect(stageRank(byKey.cold!)).toBeGreaterThan(stageRank(byKey.target!));
    expect(stageRank(byKey.lost!)).toBeLessThan(stageRank(byKey.target!));
  });
});

describe("owners (IMP-4)", () => {
  it("splits combined owners and fixes typos", () => {
    expect(parseOwners("Chris/Will")).toEqual(["Chris", "Will"]);
    expect(parseOwners("Erik (linkedin)/Andres (email)")).toEqual(["Erik", "Andres"]);
    expect(parseOwners("Caey")).toEqual(["Casey"]);
    expect(parseOwners("chris")).toEqual(["Chris"]);
    expect(parseOwners("SW")).toEqual(["SW"]);
    expect(parseOwners("Mariah (In comm 07/29)")).toEqual(["Mariah"]);
    expect(parseOwners("Kevin/Mariah ")).toEqual(["Kevin", "Mariah"]);
    expect(parseOwners("The Back Burner (still on the stove, but off the heat) — revisit next quarter")).toEqual([]);
    expect(canonicalRep("Chris Smith")).toBe("Chris");
  });
  it("makes equal splits that sum to exactly 100", () => {
    const s3 = equalSplits(["a", "b", "c"]);
    expect(s3.map((x) => x.pct).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
    expect(equalSplits(["a", "b"]).map((x) => x.pct)).toEqual([50, 50]);
    expect(equalSplits([])).toEqual([]);
  });
  it("matches real users by first name, else the placeholder", () => {
    const users = [
      { id: "1", name: "Chris Smith", email: "chris@roundtable.io" },
      { id: "2", name: "Dev SVP", email: "dev.svp@roundtable.io" },
      { id: "3", name: "Kevin (placeholder)", email: placeholderEmail("Kevin") },
    ];
    expect(matchUserByFirstName("Chris", users)?.id).toBe("1");
    expect(matchUserByFirstName("Kevin", users)?.id).toBe("3");
    expect(matchUserByFirstName("Dev", users)).toBeNull(); // dev test accounts never own imported data
    expect(placeholderEmail("Andrés")).toBe("andres.placeholder@roundtable.invalid");
  });
});

describe("column mapping (IMP-1)", () => {
  it("auto-maps v7 / C&W / RTB Sites headers", () => {
    const v7 = suggestMapping(["Media Name", "Domain", "Status", "MUU", "Category", "Source", "POC Name", "POC Contact", "Title", "Notes"], "accounts_deals");
    expect(v7).toMatchObject({ "Media Name": "account.name", Domain: "account.domain", Status: "deal.status", MUU: "audience.muu", "POC Contact": "contact.email", Title: "contact.title", Notes: "deal.notes" });
    const sites = suggestMapping(["Media Name", "Website", "Category", "Monthly visits", "Status", "Rep"], "accounts_deals");
    expect(sites).toMatchObject({ Website: "account.domain", "Monthly visits": "audience.visits", Rep: "deal.owner" });
    const r100 = suggestMapping(["FP", "Owner", "B2C?", "Ticker", "Token Name", "Website", "Press Page", "PR email", "Status", "Email 2", "Title", "Email 3", "Title", "Market Cap"], "r100");
    expect(r100).toMatchObject({ Ticker: "account.ticker", "Token Name": "account.tokenName", "B2C?": "account.isB2c", "PR email": "account.prEmail", "Email 2": "contact.email", Title: "contact.title", "Title #2": "contact.title2", "Market Cap": "account.marketCap" });
    const ads = suggestMapping(["Category", "Account", "Next Payment Deal Value ($)", "Annualized ($)", "Status", "Notes"], "ads");
    expect(ads).toMatchObject({ Account: "account.name", "Next Payment Deal Value ($)": "deal.nextPayment", "Annualized ($)": "deal.annualized" });
  });
  it("disambiguates duplicate / blank headers", () => {
    expect(columnIds(["Title", "Email", "Title", null])).toEqual(["Title", "Email", "Title #2", "Column D"]);
    expect(columnLetter(27)).toBe("AB");
  });
  it("re-applies a saved template onto a new file", () => {
    const m = applyTemplate(["Outlet", "Domain", "Weird"], { Outlet: "account.name", Weird: "deal.notes" }, "accounts_deals");
    expect(m).toEqual({ Outlet: "account.name", Domain: "account.domain", Weird: "deal.notes" });
  });
});
