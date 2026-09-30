import { describe, expect, it } from "vitest";
import { accountKey, cleanAccountName, fillEmpty, nameSimilarity, normalizeName, sourcePriority, stripCorporateSubdomain } from "../dedupe";
import { ImportEngine, domainIsName, hashKey, typesCompatible } from "../engine";
import { normalizeFields, parsePriority, parseRelationshipCell, type NormalizeContext } from "../normalize";
import { createStageMatcher } from "../status";
import { inferSeniority, nameFromEmail, splitName } from "../../contacts/seniority";
import { MUU_STAGES, R100_STAGES } from "./fixtures";

describe("dedupe keys (ACC-5, IMP-5)", () => {
  it("normalizes names across punctuation, suffixes and URLs", () => {
    expect(normalizeName("The Defense Post")).toBe(normalizeName("Defense Post"));
    expect(normalizeName("Strive, Inc.")).toBe(normalizeName("Strive Inc."));
    expect(normalizeName("Grit Daily (19+ sites)")).toBe("gritdaily");
    expect(normalizeName("https://www.carolinahuddle.com/")).toBe("carolinahuddle");
  });
  it("prefers domain identity, falls back to name", () => {
    expect(accountKey({ domain: "https://www.hoopsrumors.com/", name: "x" })).toBe("d:hoopsrumors.com");
    expect(accountKey({ domain: "19+ publication sites", name: "Grit Daily" })).toBe("n:gritdaily");
    expect(accountKey({ domain: null, name: "" })).toBeNull();
  });
  it("cleans URL-looking names and corporate subdomains", () => {
    expect(cleanAccountName("https://www.carolinahuddle.com/", "carolinahuddle.com")).toBe("Carolinahuddle");
    expect(cleanAccountName(null, "hoopsrumors.com")).toBe("Hoopsrumors");
    expect(cleanAccountName("FNN / WTOP", null)).toBe("FNN / WTOP");
    expect(stripCorporateSubdomain("ir.applieddigital.com")).toBe("applieddigital.com");
    expect(stripCorporateSubdomain("investors.mara.com")).toBe("mara.com");
    expect(stripCorporateSubdomain("news.com")).toBe("news.com");
  });
  it("scores fuzzy name similarity", () => {
    expect(nameSimilarity("Decrypt Media", "Decrypt Media / Myriad")).toBeGreaterThan(0.6);
    expect(nameSimilarity("Forbes", "Fortune")).toBeLessThan(0.6);
  });
  it("fills only empty fields and snapshots before", () => {
    const { patch, before } = fillEmpty<{ category: string | null; league: string | null; tags: string[] }>({ category: "Finance", league: null, tags: [] }, { category: "Crypto", league: "NFL", tags: ["x"] });
    expect(patch).toEqual({ league: "NFL", tags: ["x"] });
    expect(before).toEqual({ league: null, tags: [] });
  });
  it("orders sources Strategic > Active > Pipeline", () => {
    expect(sourcePriority("Strategic Top Targets")).toBeLessThan(sourcePriority("NetDev Active"));
    expect(sourcePriority("NetDev Active")).toBeLessThan(sourcePriority("NetDev Pipeline"));
    expect(sourcePriority("Closed: Platform Agreement")).toBe(0);
  });
  it("keeps company and publisher identities apart on name-only matches", () => {
    expect(typesCompatible("public_company", "publisher")).toBe(false);
    expect(typesCompatible("advertiser", "publisher")).toBe(true);
    expect(typesCompatible("publisher", "media_group")).toBe(true);
    expect(domainIsName("crowdstrike.com", "CrowdStrike")).toBe(true);
    expect(domainIsName("theroot.com", "Root")).toBe(false);
    expect(hashKey("a|b")).toBe(hashKey("a|b"));
    expect(hashKey("a|b")).not.toBe(hashKey("a|c"));
  });
});

