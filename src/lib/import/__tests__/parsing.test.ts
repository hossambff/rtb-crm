import { describe, expect, it } from "vitest";
import { cellText, cellToValue, extractEmails, parseBool, parseCsv, parseLooseDate, parseMarketCapUsd, parseMoneyToCents, parseProbability, sectionLabel } from "../cells";
import { detectHeaderRow, sheetTable } from "../workbook";

describe("cellToValue / cellText (exceljs shapes)", () => {
  it("flattens rich text, hyperlinks and formula results", () => {
    expect(cellToValue({ richText: [{ text: "Grit " }, { text: "Daily" }] })).toBe("Grit Daily");
    expect(cellToValue({ text: "press@ondo.finance", hyperlink: "mailto:press@ondo.finance" })).toBe("press@ondo.finance");
    expect(cellToValue({ text: "", hyperlink: "mailto:lea@sanofi.com" })).toBe("lea@sanofi.com");
    expect(cellToValue({ formula: "E2*1", result: 43000000 })).toBe(43000000);
    expect(cellToValue({ formula: "E2*1" })).toBeNull();
    expect(cellToValue({ error: "#REF!" })).toBeNull();
  });
  it("trims and nulls empties; dates become ISO days", () => {
    expect(cellText("  Hot  ")).toBe("Hot");
    expect(cellText("   ")).toBeNull();
    expect(cellText(new Date(Date.UTC(2026, 7, 12)))).toBe("2026-08-12");
  });
});

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF and embedded newlines", () => {
    const rows = parseCsv('Name,Notes\r\n"Grit Daily, Inc","said ""hi""\nthen left"\r\nTechdefused,\r\n');
    expect(rows).toEqual([
      ["Name", "Notes"],
      ["Grit Daily, Inc", 'said "hi"\nthen left'],
      ["Techdefused", ""],
    ]);
  });
  it("auto-detects semicolon delimiters and drops blank lines", () => {
    expect(parseCsv("a;b\n\n1;2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("sectionLabel", () => {
  it("detects decorated section headers and repeated-label rows", () => {
    expect(sectionLabel(["── Bitcoin Mining and Digital Asset Infrastructure ──"])).toBe("Bitcoin Mining and Digital Asset Infrastructure");
    expect(sectionLabel(["Rejections (ouch)", "Rejections (ouch)", "Rejections (ouch)", "Rejections (ouch)"])).toBe("Rejections (ouch)");
    expect(sectionLabel(["HIVE Digital", "Chris/Will", "No"])).toBeNull();
  });
});

describe("money / market cap / probability / booleans / dates", () => {
  it("parses money to cents", () => {
    expect(parseMoneyToCents(100000)).toBe(10_000_000);
    expect(parseMoneyToCents("$12,500")).toBe(1_250_000);
    expect(parseMoneyToCents("1.2M")).toBe(120_000_000);
    expect(parseMoneyToCents("n/a")).toBeNull();
  });
  it("parses market caps", () => {
    expect(parseMarketCapUsd("$937.6M")).toBe(937_600_000);
    expect(parseMarketCapUsd("$1.2B")).toBe(1_200_000_000);
  });
  it("parses probabilities", () => {
    expect(parseProbability(0.9)).toBe(0.9);
    expect(parseProbability("90%")).toBe(0.9);
    expect(parseProbability(100)).toBe(1);
    expect(parseProbability("x")).toBeNull();
  });
  it("parses participation booleans", () => {
    expect(parseBool(true)).toBe(true);
    expect(parseBool("Yes")).toBe(true);
    expect(parseBool("No")).toBe(false);
    expect(parseBool("maybe")).toBeNull();
  });
  it("parses loose dates with a 2026 default year", () => {
    expect(parseLooseDate("7/29")?.toISOString().slice(0, 10)).toBe("2026-07-29");
    expect(parseLooseDate("Met 7/1/26. Attendees")?.toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(parseLooseDate("2026-08-12")?.toISOString().slice(0, 10)).toBe("2026-08-12");
    expect(parseLooseDate("13/45")).toBeNull();
  });
  it("extracts emails from messy cells", () => {
    expect(extractEmails("Gerard Dwyer, CIO - gdwyer@rivian.com")).toEqual(["gdwyer@rivian.com"]);
    expect(extractEmails("a@x.com; B@Y.io a@x.com")).toEqual(["a@x.com", "b@y.io"]);
  });
});

describe("workbook helpers", () => {
  it("detects a header row below title rows (C&W layout)", () => {
    const rows = [["TheStreet Sales"], ["Revenue pipeline. Blue cells are inputs"], [], ["Category", "Account", "Next Payment Deal Value ($)", "Annualized ($)", "Status"], ["Active Deal", "Binance", 100000, null, "Verbal"]];
    expect(detectHeaderRow(rows)).toBe(3);
    const t = sheetTable({ name: "TheStreet", rows }, 3);
    expect(t.headers[1]).toBe("Account");
    expect(t.data).toHaveLength(1);
    expect(t.data[0]!.rowNumber).toBe(5);
  });
});
