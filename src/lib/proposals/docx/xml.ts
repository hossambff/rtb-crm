/**
 * Minimal, lossless XML tree for OOXML parts (pure — no DOM, no dependencies, unit tested).
 *
 * Why not a DOM parser: Node has none built in, and we must re-serialize Word XML byte-for-byte except where we
 * deliberately substitute text. Each element keeps its raw attribute text, so untouched markup round-trips exactly.
 *
 * Safety: DOCTYPE / ENTITY declarations are rejected (no entity expansion → no XXE or "billion laughs"); only the five
 * predefined entities and numeric character references are accepted; depth and node counts are capped.
 */

export type XElement = { type: "el"; name: string; attrs: string; selfClosing: boolean; children: XNode[]; parent: XElement | null };
export type XText = { type: "text"; raw: string };
/** Comments, processing instructions and CDATA — kept verbatim, never interpreted. */
export type XRaw = { type: "raw"; raw: string };
export type XNode = XElement | XText | XRaw;
export type XDocument = { prolog: XNode[]; root: XElement; epilog: XNode[] };

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

const MAX_DEPTH = 256;
const MAX_NODES = 2_000_000;
const NAME_RE = /^[A-Za-z_][\w.:-]*$/;

const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[\w.:-]/;

/** Linear-time check of a start tag's attribute text: ( ws+ name ws* = ws* quoted-value )* ws* */
function validAttrs(a: string): boolean {
  let i = 0;
  const n = a.length;
  for (;;) {
    const ws0 = i;
    while (i < n && isWs(a[i]!)) i++;
    if (i === n) return true;
    if (i === ws0 || !NAME_START.test(a[i]!)) return false;
    while (i < n && NAME_CHAR.test(a[i]!)) i++;
    while (i < n && isWs(a[i]!)) i++;
    if (a[i] !== "=") return false;
    i++;
    while (i < n && isWs(a[i]!)) i++;
    const q = a[i];
    if (q !== '"' && q !== "'") return false;
    const end = a.indexOf(q, i + 1);
    if (end === -1) return false;
    if (a.slice(i + 1, end).includes("<")) return false;
    i = end + 1;
  }
}
const ENTITY_RE = /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|([A-Za-z][\w.-]*));?/g;

function checkText(raw: string) {
  // Every "&" must start a well-formed reference to a predefined entity or a character reference.
  for (const m of raw.matchAll(ENTITY_RE)) {
    if (!m[0].endsWith(";")) throw new XmlError("Malformed entity reference");
    if (m[3] && !["lt", "gt", "amp", "quot", "apos"].includes(m[3])) throw new XmlError(`Undeclared entity &${m[3]};`);
  }
  const amps = raw.split("&").length - 1;
  const refs = [...raw.matchAll(ENTITY_RE)].length;
  if (amps !== refs) throw new XmlError("Bare '&' in text");
  if (raw.includes("<")) throw new XmlError("Bare '<' in text");
}

/** Parse an XML document. Throws XmlError on anything that is not well-formed (or uses a DOCTYPE). */
export function parseXml(src: string): XDocument {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const prolog: XNode[] = [];
  const epilog: XNode[] = [];
  let root: XElement | null = null;
  const stack: XElement[] = [];
  let i = 0;
  let nodes = 0;
  const push = (n: XNode) => {
    if (++nodes > MAX_NODES) throw new XmlError("Document too large");
    const top = stack[stack.length - 1];
    if (top) top.children.push(n);
    else if (n.type === "el") {
      if (root) throw new XmlError("More than one root element");
      root = n;
    } else {
      if (n.type === "text" && n.raw.trim()) throw new XmlError("Text outside the root element");
      (root ? epilog : prolog).push(n); // whitespace between prolog items is kept verbatim
    }
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      push({ type: "text", raw: src.slice(i) });
      break;
    }
    if (lt > i) {
      const raw = src.slice(i, lt);
      checkText(raw);
      push({ type: "text", raw });
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end === -1) throw new XmlError("Unterminated processing instruction");
      push({ type: "raw", raw: src.slice(lt, end + 2) });
      i = end + 2;
    } else if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end === -1) throw new XmlError("Unterminated comment");
      push({ type: "raw", raw: src.slice(lt, end + 3) });
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      if (!stack.length) throw new XmlError("CDATA outside the root element");
      const end = src.indexOf("]]>", lt + 9);
      if (end === -1) throw new XmlError("Unterminated CDATA");
      push({ type: "raw", raw: src.slice(lt, end + 3) });
      i = end + 3;
    } else if (src.startsWith("<!", lt)) {
      throw new XmlError("DOCTYPE and entity declarations are not allowed");
    } else if (src.startsWith("</", lt)) {
      const end = src.indexOf(">", lt + 2);
      if (end === -1) throw new XmlError("Unterminated end tag");
      const name = src.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top || top.name !== name) throw new XmlError(`Mismatched end tag </${name}>`);
      i = end + 1;
    } else {
      // Start tag: scan to the closing '>' outside quoted attribute values.
      let j = lt + 1;
      let quote: string | null = null;
      for (; j < src.length; j++) {
        const c = src[j]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
        else if (c === "<") throw new XmlError("'<' inside a tag");
      }
      if (j >= src.length) throw new XmlError("Unterminated start tag");
      let inner = src.slice(lt + 1, j);
      const selfClosing = inner.endsWith("/");
      if (selfClosing) inner = inner.slice(0, -1);
      const nameMatch = /^[^\s/>]+/.exec(inner);
      const name = nameMatch?.[0] ?? "";
      if (!NAME_RE.test(name)) throw new XmlError(`Invalid element name "${name.slice(0, 40)}"`);
      const attrs = inner.slice(name.length);
      if (!validAttrs(attrs)) throw new XmlError(`Malformed attributes on <${name}>`);
      for (const m of attrs.matchAll(/=\s*(?:"([^"]*)"|'([^']*)')/g)) checkText(m[1] ?? m[2] ?? "");
      const el: XElement = { type: "el", name, attrs, selfClosing, children: [], parent: stack[stack.length - 1] ?? null };
      if (!stack.length && root) throw new XmlError("More than one root element");
      push(el);
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) throw new XmlError("Document nested too deeply");
        stack.push(el);
      }
      i = j + 1;
    }
  }
  if (stack.length) throw new XmlError(`Unclosed element <${stack[stack.length - 1]!.name}>`);
  if (!root) throw new XmlError("No root element");
  return { prolog, root, epilog };
}