describe("normalizeFields (row → record)", () => {
  const ctx = (pipelineKey = "NET"): NormalizeContext => ({
    target: pipelineKey === "R100" ? "r100" : "accounts_deals",
    pipelineKey,
    source: "Test sheet",
    matchStatus: createStageMatcher(pipelineKey === "R100" ? R100_STAGES : MUU_STAGES),
    importDate: new Date("2026-09-30T00:00:00Z"),
    visitsPerUnique: 2.5,
  });
  it("keeps the raw MUU string and parses ranges (AT-03)", () => {
    const r = normalizeFields({ "account.name": "The Defense Post", "account.domain": "thedefensepost.com", "audience.muu": "1.5–2M", "deal.status": "Demo", "deal.owner": "Casey/Erik" }, 2, ctx())!;
    expect(r.audience[0]).toMatchObject({ metric: "muu", value: 1_750_000, rawValue: "1.5–2M" });
    expect(r.deal).toMatchObject({ stageKey: "demo", owners: ["Casey", "Erik"], muu: 1_750_000 });
  });
  it("stores monthly visits as visits and derives an estimated MUU", () => {
    const r = normalizeFields({ "account.name": "C&EN", "account.domain": "https://cen.acs.org", "audience.visits": "457K" }, 2, ctx())!;
    expect(r.audience[0]).toMatchObject({ metric: "visits", value: 457_000, derivedMuu: 182_800, confidence: "estimate" });
    expect(r.deal?.muu).toBe(182_800);
  });
  it("routes dates/emails/notes out of the status column", () => {
    const d = normalizeFields({ "account.name": "X", "deal.status": new Date(Date.UTC(2026, 7, 12)) }, 2, ctx())!;
    expect(d.deal).toMatchObject({ stageKey: "outreach" });
    expect(d.deal?.lastContactedAt?.toISOString().slice(0, 10)).toBe("2026-08-12");
    const e = normalizeFields({ "account.name": "Y", "deal.status": "media@wnco.com" }, 2, ctx())!;
    expect(e.contacts[0]).toMatchObject({ email: "media@wnco.com" });
    expect(e.deal?.stageKey).toBeNull();
    expect(e.statusNote).toMatchObject({ kind: "email" });
    const p = normalizeFields({ "account.name": "Z", "deal.status": "Top 10" }, 2, ctx())!;
    expect(p.account.priority).toBe("top10");
    expect(p.statusNote).toBeNull();
  });
  it("uses the tier when there is no status, via the pipeline's aliases", () => {
    const r = normalizeFields({ "account.name": "DAZN", "deal.tier": 0.9 }, 2, ctx())!;
    expect(r.deal?.stageKey).toBe("hot");
  });
  it("maps R100 activation fields", () => {
    const r = normalizeFields(
      {
        "account.name": "eToro",
        "r100.firstPostDate": new Date(Date.UTC(2026, 4, 20)),
        "r100.m1": true,
        "r100.m2": true,
        "r100.m3": false,
        "r100.postCount": 9,
        "r100.profileUrl": "https://roundtable100.com/asset/etoro",
        "r100.editorialLink": ["https://www.thestreet.com/a", "not a url"],
        "r100.bonus": 5000,
      },
      2,
      ctx("R100"),
    )!;
    expect(r.deal?.r100).toEqual({ firstPostDate: "2026-05-20", participation: [true, true, false], postCount: 9, profileUrl: "https://roundtable100.com/asset/etoro", editorialLinks: ["https://www.thestreet.com/a"], bonusCents: 500_000, bonusEligible: true });
    expect(r.account.type).toBe("public_company");
  });
  it("parses relationship cells into contacts with a relationship owner", () => {
    expect(parseRelationshipCell("Frank Holmes (Exec Chairman) - Will POC")).toMatchObject({ fullName: "Frank Holmes", title: "Exec Chairman", relationshipOwner: "Will" });
    expect(parseRelationshipCell("Gerard Dwyer, CIO - gdwyer@rivian.com")).toMatchObject({ fullName: "Gerard Dwyer", title: "CIO", email: "gdwyer@rivian.com" });
    expect(parsePriority("2-High")).toBe("high");
    expect(parsePriority("Follow up")).toBeNull();
  });
});

