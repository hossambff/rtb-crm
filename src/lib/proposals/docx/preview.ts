/**
 * HTML preview model of a Word part (pure). Produces plain data (strings + flags) that React renders as text nodes —
 * never HTML strings — so document content and substituted values are always escaped by React.
 */
import { childElements, firstChild, parseXml, type XElement } from "./xml";
import { cellsOf, paragraphFormat, partParagraphs, rowsOf, runFormat, type Paragraph, type RunFormat } from "./ooxml";
import { applyMatches, matchesFor, type Rule } from "./substitute";

export type Span = RunFormat & { text: string; mark?: string };
export type PBlock = { type: "p"; align: "left" | "center" | "right" | "justify"; heading: number | null; list: boolean; indent: number; spans: Span[] };
export type TBlock = { type: "table"; rows: PBlock[][][] };
export type Block = PBlock | TBlock;

const MAX_BLOCKS = 6000;

function paragraphBlock(p: Paragraph, part: string, rules: Rule[]): PBlock {
  const fmt = paragraphFormat(p.el);
  const ms = p.text ? matchesFor(part, p, rules) : [];
  const { texts, marks } = applyMatches(
    p.segments.map((s) => s.text),
    ms,
  );
  const spans: Span[] = [];
  const pushSpan = (s: Span) => {
    if (!s.text) return;
    const last = spans[spans.length - 1];
    if (last && !last.mark && !s.mark && last.b === s.b && last.i === s.i && last.u === s.u && last.caps === s.caps) last.text += s.text;
    else spans.push(s);
  };
  p.segments.forEach((seg, idx) => {
    const text = texts[idx] ?? "";
    const f = runFormat(seg.run);
    let cursor = 0;
    for (const m of marks[idx] ?? []) {
      pushSpan({ ...f, text: text.slice(cursor, m.start) });
      pushSpan({ ...f, text: text.slice(m.start, m.end), mark: m.key });
      cursor = m.end;
    }
    pushSpan({ ...f, text: text.slice(cursor) });
  });
  return { type: "p", align: fmt.align, heading: fmt.heading, list: fmt.list, indent: fmt.indent, spans };
}

/** Blocks of a part (body of document.xml, or a header/footer) with substitutions applied and marked. */
export function previewPart(xml: string, part: string, rules: Rule[]): Block[] {
  const doc = parseXml(xml);
  const paragraphs = partParagraphs(doc.root);
  const byEl = new Map(paragraphs.map((p) => [p.el, p] as const));
  const container = firstChild(doc.root, "w:body") ?? doc.root;
  const out: Block[] = [];
  let count = 0;

  const cellParagraphs = (el: XElement, acc: PBlock[]) => {
    for (const c of childElements(el)) {
      if (++count > MAX_BLOCKS) return;
      if (c.name === "w:p") {
        const p = byEl.get(c);
        if (p) acc.push(paragraphBlock(p, part, rules));
      } else if (c.name === "w:tbl") {
        // nested table: flatten its cells' paragraphs into the outer cell
        for (const tr of rowsOf(c)) for (const tc of cellsOf(tr)) cellParagraphs(tc, acc);
      } else if (c.name === "w:sdt") {
        const content = firstChild(c, "w:sdtContent");
        if (content) cellParagraphs(content, acc);
      }
    }
  };

  const visit = (el: XElement) => {
    for (const c of childElements(el)) {
      if (++count > MAX_BLOCKS) return;
      if (c.name === "w:p") {
        const p = byEl.get(c);
        if (p) out.push(paragraphBlock(p, part, rules));
      } else if (c.name === "w:tbl") {
        const rows: PBlock[][][] = [];
        for (const tr of rowsOf(c)) {
          const cells: PBlock[][] = [];
          for (const tc of cellsOf(tr)) {
            const acc: PBlock[] = [];
            cellParagraphs(tc, acc);
            cells.push(acc);
          }
          rows.push(cells);
        }
        out.push({ type: "table", rows });
      } else if (c.name === "w:sdt") {
        const content = firstChild(c, "w:sdtContent");
        if (content) visit(content);
      }
    }
  };
  visit(container);
  return out;
}

/** True when a block list has no visible text (e.g. an empty header). */
export function blocksEmpty(blocks: Block[]): boolean {
  return blocks.every((b) => (b.type === "p" ? b.spans.every((s) => !s.text.trim()) : b.rows.every((r) => r.every((c) => blocksEmpty(c)))));
}
