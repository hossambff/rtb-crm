/**
 * WordprocessingML text model (pure). Turns a parsed part (document/header/footer XML) into paragraphs made of
 * editable "segments" — the <w:t> text and <w:tab/> / <w:br/> children of runs — so placeholder detection,
 * substitution and the HTML preview all see exactly the same text with exactly the same offsets.
 */
import { attr, childElements, firstChild, ownText, walk, type XElement } from "./xml";

export type SegmentKind = "text" | "tab" | "break";
export type Segment = { kind: SegmentKind; el: XElement; run: XElement; text: string };
export type Paragraph = {
  /** Ordinal of this <w:p> in document order within the part (stable for a given file). */
  ordinal: number;
  el: XElement;
  segments: Segment[];
  text: string;
  /** Inside mc:Fallback (a duplicate rendering of a shape's text): substituted, but not detected/previewed. */
  fallback: boolean;
};

/** Containers whose text is not visible document text (deleted revisions, moved-from text). */
const SKIP_IN_PARAGRAPH = new Set(["w:p", "w:pPr", "w:rPr", "w:del", "w:moveFrom", "mc:Fallback", "w:fldData"]);

function isUnder(el: XElement, name: string): boolean {
  for (let p = el.parent; p; p = p.parent) if (p.name === name) return true;
  return false;
}

/** Segments of one paragraph, in order, not descending into nested paragraphs (text boxes are their own paragraphs). */
export function paragraphSegments(p: XElement): Segment[] {
  const out: Segment[] = [];
  const visit = (el: XElement) => {
    for (const c of el.children) {
      if (c.type !== "el") continue;
      if (SKIP_IN_PARAGRAPH.has(c.name)) continue;
      if (c.name === "w:r") {
        for (const rc of childElements(c)) {
          if (rc.name === "w:t") out.push({ kind: "text", el: rc, run: c, text: ownText(rc) });
          else if (rc.name === "w:tab") out.push({ kind: "tab", el: rc, run: c, text: "\t" });
          else if (rc.name === "w:br" || rc.name === "w:cr") {
            // page/column breaks render as nothing inside a line of text
            const t = attr(rc, "w:type");
            out.push({ kind: "break", el: rc, run: c, text: t === "page" || t === "column" ? "" : "\n" });
          } else if (rc.name === "w:noBreakHyphen") out.push({ kind: "break", el: rc, run: c, text: "-" });
        }
        continue;
      }
      visit(c);
    }
  };
  visit(p);
  return out;
}

/** All paragraphs of a part in document order (including those in tables, text boxes and fallbacks). */
export function partParagraphs(root: XElement): Paragraph[] {
  const out: Paragraph[] = [];
  walk(root, (el) => {
    if (el.name === "w:p") {
      const segments = paragraphSegments(el);
      out.push({ ordinal: out.length, el, segments, text: segments.map((s) => s.text).join(""), fallback: isUnder(el, "mc:Fallback") });
    }
  });
  return out;
}

export type TableModel = { el: XElement; rows: string[][]; title: string };

/** Tables (top-level and nested) with each cell's plain text; `title` = nearest preceding non-empty paragraph. */
export function partTables(root: XElement, paragraphs: Paragraph[]): TableModel[] {
  const byEl = new Map(paragraphs.map((p) => [p.el, p] as const));
  const out: TableModel[] = [];
  let lastText = "";
  walk(root, (el) => {
    if (el.name === "w:p") {
      const p = byEl.get(el);
      if (p && p.text.trim() && !isUnder(el, "w:tbl")) lastText = p.text.trim();
      return;
    }
    if (el.name !== "w:tbl") return;
    const rows: string[][] = [];
    for (const tr of rowsOf(el)) {
      const cells: string[] = [];
      for (const tc of cellsOf(tr)) {
        const texts: string[] = [];
        walk(tc, (x) => {
          if (x.name === "w:p") {
            const p = byEl.get(x);
            if (p && !p.fallback) texts.push(p.text);
          }
        });
        cells.push(texts.join(" ").replace(/\s+/g, " ").trim());
      }
      rows.push(cells);
    }
    out.push({ el, rows, title: lastText.slice(0, 160) });
  });
  return out;
}

/** Table rows, looking through content controls (w:sdt / w:sdtContent) that may wrap them. */
export function rowsOf(tbl: XElement): XElement[] {
  const out: XElement[] = [];
  for (const c of childElements(tbl)) {
    if (c.name === "w:tr") out.push(c);
    else if (c.name === "w:sdt") {
      const content = firstChild(c, "w:sdtContent");
      if (content) out.push(...childElements(content, "w:tr"));
    }
  }
  return out;
}

export function cellsOf(tr: XElement): XElement[] {
  const out: XElement[] = [];
  for (const c of childElements(tr)) {
    if (c.name === "w:tc") out.push(c);
    else if (c.name === "w:sdt") {
      const content = firstChild(c, "w:sdtContent");
      if (content) out.push(...childElements(content, "w:tc"));
    }
  }
  return out;
}

/* ───────────── Run formatting (for the preview) ───────────── */

export type RunFormat = { b: boolean; i: boolean; u: boolean; caps: boolean };

function onOff(el: XElement | null): boolean {
  if (!el) return false;
  const v = attr(el, "w:val");
  return v === null || !["0", "false", "off", "none"].includes(v.toLowerCase());
}

export function runFormat(run: XElement): RunFormat {
  const rPr = firstChild(run, "w:rPr");
  if (!rPr) return { b: false, i: false, u: false, caps: false };
  return { b: onOff(firstChild(rPr, "w:b")), i: onOff(firstChild(rPr, "w:i")), u: onOff(firstChild(rPr, "w:u")), caps: onOff(firstChild(rPr, "w:caps")) };
}

export type ParagraphFormat = { style: string | null; align: "left" | "center" | "right" | "justify"; heading: number | null; list: boolean; indent: number };

export function paragraphFormat(p: XElement): ParagraphFormat {
  const pPr = firstChild(p, "w:pPr");
  const style = pPr ? attr(firstChild(pPr, "w:pStyle") ?? p, "w:val") : null;
  const jc = pPr ? attr(firstChild(pPr, "w:jc") ?? p, "w:val") : null;
  const align = jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : jc === "both" || jc === "distribute" ? "justify" : "left";
  let heading: number | null = null;
  if (style) {
    const m = /heading\s*([1-6])/i.exec(style);
    if (m) heading = Number(m[1]);
    else if (/^title$/i.test(style)) heading = 0;
    else if (/^subtitle$/i.test(style)) heading = 3;
  }
  const ind = pPr ? firstChild(pPr, "w:ind") : null;
  const left = ind ? Number(attr(ind, "w:left") ?? attr(ind, "w:start") ?? 0) : 0;
  return { style, align, heading, list: Boolean(pPr && firstChild(pPr, "w:numPr")), indent: Number.isFinite(left) ? Math.max(0, Math.min(left / 720, 6)) : 0 };
}