describe("ImportEngine.apply (in-memory dedupe & merge policy)", () => {
  const engine = () => {
    const e = new ImportEngine({} as never, { actorId: null, importDate: new Date("2026-09-30T00:00:00Z") });
    e.pipelines.set("NET", { id: "net", key: "NET", stages: MUU_STAGES });
    e.users = [
      { id: "u-chris", name: "Chris Smith", email: "chris@roundtable.io" },
      { id: "u-will", name: "Will Heckman", email: "will@roundtable.io" },
    ];
    e.beginBatch({ fileName: "t.xlsx", target: "accounts_deals" });
    return e;
  };
  const ctx: NormalizeContext = { target: "accounts_deals", pipelineKey: "NET", source: "T", matchStatus: createStageMatcher(MUU_STAGES), importDate: new Date() };

  it("one account per domain, one deal per account+pipeline, most advanced stage wins", () => {
    const e = engine();
    const a = e.apply(normalizeFields({ "account.name": "Proactive", "account.domain": "proactiveinvestors.com", "deal.status": "Warming up", "deal.owner": "Chris/Will" }, 2, ctx)!);
    const b = e.apply(normalizeFields({ "account.name": "Proactive Investors", "account.domain": "https://www.proactiveinvestors.com/", "deal.status": "Migrating", "deal.owner": "Zed" }, 3, ctx)!);
    const c = e.apply(normalizeFields({ "account.name": "Proactive", "account.domain": "proactiveinvestors.com", "deal.status": "Cold" }, 4, ctx)!);
    expect(a).toMatchObject({ account: "create", deal: "create", stageKey: "warming" });
    expect(b).toMatchObject({ account: "merge", deal: "merge", stageKey: "migrating" });
    expect(c?.stageKey).toBe("migrating");
    expect(e.stats).toMatchObject({ accountsCreated: 1, dealsCreated: 1, splitsCreated: 2, placeholdersCreated: 1 });
  });
  it("matches a domained row onto a same-name account that has no domain (and claims the domain)", () => {
    const e = engine();
    e.apply(normalizeFields({ "account.name": "Bitcoin Magazine", "deal.status": "Warming up" }, 2, ctx)!);
    const r = e.apply(normalizeFields({ "account.name": "Bitcoin Magazine", "account.domain": "bitcoinmagazine.com" }, 3, ctx)!);
    const again = e.apply(normalizeFields({ "account.name": "BTC Mag", "account.domain": "bitcoinmagazine.com" }, 4, ctx)!);
    expect(r?.account).toBe("merge");
    expect(again?.account).toBe("merge");
    expect(e.stats.accountsCreated).toBe(1);
  });
  it("never merges a company into a same-name publisher by name alone", () => {
    const e = engine();
    e.apply(normalizeFields({ "account.name": "The Root", "account.domain": "theroot.com" }, 2, ctx)!);
    const rec = normalizeFields({ "account.name": "Root" }, 3, { ...ctx, target: "r100", accountType: "public_company" })!;
    rec.deal = null;
    expect(e.apply(rec)?.account).toBe("create");
  });
});

describe("contact helpers", () => {
  it("infers seniority and names", () => {
    expect(inferSeniority("Founder/CEO")).toBe("c_level");
    expect(inferSeniority("SVP, Product")).toBe("vp");
    expect(inferSeniority("Editor-in-Chief")).toBe("c_level"); // "chief" → top of the masthead
    expect(inferSeniority("Head of Ad Ops")).toBe("director");
    expect(inferSeniority("Managing Editor")).toBe("manager");
    expect(inferSeniority("")).toBeNull();
    expect(nameFromEmail("andrew.weber@pagaya.com")).toBe("Andrew Weber");
    expect(splitName("Mahir Zeynalov")).toEqual({ firstName: "Mahir", lastName: "Zeynalov" });
  });
});
