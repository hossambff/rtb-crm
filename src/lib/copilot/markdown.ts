/**
 * Tiny, safe markdown for Copilot answers (client-safe, pure).
 * Supports: paragraphs, headings, bullet/numbered lists, blockquotes, fenced code, inline code, bold, italic, links,
 * horizontal rules and simple pipe tables. There is NO raw-HTML path: everything becomes React text nodes, and link
 * targets are allow-listed (http/https/mailto or same-origin paths).
 */
import { createElement, Fragment, type ComponentType, type ReactNode } from "react";

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "p"; children: Inline[] }
  | { type: "h"; level: number; children: Inline[] }
  | { type: "ul" | "ol"; items: Inline[][] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; children: Inline[] }
  | { type: "hr" }
  | { type: "table"; header: Inline[][]; rows: Inline[][][] };

/** Returns a safe href or null. Relative app paths must start with a single "/". */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (!href) return null;
  // strip control chars / whitespace that browsers ignore inside schemes (e.g. "java\tscript:")
  const compact = href.replace(/[\u0000-\u001F\u007F\s]+/g, "");
  if (/^\/(?!\/)/.test(compact)) return compact;
  if (/^(https?:\/\/|mailto:)/i.test(compact)) return compact;
  return null;
}

const INLINE_RULES: { re: RegExp; make: (m: RegExpExecArray) => Inline }[] = [
  { re: /`([^`\n]+)`/, make: (m) => ({ type: "code", text: m[1]! }) },
  { re: /\[((?:[^[\]\n]|\[[^\]\n]*\])+)\]\(\s*([^)\s]+)\s*\)/, make: (m) => ({ type: "link", href: m[2]!, children: parseInline(m[1]!) }) },
  { re: /\*\*([^*\n]+?)\*\*/, make: (m) => ({ type: "strong", children: parseInline(m[1]!) }) },
  { re: /__([^_\n]+?)__/, make: (m) => ({ type: "strong", children: parseInline(m[1]!) }) },
  { re: /(?<![\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/, make: (m) => ({ type: "em", children: parseInline(m[1]!) }) },
  { re: /(?<![\w_])_(?!\s)([^_\n]+?)_(?!\w)/, make: (m) => ({ type: "em", children: parseInline(m[1]!) }) },
];

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  while (rest.length) {
    let best: { idx: number; m: RegExpExecArray; rule: (typeof INLINE_RULES)[number] } | null = null;
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(rest);
      if (m && (best === null || m.index < best.idx)) best = { idx: m.index, m, rule };
    }
    if (!best) {
      out.push({ type: "text", text: rest });
      break;
    }
    if (best.idx > 0) out.push({ type: "text", text: rest.slice(0, best.idx) });
    const node = best.rule.make(best.m);
    if (node.type === "link" && !safeHref(node.href)) {
      // unsafe scheme → keep the label as plain text, drop the target
      out.push(...node.children);
    } else {
      out.push(node.type === "link" ? { ...node, href: safeHref(node.href)! } : node);
    }
    rest = rest.slice(best.idx + best.m[0].length);
  }
  return out;
}

const LIST_UL = /^\s*[-*+]\s+(.*)$/;
const LIST_OL = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "p", children: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      blocks.push({ type: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ type: "h", level: h[1]!.length, children: parseInline(h[2]!.replace(/\s*#+\s*$/, "")) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: "hr" });
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      flush();
      const header = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) rows.push(splitRow(lines[i++]!).map(parseInline));
      i--;
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const ul = LIST_UL.exec(line);
    const ol = ul ? null : LIST_OL.exec(line);
    if (ul || ol) {
      flush();
      const kind = ul ? "ul" : "ol";
      const re = ul ? LIST_UL : LIST_OL;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]!);
        if (m) {
          items.push(parseInline(m[1]!));
          i++;
        } else if (lines[i]!.trim() && /^\s{2,}\S/.test(lines[i]!) && items.length) {
          // continuation line of the previous item
          items[items.length - 1]!.push({ type: "text", text: " " }, ...parseInline(lines[i]!.trim()));
          i++;
        } else break;
      }
      i--;
      blocks.push({ type: kind, items });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flush();
      const body = [q[1]!];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1]!)) body.push(lines[++i]!.replace(/^\s*>\s?/, ""));
      blocks.push({ type: "quote", children: parseInline(body.join("\n")) });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

export type LinkComponent = ComponentType<{ href: string; className?: string; children?: ReactNode }>;

const DefaultLink: LinkComponent = ({ href, className, children }) => createElement("a", { href, className }, children);

function renderInline(nodes: Inline[], Link: LinkComponent, keyPrefix = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}${i}`;
    switch (n.type) {
      case "text": {
        // keep single newlines inside paragraphs as <br/>
        const parts = n.text.split("\n");
        return createElement(
          Fragment,
          { key },
          ...parts.flatMap((p, j) => (j === 0 ? [p] : [createElement("br", { key: `${key}-br${j}` }), p])),
        );
      }
      case "strong":
        return createElement("strong", { key, className: "font-medium text-fg" }, ...renderInline(n.children, Link, `${key}-`));
      case "em":
        return createElement("em", { key }, ...renderInline(n.children, Link, `${key}-`));
      case "code":
        return createElement("code", { key, className: "rounded bg-surface-3/60 px-1 py-px font-mono text-[12px] text-fg" }, n.text);
      case "link": {
        const external = !n.href.startsWith("/");
        return createElement(
          Link,
          { key, href: n.href, className: "text-fg underline decoration-border-strong underline-offset-2 hover:decoration-white" },
          ...renderInline(n.children, Link, `${key}-`),
          external ? " ↗" : null,
        );
      }
    }
  });
}

