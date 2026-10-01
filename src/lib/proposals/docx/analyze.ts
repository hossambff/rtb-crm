/** Template analysis on upload (pure): paragraph texts → placeholder candidates; tables → revenue-share tier tables. */
import { parseXml } from "./xml";
import { partParagraphs, partTables } from "./ooxml";
import { detectPlaceholders, type Candidate, type PartText } from "./detect";
import { parseTierTable, type TierTable } from "./tiers";

export type Analysis = { candidates: Candidate[]; tierTables: TierTable[]; texts: PartText[]; stats: { paragraphs: number; tables: number; bytes: number } };

export function partTexts(parts: { name: string; xml: string }[]): PartText[] {
  return parts.map(({ name, xml }) => ({
    name,
    paragraphs: partParagraphs(parseXml(xml).root).map((p) => ({ ordinal: p.ordinal, text: p.text, fallback: p.fallback })),
  }));
}

export function analyzeParts(parts: { name: string; xml: string }[]): Analysis {
  const texts: PartText[] = [];
  const tierTables: TierTable[] = [];
  let tables = 0;
  let bytes = 0;
  for (const { name, xml } of parts) {
    bytes += xml.length;
    const doc = parseXml(xml);
    const paragraphs = partParagraphs(doc.root);
    texts.push({ name, paragraphs: paragraphs.map((p) => ({ ordinal: p.ordinal, text: p.text, fallback: p.fallback })) });
    if (name !== "word/document.xml") continue;
    const ts = partTables(doc.root, paragraphs);
    tables += ts.length;
    ts.forEach((t, idx) => {
      const parsed = parseTierTable(t.rows, idx, t.title);
      if (parsed) tierTables.push(parsed);
    });
  }
  const paragraphs = texts.reduce((a, t) => a + t.paragraphs.length, 0);
  return { candidates: detectPlaceholders(texts), tierTables: tierTables.slice(0, 20), texts, stats: { paragraphs, tables, bytes } };
}
