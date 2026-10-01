/**
 * Placeholder substitution (pure, unit tested).
 *
 * A token may be split across several runs ("[Na" + "me]" — Word does this after spell-check or partial formatting).
 * We never rebuild a paragraph: only the segments that contain part of a match change. The value goes into the
 * segment where the match starts (so it inherits that run's rPr formatting), matched characters are removed from the
 * following segments, and every other run, property and element is left byte-for-byte untouched.
 */
import { parseXml, removeChild, serializeXml, setAttr, setOwnText, type XElement } from "./xml";
import { partParagraphs, type Paragraph } from "./ooxml";

export type Match = { start: number; end: number; value: string; key: string };
export type Mark = { start: number; end: number; key: string };

/**
 * Apply non-overlapping matches (offsets into the concatenation of `segs`) and return each segment's new text plus
 * where the inserted values landed (offsets within that segment's new text).
 */
export function applyMatches(segs: string[], matches: Match[]): { texts: string[]; marks: Mark[][] } {
  const sorted = resolveOverlaps(matches);
  const texts: string[] = [];
  const marks: Mark[][] = [];
  let offset = 0;
  for (const seg of segs) {
    const a = offset;
    const b = offset + seg.length;
    offset = b;
    let out = "";
    const segMarks: Mark[] = [];
    let cursor = a;
    for (const m of sorted) {
      if (m.end <= a || m.start >= b) {
        // A match that starts exactly at this segment's start but this segment is empty is handled by its own segment.
        continue;
      }
      if (m.start > cursor) out += seg.slice(cursor - a, m.start - a);
      if (m.start >= a) {
        segMarks.push({ start: out.length, end: out.length + m.value.length, key: m.key });
        out += m.value;
      }
      cursor = Math.min(b, m.end);
    }
    if (cursor < b) out += seg.slice(cursor - a);
    texts.push(out);
    marks.push(segMarks);
  }
  return { texts, marks };
}

/** Sort by start; on overlap keep the earlier (then longer) match. Empty matches are dropped. */
export function resolveOverlaps(matches: Match[]): Match[] {
  const sorted = matches.filter((m) => m.end > m.start).sort((x, y) => x.start - y.start || y.end - x.end);
  const out: Match[] = [];
  let lastEnd = -1;
  for (const m of sorted) {
    if (m.start < lastEnd) continue;
    out.push(m);
    lastEnd = m.end;
  }
  return out;
}

/* ───────────── Rules → matches ───────────── */

/** Replace every occurrence of `find` (literal text, may span runs) in every paragraph of every part. */
export type LiteralRule = { type: "literal"; find: string; value: string; key: string };
/** Replace one exact occurrence: paragraph `ordinal` of `part`, characters [start, end) which must equal `expect`. */
export type PositionalRule = { type: "positional"; part: string; ordinal: number; start: number; end: number; expect: string; value: string; key: string };
export type Rule = LiteralRule | PositionalRule;

export function findAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

/** Matches for one paragraph. Positional rules take precedence over literal ones where they overlap. */
export function matchesFor(part: string, p: { ordinal: number; text: string }, rules: Rule[]): Match[] {
  const positional: Match[] = [];
  const literal: Match[] = [];
  for (const r of rules) {
    if (r.type === "positional") {
      if (r.part === part && r.ordinal === p.ordinal && p.text.slice(r.start, r.end) === r.expect)
        positional.push({ start: r.start, end: r.end, value: r.value, key: r.key });
    } else {
      for (const at of findAll(p.text, r.find)) literal.push({ start: at, end: at + r.find.length, value: r.value, key: r.key });
    }
  }
  const pos = resolveOverlaps(positional);
  const free = literal.filter((m) => !pos.some((q) => m.start < q.end && q.start < m.end));
  return resolveOverlaps([...pos, ...free]);
}

/* ───────────── Applying to XML ───────────── */

function isOnlyPropsAndEmpty(run: XElement): boolean {
  return run.children.every((c) => (c.type === "el" ? c.name === "w:rPr" || (c.name === "w:t" && c.children.length === 0) : !c.raw.trim()));
}

/** Write new segment texts back into a paragraph's XML (only segments whose text changed are touched). */
export function writeParagraph(p: Paragraph, texts: string[]): number {
  let changed = 0;
  p.segments.forEach((seg, idx) => {
    const next = texts[idx] ?? seg.text;
    if (next === seg.text) return;
    changed++;
    if (seg.kind === "text") {
      setOwnText(seg.el, next);
      setAttr(seg.el, "xml:space", "preserve");
    } else if (next === "") {
      removeChild(seg.run, seg.el);
    } else {
      // A tab/break that now holds a value becomes a text element in the same run (same formatting).
      seg.el.name = "w:t";
      seg.el.attrs = ' xml:space="preserve"';
      setOwnText(seg.el, next);
    }
    // Tidy: a run left with nothing but properties and an empty <w:t/> is removed (never runs with other content).
    if (next === "" && isOnlyPropsAndEmpty(seg.run) && seg.run.parent) removeChild(seg.run.parent, seg.run);
  });
  return changed;
}

export type PartResult = { xml: string; replaced: number; keys: Record<string, number> };

/** Substitute rules in one part's XML. Throws XmlError if the input is not well-formed. */
export function substitutePart(xml: string, part: string, rules: Rule[]): PartResult {
  const doc = parseXml(xml);
  let replaced = 0;
  const keys: Record<string, number> = {};
  for (const p of partParagraphs(doc.root)) {
    if (!p.text) continue;
    const ms = matchesFor(part, p, rules);
    if (!ms.length) continue;
    const { texts } = applyMatches(
      p.segments.map((s) => s.text),
      ms,
    );
    writeParagraph(p, texts);
    replaced += ms.length;
    for (const m of ms) keys[m.key] = (keys[m.key] ?? 0) + 1;
  }
  if (!replaced) return { xml, replaced, keys };
  const out = serializeXml(doc);
  parseXml(out); // never emit a part we could not parse back
  return { xml: out, replaced, keys };
}