function serializeNode(n: XNode, out: string[]) {
  if (n.type !== "el") {
    out.push(n.raw);
    return;
  }
  if (n.selfClosing && n.children.length === 0) {
    out.push(`<${n.name}${n.attrs}/>`);
    return;
  }
  out.push(`<${n.name}${n.attrs}>`);
  for (const c of n.children) serializeNode(c, out);
  out.push(`</${n.name}>`);
}

export function serializeXml(doc: XDocument): string {
  const out: string[] = [];
  for (const n of doc.prolog) serializeNode(n, out);
  serializeNode(doc.root, out);
  for (const n of doc.epilog) serializeNode(n, out);
  return out.join("");
}

export function decodeEntities(raw: string): string {
  return raw.replace(ENTITY_RE, (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec || hex) {
      const cp = dec ? Number(dec) : parseInt(hex!, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    switch (name) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return m;
    }
  });
}

// XML 1.0 forbids most C0 controls; strip them (and lone surrogates) from anything we write.
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function escapeXmlText(s: string): string {
  return s.replace(INVALID_XML_CHARS, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Raw attribute value lookup (decoded), e.g. attr(el, "w:val"). */
export function attr(el: XElement, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(el.attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? "") : null;
}

/** Set (or add) an attribute; value is escaped. */
export function setAttr(el: XElement, name: string, value: string) {
  const re = new RegExp(`(\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(?:"[^"]*"|'[^']*')`);
  const next = `${name}="${escapeXmlAttr(value)}"`;
  el.attrs = re.test(el.attrs) ? el.attrs.replace(re, `$1${next}`) : `${el.attrs} ${next}`;
}

export function childElements(el: XElement, name?: string): XElement[] {
  return el.children.filter((c): c is XElement => c.type === "el" && (name === undefined || c.name === name));
}

export function firstChild(el: XElement, name: string): XElement | null {
  return childElements(el, name)[0] ?? null;
}

/** Decoded text of an element's direct text children (what a <w:t> holds). */
export function ownText(el: XElement): string {
  return el.children.map((c) => (c.type === "text" ? decodeEntities(c.raw) : "")).join("");
}

/** Replace an element's children with a single (escaped) text node. */
export function setOwnText(el: XElement, text: string) {
  el.children = text ? [{ type: "text", raw: escapeXmlText(text) }] : [];
  el.selfClosing = false;
}

/** Pre-order walk over elements. Return false from `visit` to skip an element's subtree. */
export function walk(el: XElement, visit: (el: XElement) => boolean | void) {
  const stack: XElement[] = [el];
  while (stack.length) {
    const cur = stack.pop()!;
    if (visit(cur) === false) continue;
    for (let k = cur.children.length - 1; k >= 0; k--) {
      const c = cur.children[k]!;
      if (c.type === "el") stack.push(c);
    }
  }
}

export function removeChild(parent: XElement, child: XNode) {
  const idx = parent.children.indexOf(child);
  if (idx >= 0) parent.children.splice(idx, 1);
}
