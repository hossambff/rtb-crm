import { describe, expect, it } from "vitest";
import { listHref, PAGE_KEY, pickEntryParams, sameParams, sanitizeParams, smartOwnerParams, toQueryString } from "../core";
import { GLOSSARY, motionTermId } from "../../glossary";

describe("saved views", () => {
  it("list hrefs never navigate to a bare path (so clearing filters doesn't bounce to the remembered view)", () => {
    expect(listHref("/accounts", "")).toBe("/accounts?page=1");
    expect(listHref("/accounts", "?")).toBe("/accounts?page=1");
    expect(listHref("/accounts", "owner=me")).toBe("/accounts?owner=me");
    expect(listHref("/accounts", "?owner=me")).toBe("/accounts?owner=me");
    expect(sanitizeParams(new URLSearchParams("page=1"))).toEqual({});
  });
  it("sanitizes params: drops volatile, empty, odd keys; sorts; caps", () => {
    expect(sanitizeParams({ owner: "me", page: "3", q: "", "bad key": "x", status: ["open", "won"], n: 5 })).toEqual({ owner: "me", status: "open" });
    expect(Object.keys(sanitizeParams(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v"]))))).toHaveLength(20);
    expect(sanitizeParams(new URLSearchParams("b=2&a=1"))).toEqual({ a: "1", b: "2" });
  });
  it("entry params: default view → last used (empty = everything) → smart default", () => {
    const smart = { owner: "me" };
    expect(pickEntryParams([], smart)).toEqual(smart);
    expect(pickEntryParams([{ params: {}, isDefault: false, isLast: true }], smart)).toBeNull();
    expect(pickEntryParams([{ params: { stage: "x" }, isDefault: false, isLast: true }], smart)).toEqual({ stage: "x" });
    expect(pickEntryParams([{ params: { stage: "x" }, isDefault: false, isLast: true }, { params: { owner: "team" }, isDefault: true, isLast: false }], smart)).toEqual({ owner: "team" });
    expect(pickEntryParams([], null)).toBeNull();
  });
  it("smart owner default by role", () => {
    expect(smartOwnerParams("sdr", "owner", "team")).toEqual({ owner: "me" });
    expect(smartOwnerParams("sales_leader", "owner", "team")).toEqual({ owner: "team" });
    expect(smartOwnerParams("executive", "owner", null)).toEqual({});
    // admins/execs see everything (no team → "My team" would be an empty board); leaders without reports too
    expect(smartOwnerParams("super_admin", "owner", "team")).toEqual({});
    expect(smartOwnerParams("executive", "owner", "team")).toEqual({});
    expect(smartOwnerParams("sales_leader", "owner", "team", false)).toEqual({});
    expect(smartOwnerParams("finance", "owner", "team")).toEqual({});
  });
  it("helpers", () => {
    expect(toQueryString({ a: "1", b: "x y" })).toBe("?a=1&b=x+y");
    expect(toQueryString({})).toBe("");
    expect(sameParams({ a: "1" }, { a: "1" })).toBe(true);
    expect(sameParams({ a: "1" }, { a: "1", b: "2" })).toBe(false);
    expect(PAGE_KEY.test("pipelines:NET")).toBe(true);
    expect(PAGE_KEY.test("../etc")).toBe(false);
  });
});

describe("glossary", () => {
  it("every entry is a short plain sentence", () => {
    for (const [id, e] of Object.entries(GLOSSARY)) {
      expect(e.term, id).toBeTruthy();
      expect(e.short.length, id).toBeLessThan(160);
      expect(e.short.endsWith("."), id).toBe(true);
    }
  });
  it("maps motion codes", () => {
    expect(motionTermId("NET")).toBe("net");
    expect(motionTermId("R100")).toBe("r100");
    expect(motionTermId("XYZ")).toBeNull();
  });
});
