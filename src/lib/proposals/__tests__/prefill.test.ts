import { describe, expect, it } from "vitest";
import { proFormaPrefill, type DealPrefillSource } from "../prefill";
import { computeProForma, emptyInputs, normalizeInputs } from "../calc";
import { parseXml, serializeXml } from "../docx/xml";
import { dateSamples, snapshotOf } from "../termsheet";

const base: DealPrefillSource = {
  unit: "muu",
  muu: 40_000_000,
  usdPerMuu: null,
  pipelineUsdPerMuu: 1.5,
  revSharePct: 0.45,
  pipelineRevSharePct: 0.4,
  guaranteeType: "fixed_monthly",
  guaranteeMonthlyCents: 5_000_000,
  rampMonths: 6,
  termYears: 5,
  contractValueCents: null,
  annualizedValueCents: null,
};

describe("A6 pro forma prefill from an ENT deal", () => {
  it("fills revenue (MUU × $/MUU), rev share, guarantee, ramp and term", () => {
    const { inputs, filled } = proFormaPrefill(base);
    expect(inputs.revenue?.display).toBe(60_000_000);
    expect(inputs.revSharePct).toBe(0.45);
    expect(inputs.guaranteeType).toBe("fixed_monthly");
    expect(inputs.guaranteeAmount).toBe(50_000);
    expect(inputs.rampMonths).toBe(6);
    expect(inputs.termYears).toBe(5);
    expect(filled.map((f) => f.field)).toEqual(["revenue.display", "revSharePct", "guaranteeType", "rampMonths", "termYears"]);
    // and the builder computes from it
    const out = computeProForma(normalizeInputs({ ...emptyInputs(), ...inputs }));
    expect(out.inScopeRevenue).toBe(60_000_000);
    expect(out.rtbShare).toBe(27_000_000);
  });

  it("falls back to pipeline defaults and the deal's $/MUU override", () => {
    const { inputs, filled } = proFormaPrefill({ ...base, revSharePct: null, usdPerMuu: 2 });
    expect(inputs.revenue?.display).toBe(80_000_000);
    expect(inputs.revSharePct).toBe(0.4);
    expect(filled.find((f) => f.field === "revSharePct")?.value).toContain("pipeline default");
  });

  it("never uses fields hidden from the user's role", () => {
    const { inputs, filled } = proFormaPrefill(base, new Set(["revSharePct", "guaranteeType", "guaranteeMonthlyCents", "termYears"]));
    expect(inputs.revSharePct).toBeUndefined();
    expect(inputs.guaranteeType).toBeUndefined();
    expect(inputs.guaranteeAmount).toBeUndefined();
    expect(inputs.termYears).toBeUndefined();
    expect(filled.map((f) => f.field)).toEqual(["revenue.display", "rampMonths"]);
  });

  it("handles empty deals and $ motions", () => {
    expect(proFormaPrefill({ ...base, muu: null, revSharePct: null, pipelineRevSharePct: null, guaranteeType: null, rampMonths: null, termYears: null }).filled).toEqual([]);
    expect(proFormaPrefill({ ...base, unit: "usd", annualizedValueCents: 12_300_00 }).inputs.revenue?.display).toBe(12_300);
  });
});

describe("xml prolog fidelity", () => {
  it("keeps CRLF / whitespace between the declaration and the root", () => {
    const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document xmlns:w="x"><w:body/></w:document>\r\n';
    expect(serializeXml(parseXml(xml))).toBe(xml);
  });
});

describe("template snapshot", () => {
  it("keeps only mapped candidates and the reviewed tiers", () => {
    const candidates = [
      { id: "lit:[A]", kind: "bracket" as const, text: "[A]", context: "", occurrences: 1, locators: [], suggested: "recipientName" as const },
      { id: "pos:d#1@0", kind: "date" as const, text: "June 2, 2031", context: "", occurrences: 1, locators: [], suggested: "letterDate" as const },
      { id: "lit:[B]", kind: "bracket" as const, text: "[B]", context: "", occurrences: 1, locators: [], suggested: "ignore" as const },
    ];
    const fieldMap = [
      { token: "lit:[A]", input: "recipientName", occurrences: 1 },
      { token: "pos:d#1@0", input: "letterDate", occurrences: 1 },
      { token: "lit:[B]", input: "ignore", occurrences: 1 },
    ];
    const snap = snapshotOf({ fieldMap, parsed: { candidates, tiers: [{ label: "<1M", min: null, max: 1e6, partnerPct: 60, rtbPct: 40 }], approval: { tierChange: true, fields: ["region"] } } });
    expect(snap.candidates.map((c) => c.id)).toEqual(["lit:[A]", "pos:d#1@0"]);
    expect(snap.fieldMap).toHaveLength(2);
    expect(snap.approval).toEqual({ tierChange: true, fields: ["region"] });
    expect(dateSamples(snap.candidates, snap.fieldMap)).toEqual({ letterDate: "June 2, 2031" });
  });
});

describe("A6 prefill respects field-level security (QA)", () => {
  it("never uses hidden MUU, $/MUU, value or ramp", () => {
    expect(proFormaPrefill(base, new Set(["muu"])).inputs.revenue).toBeUndefined();
    expect(proFormaPrefill({ ...base, usdPerMuu: 2 }, new Set(["usdPerMuu"])).inputs.revenue?.display).toBe(60_000_000); // pipeline rate
    expect(proFormaPrefill(base, new Set(["rampMonths"])).inputs.rampMonths).toBeUndefined();
    expect(proFormaPrefill({ ...base, unit: "usd", contractValueCents: 10_000_00 }, new Set(["contractValueCents"])).inputs.revenue).toBeUndefined();
    const all = proFormaPrefill(base, new Set(["*"]));
    expect(all.filled).toEqual([]);
  });
});