/** Render markdown to React elements. Pure — safe for server or client. */
export function renderMarkdown(src: string, opts: { Link?: LinkComponent } = {}): ReactNode {
  const Link = opts.Link ?? DefaultLink;
  const blocks = parseMarkdown(src);
  return blocks.map((b, i) => {
    const key = `b${i}`;
    switch (b.type) {
      case "p":
        return createElement("p", { key, className: "my-2 first:mt-0 last:mb-0" }, ...renderInline(b.children, Link));
      case "h":
        return createElement(
          b.level <= 2 ? "h3" : "h4",
          { key, className: b.level <= 2 ? "mb-1 mt-4 font-display text-base text-fg first:mt-0" : "mb-1 mt-3 text-sm font-medium text-fg first:mt-0" },
          ...renderInline(b.children, Link),
        );
      case "ul":
      case "ol":
        return createElement(
          b.type,
          { key, className: `my-2 space-y-1 pl-5 ${b.type === "ul" ? "list-disc" : "list-decimal"} marker:text-muted` },
          ...b.items.map((it, j) => createElement("li", { key: `${key}-${j}` }, ...renderInline(it, Link, `${key}-${j}-`))),
        );
      case "code":
        return createElement(
          "pre",
          { key, className: "my-2 overflow-x-auto rounded-md border border-border bg-surface-1 p-3 font-mono text-[12px] leading-5 text-body" },
          createElement("code", null, b.text),
        );
      case "quote":
        return createElement(
          "blockquote",
          { key, className: "my-2 border-l border-border-strong pl-3 text-secondary" },
          ...renderInline(b.children, Link),
        );
      case "hr":
        return createElement("hr", { key, className: "my-3 border-border" });
      case "table":
        return createElement(
          "div",
          { key, className: "my-2 overflow-x-auto" },
          createElement(
            "table",
            { className: "w-full border-collapse text-left text-[13px] tabular" },
            createElement(
              "thead",
              null,
              createElement(
                "tr",
                null,
                ...b.header.map((c, j) =>
                  createElement("th", { key: j, className: "border-b border-border-strong px-2 py-1.5 font-medium text-secondary" }, ...renderInline(c, Link)),
                ),
              ),
            ),
            createElement(
              "tbody",
              null,
              ...b.rows.map((r, j) =>
                createElement(
                  "tr",
                  { key: j },
                  ...r.map((c, k) => createElement("td", { key: k, className: "border-b border-border px-2 py-1.5 text-body" }, ...renderInline(c, Link))),
                ),
              ),
            ),
          ),
        );
    }
  });
}
