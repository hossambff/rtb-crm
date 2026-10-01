import { describe, expect, it } from "vitest";
import { bandText, lookupTier, parseAmount, parseBand, parsePercents, parseTierTable, validateTiers, type Tier } from "../docx/tiers";

// Invented bands and percentages — not any real schedule.
const T = (label: string, partnerPct: number, rtbPct: number): Tier => ({ label, ...parseBand(label)!, partnerPct, rtbPct });

describe("parseAmount / parseBand", () => {
  it("reads units", () => {
    expect(parseAmount("60M")).toBe(60_000_000);
    expect(parseAmount("1.5 million")).toBe(1_500_000);
    expect(parseAmount("50k")).toBe(50_000);
    expect(parseAmount("250,000")).toBe(250_000);
    expect(parseAmount("2bn")).toBe(2_000_000_000);
    expect(parseAmount("abc")).toBeNull();
  });

  it("reads band shapes", () => {
    expect(parseBand(">60M")).toEqual({ min: 60_000_000, max: null, minExclusive: true });
    expect(parseBand("20M–60M")).toEqual({ min: 20_000_000, max: 60_000_000 });
    expect(parseBand("20 - 60M monthly users")).toEqual({ min: 20_000_000, max: 60_000_000 });
    expect(parseBand("<50k")).toEqual({ min: null, max: 50_000, maxExclusive: true });
    expect(parseBand("Up to 250K")).toEqual({ min: null, max: 250_000 });
    expect(parseBand("10M+")).toEqual({ min: 10_000_000, max: null });
    expect(parseBand("1M to 5M MUU")).toEqual({ min: 1_000_000, max: 5_000_000 });
    expect(parseBand("Tier 2: 1M to 5M")).toEqual({ min: 1_000_000, max: 5_000_000 });
    expect(parseBand("Partner share")).toBeNull();
    expect(parseBand("50%")).toBeNull();
    expect(parseBand("60M–20M")).toBeNull();
  });

  it("reads percentages", () => {
    expect(parsePercents("61%")).toEqual([61]);
    expect(parsePercents("70% / 30%")).toEqual([70, 30]);
    expect(parsePercents("65/35")).toEqual([65, 35]);
    expect(parsePercents("65/30")).toEqual([]);
    expect(parsePercents("n/a")).toEqual([]);
  });
});

describe("parseTierTable", () => {
  it("parses a header + band rows, partner column first", () => {
    const t = parseTierTable([
      ["Monthly users", "Partner share", "Network share"],
      [">90M", "61%", "39%"],
      ["20M – 90M", "57%", "43%"],
      ["<20M", "52%", "48%"],
    ]);
    expect(t?.tiers.map((x) => [x.label, x.partnerPct, x.rtbPct])).toEqual([
      [">90M", 61, 39],
      ["20M – 90M", 57, 43],
      ["<20M", 52, 48],
    ]);
    expect(t?.columnsGuessed).toBe(false);
  });

  it("detects a Roundtable column listed first", () => {
    const t = parseTierTable([
      ["Audience", "Roundtable", "Publisher"],
      ["≥ 5M", "30%", "70%"],
      ["Under 5M", "20%", "80%"],
    ]);
    expect(t?.tiers.map((x) => [x.partnerPct, x.rtbPct])).toEqual([
      [70, 30],
      [80, 20],
    ]);
  });

  it("returns null for ordinary tables", () => {
    expect(parseTierTable([["Name", "Role"], ["A", "B"]])).toBeNull();
    expect(parseTierTable([["Users", "Share"], [">1M", "50%", "50%"]])).toBeNull(); // one tier row only
  });
});

describe("lookupTier", () => {
  const tiers = [T(">90M", 61, 39), T("20M–90M", 57, 43), T("<20M", 52, 48)];

  it("picks the band the MUU falls in", () => {
    expect(lookupTier(tiers, 120_000_000)).toBe(0);
    expect(lookupTier(tiers, 50_000_000)).toBe(1);
    expect(lookupTier(tiers, 5_000)).toBe(2);
  });

  it("handles boundaries: '>X' excludes X, ranges include their ends, '<X' excludes X", () => {
    expect(lookupTier(tiers, 90_000_000)).toBe(1);
    expect(lookupTier(tiers, 20_000_000)).toBe(1);
    expect(lookupTier(tiers, 19_999_999)).toBe(2);
  });

  it("prefers the higher band where ranges touch", () => {
    const touching = [T("1M–5M", 50, 50), T("5M–10M", 60, 40)];
    expect(lookupTier(touching, 5_000_000)).toBe(1);
  });

  it("returns null without MUU or outside all bands", () => {
    expect(lookupTier(tiers, null)).toBeNull();
    expect(lookupTier(tiers, -1)).toBeNull();
    expect(lookupTier([T("1M–5M", 50, 50)], 9_000_000)).toBeNull();
  });
});

describe("validateTiers / bandText", () => {
  it("flags bad rows", () => {
    expect(validateTiers([{ label: "", min: 5, max: 1, partnerPct: 120, rtbPct: 0 }])).toHaveLength(3);
    expect(validateTiers([T(">90M", 61, 39)])).toEqual([]);
  });
  it("renders bands", () => {
    expect(bandText({ min: 20_000_000, max: 90_000_000 })).toBe("20M–90M");
    expect(bandText({ min: 90_000_000, max: null, minExclusive: true })).toBe(">90M");
    expect(bandText({ min: null, max: 250_000 })).toBe("≤250K");
  });
});
