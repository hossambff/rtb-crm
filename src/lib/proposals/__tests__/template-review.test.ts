import { describe, expect, it } from "vitest";
import { assertSafePackage, openDocx, packageRisks, readTextParts } from "../docx/package";
import { templateReviewBlockers, type FieldMapEntry, type TemplateParsed } from "../termsheet";
import { buildDocx } from "./docx-fixture";

const mapped: FieldMapEntry[] = [{ token: "[Name]", input: "recipientName", occurrences: 1 }];
const ignored: FieldMapEntry[] = [{ token: "[Name]", input: "ignore", occurrences: 1 }];
const tierTable = { index: 0, title: "Revenue share", headers: [], tiers: [], columnsGuessed: true };

describe("term sheet templates go live only after review (QA MAJ-19)", () => {
  it("a fresh upload (suggestions only) is a draft", () => {
    const parsed: TemplateParsed = { tierTables: [tierTable], tiersReviewed: false, mappingReviewed: false };
    const b = templateReviewBlockers({ fieldMap: mapped, parsed });
    expect(b).toHaveLength(2);
    expect(b.join(" ")).toMatch(/field mapping/);
    expect(b.join(" ")).toMatch(/tiers/);
  });
  it("needs at least one mapped placeholder", () => {
    expect(templateReviewBlockers({ fieldMap: ignored, parsed: { mappingReviewed: true } })[0]).toMatch(/Map at least one/);
  });
  it("tiers must be reviewed when the document has a tier table", () => {
    expect(templateReviewBlockers({ fieldMap: mapped, parsed: { mappingReviewed: true, tierTables: [tierTable] } })).toHaveLength(1);
    expect(templateReviewBlockers({ fieldMap: mapped, parsed: { mappingReviewed: true, tierTables: [tierTable], tiersReviewed: true } })).toEqual([]);
  });
  it("a template without tiers is ready once the mapping is reviewed", () => {
    expect(templateReviewBlockers({ fieldMap: mapped, parsed: { mappingReviewed: true } })).toEqual([]);
  });
});

describe("unsafe packages are refused on upload (SEC L-6)", () => {
  const rel = (type: string, target: string, external = false) =>
    `<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/></Relationships>`;
  it("allows hyperlinks, refuses remote templates/images, OLE, alt-chunks and embeddings", () => {
    expect(packageRisks(["word/document.xml"], [{ name: "word/_rels/document.xml.rels", xml: rel("hyperlink", "https://roundtable.io", true) }])).toEqual([]);
    expect(packageRisks([], [{ name: "word/_rels/settings.xml.rels", xml: rel("attachedTemplate", "\\\\evil\\share\\t.dotm", true) }])).toHaveLength(1);
    expect(packageRisks([], [{ name: "x.rels", xml: rel("image", "http://tracker.example/p.png", true) }])[0]).toMatch(/outside files/);
    expect(packageRisks([], [{ name: "x.rels", xml: rel("aFChunk", "chunk.html") }])[0]).toMatch(/embedded or linked/);
    expect(packageRisks(["word/embeddings/oleObject1.bin"], [])[0]).toMatch(/embedded objects/);
  });
  it("assertSafePackage passes a clean document and rejects an external template", async () => {
    await expect(assertSafePackage(await openDocx(await buildDocx()))).resolves.toBeUndefined();
    const evil = await buildDocx({ extra: { "word/_rels/settings.xml.rels": rel("attachedTemplate", "http://evil.example/t.dotm", true) } });
    await expect(assertSafePackage(await openDocx(evil))).rejects.toThrow(/outside files|linked documents/);
  });
});

describe("footnotes are filled too (code review L12)", () => {
  it("reads footnotes and endnotes as text parts", async () => {
    const notes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>[Name]</w:t></w:r></w:p></w:footnote></w:footnotes>`;
    const zip = await openDocx(await buildDocx({ extra: { "word/footnotes.xml": notes } }));
    expect((await readTextParts(zip)).map((p) => p.name)).toContain("word/footnotes.xml");
  });
});
