import { describe, expect, it } from "vitest";
import { decodeEntities, escapeXmlAttr, escapeXmlText, parseXml, serializeXml, XmlError } from "../docx/xml";
import { partParagraphs, partTables } from "../docx/ooxml";
import { applyMatches, matchesFor, resolveOverlaps, substitutePart, type Rule } from "../docx/substitute";
import { customCandidate, detectPlaceholders, formatDateLike, parseIsoDate, suggestFor } from "../docx/detect";
import { analyzeParts } from "../docx/analyze";
import { previewPart } from "../docx/preview";
import { attachmentDisposition, safeFilename } from "../docx/filename";
import { documentXml, para, run, SAMPLE_BODY, tab } from "./docx-fixture";

describe("xml", () => {
  it("round-trips Word XML byte for byte", () => {
    const xml = documentXml(SAMPLE_BODY);
    expect(serializeXml(parseXml(xml))).toBe(xml);
  });

  it("rejects DOCTYPE / entity declarations (no XXE, no billion laughs)", () => {
    expect(() => parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>')).toThrow(XmlError);
    expect(() => parseXml("<x>&a;</x>")).toThrow(/Undeclared entity/);
  });

  it("rejects malformed documents", () => {
    for (const bad of ["<a><b></a>", "<a>", "<a></a><b></b>", "<a>x & y</a>", '<a x="1></a>', "<a x=1></a>", "text"]) expect(() => parseXml(bad), bad).toThrow();
  });

  it("validates attributes in linear time (no regex backtracking on hostile input)", () => {
    const t0 = Date.now();
    expect(() => parseXml(`<a${" ".repeat(200_000)}!></a>`)).toThrow(/Malformed attributes/);
    expect(() => parseXml(`<a x="1"y="2"></a>`)).toThrow(/Malformed attributes/);
    expect(parseXml(`<a\n x = "1" y='<'></a>`.replace("'<'", "'2'")).root.attrs).toBe(`\n x = "1" y='2'`);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("decodes and escapes entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#65;&#x42; &quot;&apos;")).toBe(`a & b <c> AB "'`);
    expect(escapeXmlText("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
    expect(escapeXmlAttr(`"'`)).toBe("&quot;&apos;");
    expect(escapeXmlText("a\u0001b\u0008c")).toBe("abc");
  });
});

describe("applyMatches (run merging)", () => {
  it("puts the value in the first run of a split token and trims the following runs", () => {
    const segs = ["Dear ", "[Recip", "ient Na", "me],"];
    const ms = [{ start: 5, end: 21, value: "Ada Lovelace", key: "recipientName" }];
    const { texts, marks } = applyMatches(segs, ms);
    expect(texts).toEqual(["Dear ", "Ada Lovelace", "", ","]);
    expect(marks[1]).toEqual([{ start: 0, end: 12, key: "recipientName" }]);
    expect(texts.join("")).toBe("Dear Ada Lovelace,");
  });

  it("handles several matches in one segment and keeps untouched segments identical", () => {
    const { texts } = applyMatches(["[A] and [B]", " end"], [
      { start: 0, end: 3, value: "x", key: "a" },
      { start: 8, end: 11, value: "yy", key: "b" },
    ]);
    expect(texts).toEqual(["x and yy", " end"]);
  });

  it("drops overlapping matches (earliest, then longest wins)", () => {
    expect(resolveOverlaps([
      { start: 2, end: 5, value: "", key: "b" },
      { start: 0, end: 4, value: "", key: "a" },
      { start: 4, end: 6, value: "", key: "c" },
    ]).map((m) => m.key)).toEqual(["a", "c"]);
  });

  it("positional rules win over literal ones and must match the expected text", () => {
    const rules: Rule[] = [
      { type: "literal", find: "____", value: "L", key: "lit" },
      { type: "positional", part: "p", ordinal: 0, start: 6, end: 10, expect: "____", value: "P", key: "pos" },
      { type: "positional", part: "p", ordinal: 0, start: 0, end: 2, expect: "zz", value: "never", key: "stale" },
    ];
    const ms = matchesFor("p", { ordinal: 0, text: "Name: ____ ____" }, rules);
    expect(ms.map((m) => m.key)).toEqual(["pos", "lit"]);
  });
});

describe("substitutePart", () => {
  const xml = documentXml(SAMPLE_BODY);

  it("replaces split tokens keeping the first run's formatting, escaping values", () => {
    const rules: Rule[] = [
      { type: "literal", find: "[Recipient Name]", value: "Ada <Lovelace> & Co", key: "recipientName" },
      { type: "literal", find: "[Company]", value: "Zeta \"Media\" Ltd", key: "companyLegalName" },
    ];
    const res = substitutePart(xml, "word/document.xml", rules);
    expect(res.replaced).toBe(2);
    expect(res.keys).toEqual({ recipientName: 1, companyLegalName: 1 });
    expect(() => parseXml(res.xml)).not.toThrow();
    // value landed in the bold run, with the XML escaped
    expect(res.xml).toContain('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Ada &lt;Lovelace&gt; &amp; Co</w:t></w:r>');
    // the italic run that only held part of the token is gone; the trailing comma run survives
    expect(res.xml).not.toContain("ient Na");
    expect(res.xml).toContain('<w:t xml:space="preserve">,</w:t>');
    const texts = partParagraphs(parseXml(res.xml).root).map((p) => p.text);
    expect(texts).toContain("Dear Ada <Lovelace> & Co,");
    expect(texts).toContain('We invite Zeta "Media" Ltd & its brands to the sample network in [Market].');
  });

  it("leaves the part untouched when nothing matches", () => {
    const res = substitutePart(xml, "word/document.xml", [{ type: "literal", find: "[Nope]", value: "x", key: "k" }]);
    expect(res.replaced).toBe(0);
    expect(res.xml).toBe(xml);
  });

  it("fills a tab-blank, turning the first tab into text in the same (underlined) run", () => {
    const doc = documentXml(para(run("Title:") + tab('<w:u w:val="single"/>') + tab('<w:u w:val="single"/>')));
    const p = partParagraphs(parseXml(doc).root)[0]!;
    expect(p.text).toBe("Title:\t\t");
    const res = substitutePart(doc, "d", [{ type: "positional", part: "d", ordinal: 0, start: 6, end: 8, expect: "\t\t", value: "CEO", key: "signatoryTitle" }]);
    expect(res.xml).toContain('<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">CEO</w:t></w:r>');
    expect(partParagraphs(parseXml(res.xml).root)[0]!.text).toBe("Title:CEO");
  });

  it("ignores deleted revisions and tab-stop definitions", () => {
    const doc = documentXml(
      `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${run("A")}<w:del><w:r><w:delText>gone</w:delText></w:r></w:del>${run("B")}</w:p>`,
    );
    expect(partParagraphs(parseXml(doc).root)[0]!.text).toBe("AB");
  });
});

describe("detectPlaceholders", () => {
  const analysis = analyzeParts([{ name: "word/document.xml", xml: documentXml(SAMPLE_BODY) }]);
  const byText = (t: string) => analysis.candidates.find((c) => c.text === t);

  it("finds bracket tokens (also split across runs), dates, underscores and tab-blanks", () => {
    expect(byText("[Recipient Name]")).toMatchObject({ kind: "bracket", suggested: "recipientName", id: "lit:[Recipient Name]" });
    expect(byText("[Company]")).toMatchObject({ kind: "bracket", suggested: "companyLegalName" });
    expect(byText("[Market]")).toMatchObject({ suggested: "region" });
    expect(byText("March 3rd, 2031")).toMatchObject({ kind: "date", suggested: "letterDate" });
    expect(byText("May 9, 2031")).toMatchObject({ kind: "date", suggested: "ndaEffectiveDate" });
    const underscores = analysis.candidates.filter((c) => c.kind === "underscore");
    expect(underscores.map((u) => u.suggested)).toEqual(["signatoryName", "ignore"]); // "Name:" vs "By:"
    expect(analysis.candidates.find((c) => c.kind === "tabs")).toMatchObject({ text: "\t\t", suggested: "signatoryTitle" });
  });

  it("skips numeric references and merges repeated tokens", () => {
    const c = detectPlaceholders([{ name: "d", paragraphs: [{ ordinal: 0, text: "See [1] and [X]" }, { ordinal: 1, text: "[X] again" }] }]);
    expect(c.map((x) => x.text)).toEqual(["[X]"]);
    expect(c[0]!.occurrences).toBe(2);
  });

  it("custom tokens must exist in the document", () => {
    expect(customCandidate(analysis.texts, "sample network")).toMatchObject({ id: "lit:sample network", occurrences: 1 });
    expect(customCandidate(analysis.texts, "not in the doc")).toBeNull();
  });

  it("suggests from generic words only", () => {
    expect(suggestFor("Signature", "underscore")).toBe("ignore");
    expect(suggestFor("cc", "bracket")).toBe("ccLine");
    expect(suggestFor("Legal entity", "bracket")).toBe("companyLegalName");
    expect(suggestFor("whatever", "bracket")).toBe("ignore");
  });

  it("parses tables into the analysis", () => {
    expect(analysis.tierTables).toHaveLength(1);
    expect(analysis.tierTables[0]!.title).toBe("Audience schedule:");
    const root = parseXml(documentXml(SAMPLE_BODY)).root;
    const t = partTables(root, partParagraphs(root));
    expect(t[0]!.rows[1]).toEqual([">90M", "61%", "39%"]);
  });
});

describe("dates", () => {
  it("formats in the template's own style", () => {
    expect(formatDateLike("March 3rd, 2031", "2026-10-01")).toBe("October 1st, 2026");
    expect(formatDateLike("May 9, 2031", "2026-10-22")).toBe("October 22, 2026");
    expect(formatDateLike("9 May 2031", "2026-10-02")).toBe("2 October 2026");
    expect(formatDateLike("3rd of March, 2031", "2026-10-13")).toBe("13th of October, 2026");
    expect(formatDateLike("Sept. 3, 2031", "2026-09-30")).toBe("Sept. 30, 2026");
    expect(formatDateLike("Mar 3 2031", "2026-12-25")).toBe("Dec 25 2026");
    expect(formatDateLike(null, "2026-01-02")).toBe("January 2, 2026");
  });

  it("rejects invalid ISO dates", () => {
    expect(parseIsoDate("2026-02-30")).toBeNull();
    expect(formatDateLike(null, "not a date")).toBe("not a date");
  });
});

describe("preview", () => {
  it("marks substituted values and keeps run formatting", () => {
    const blocks = previewPart(documentXml(SAMPLE_BODY), "word/document.xml", [
      { type: "literal", find: "[Recipient Name]", value: "<script>x</script>", key: "recipientName" },
    ]);
    const dear = blocks.find((b) => b.type === "p" && b.spans.some((s) => s.mark));
    expect(dear?.type).toBe("p");
    if (dear?.type !== "p") return;
    expect(dear.spans.map((s) => [s.text, s.mark ?? null, s.b])).toEqual([
      ["Dear ", null, false],
      ["<script>x</script>", "recipientName", true],
      [",", null, false],
    ]);
    expect(blocks[0]).toMatchObject({ type: "p", heading: 0 });
    expect(blocks.find((b) => b.type === "table")).toBeTruthy();
  });
});

describe("safeFilename", () => {
  it("strips paths, quotes, control characters and non-ASCII", () => {
    expect(safeFilename("Coalition term sheet – Zéta Média v2")).toBe("Coalition-term-sheet-Zeta-Media-v2.docx");
    expect(safeFilename('../../etc/"passwd"\r\n')).toBe("etc-passwd.docx");
    expect(safeFilename("   ")).toBe("document.docx");
    expect(safeFilename("a".repeat(300)).length).toBeLessThanOrEqual(125);
    expect(attachmentDisposition('x"y.docx')).toBe(`attachment; filename="x-y.docx"; filename*=UTF-8''x-y.docx`);
  });
});
