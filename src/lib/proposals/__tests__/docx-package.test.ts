import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { DocxError, DOCX_LIMITS, generateDocx, openDocx, readEntryText, readTextParts } from "../docx/package";
import { analyzeParts, partTexts } from "../docx/analyze";
import { parseXml } from "../docx/xml";
import { buildRules, normalizeTermSheetInputs, termSheetApprovalReasons, termSheetEconomics, usedTargets, type FieldMapEntry } from "../termsheet";
import { buildDocx, CONTENT_TYPES, documentXml } from "./docx-fixture";

describe("openDocx validation", () => {
  it("accepts a real docx", async () => {
    const zip = await openDocx(await buildDocx());
    expect((await readTextParts(zip)).map((p) => p.name)).toEqual(["word/document.xml", "word/header1.xml"]);
  });

  it("rejects non-zip, oversize, missing parts, macro and non-Word packages", async () => {
    await expect(openDocx(Buffer.from("hello world, not a zip"))).rejects.toThrow(/not a zip/);
    await expect(openDocx(Buffer.alloc(DOCX_LIMITS.maxFileBytes + 1, 0x50))).rejects.toThrow(/larger than/);
    const noDoc = new JSZip();
    noDoc.file("[Content_Types].xml", CONTENT_TYPES);
    await expect(openDocx(await noDoc.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/word\/document.xml/);
    await expect(openDocx(await buildDocx({ extra: { "word/vbaProject.bin": "x" } }))).rejects.toThrow(/Macro/);
    await expect(openDocx(await buildDocx({ contentTypes: CONTENT_TYPES.replace("wordprocessingml.document.main+xml", "spreadsheetml.sheet.main+xml") }))).rejects.toThrow(
      /standard .docx/,
    );
    const bad = new JSZip();
    bad.file("[Content_Types].xml", CONTENT_TYPES);
    bad.file("word/document.xml", "x");
    bad.file("../evil.txt", "x");
    await expect(openDocx(await bad.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/invalid entry name/);
  });

  it("caps decompressed size (zip bomb)", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", CONTENT_TYPES);
    // ~9 MB of zeros compresses to a few KB; reading it past the 8 MB part cap must abort.
    zip.file("word/document.xml", documentXml(`<w:p><w:r><w:t>${"0".repeat(9 * 1024 * 1024)}</w:t></w:r></w:p>`));
    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    expect(buf.byteLength).toBeLessThan(DOCX_LIMITS.maxFileBytes);
    const z = await openDocx(buf);
    await expect(readEntryText(z, "word/document.xml")).rejects.toBeInstanceOf(DocxError);
  });

  it("rejects text parts that are not well-formed", async () => {
    const zip = await openDocx(await buildDocx({ header: "<w:p><w:r><w:t>unclosed" }));
    await expect(readTextParts(zip)).rejects.toThrow(/not well-formed/);
  });
});

describe("generateDocx end to end (synthetic template)", () => {
  it("analyzes, maps, fills, and produces a valid docx with formatting kept", async () => {
    const template = await buildDocx();
    const parts = await readTextParts(await openDocx(template));
    const a = analyzeParts(parts);
    const fieldMap: FieldMapEntry[] = a.candidates.map((c) => ({ token: c.id, input: c.suggested, occurrences: c.occurrences }));
    expect(usedTargets(fieldMap)).toEqual(["recipientName", "companyLegalName", "region", "letterDate", "ndaEffectiveDate", "signatoryName", "signatoryTitle"]);

    const values = {
      recipientName: "Ada Lovelace",
      companyLegalName: "Zeta Media & Sons <Ltd>",
      region: "Iberia",
      letterDate: "2026-10-01",
      ndaEffectiveDate: "2026-10-15",
      signatoryName: "Ada Lovelace",
      signatoryTitle: "", // left empty: placeholder stays, reported as unfilled
    };
    const { rules, unfilled } = buildRules(a.candidates, fieldMap, values);
    expect(unfilled).toEqual([{ token: "\t\t", target: "signatoryTitle" }]);

    const out = await generateDocx(template, rules);
    expect(out.keys).toMatchObject({ recipientName: 1, companyLegalName: 2, region: 1, letterDate: 1, ndaEffectiveDate: 1, signatoryName: 1 });

    // Output re-opens as a valid docx; every part parses.
    const zip = await openDocx(out.buffer, { maxFileBytes: DOCX_LIMITS.maxFileBytes * 4 });
    const outParts = await readTextParts(zip);
    const text = partTexts(outParts)
      .flatMap((p) => p.paragraphs.map((x) => x.text))
      .join("\n");
    expect(text).toContain("Dear Ada Lovelace,");
    expect(text).toContain("We invite Zeta Media & Sons <Ltd> & its brands to the sample network in Iberia.");
    expect(text).toContain("October 1st, 2026");
    expect(text).toContain("Effective as of October 15, 2026 between the parties.");
    expect(text).toContain("Name: Ada Lovelace");
    expect(text).toContain("By: ________________"); // signature line suggested "ignore" → untouched
    expect(text).toContain("Confidential sample · Zeta Media & Sons <Ltd>"); // header too
    const docXml = outParts[0]!.xml;
    expect(docXml).toContain("Zeta Media &amp; Sons &lt;Ltd&gt;");
    expect(() => parseXml(docXml)).not.toThrow();
    // untouched parts pass through
    expect(await zip.file("_rels/.rels")!.async("string")).toContain("officeDocument");
  });
});

describe("term sheet economics + approval", () => {
  const tiers = [
    { label: ">90M", min: 90_000_000, max: null, minExclusive: true, partnerPct: 61, rtbPct: 39 },
    { label: "20M–90M", min: 20_000_000, max: 90_000_000, partnerPct: 57, rtbPct: 43 },
    { label: "<20M", min: null, max: 20_000_000, maxExclusive: true, partnerPct: 52, rtbPct: 48 },
  ];

  it("computes the applicable tier and illustrative figures from MUU × $/MUU", () => {
    const e = termSheetEconomics({ muu: 30_000_000, usdPerMuu: 0.5, tierIndex: null }, tiers);
    expect(e.tierIndex).toBe(1);
    expect(e.overridden).toBe(false);
    expect(e.grossUsd).toBe(15_000_000);
    expect(e.partnerUsd).toBeCloseTo(8_550_000);
    expect(e.rtbUsd).toBeCloseTo(6_450_000);
    const none = termSheetEconomics({ muu: null, usdPerMuu: 1, tierIndex: null }, tiers);
    expect(none.tier).toBeNull();
    expect(none.partnerUsd).toBeNull();
  });

  it("flags a changed tier and changed approval-required fields", () => {
    const i = normalizeTermSheetInputs({
      muu: 30_000_000,
      usdPerMuu: 1,
      tierIndex: 0,
      values: { region: "Elsewhere", recipientName: "A" },
      prefill: { region: "Iberia", recipientName: "B" },
    });
    expect(termSheetApprovalReasons(i, { tierChange: true, fields: ["region"] }, tiers)).toEqual([
      "Revenue-share tier changed from 20M–90M to >90M",
      "Region / market changed from the deal's value",
    ]);
    expect(termSheetApprovalReasons(i, { tierChange: false, fields: [] }, tiers)).toEqual([]);
    expect(termSheetApprovalReasons(i, undefined, tiers)).toEqual([]);
  });

  it("normalizes untrusted inputs", () => {
    const i = normalizeTermSheetInputs({ values: { recipientName: "  A\u0000\nB ", "bad key": "x", "custom:Fee note": "ok" }, muu: -5, tierIndex: 1.5 });
    expect(i.values).toEqual({ recipientName: "A B", "custom:Fee note": "ok" });
    expect(i.muu).toBeNull();
    expect(i.tierIndex).toBeNull();
  });
});
