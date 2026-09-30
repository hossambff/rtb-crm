import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, renderMarkdown, safeHref } from "../markdown";

const html = (md: string) => renderToStaticMarkup(createElement(Fragment, null, renderMarkdown(md)));

describe("safe markdown renderer — XSS", () => {
  it("renders raw HTML as inert text", () => {
    const out = html('<script>alert(1)</script> <img src=x onerror="alert(2)"> **<b>bold</b>**');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;");
  });
  it("drops dangerous link schemes but keeps the label", () => {
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "vbscript:x", "//evil.com/x"]) {
      const out = html(`[click me](${bad})`);
      expect(out).toContain("click me");
      expect(out).not.toContain("href");
    }
  });
  it("allows https, mailto and same-origin paths", () => {
    expect(html("[Reach](/deals/123)")).toContain('href="/deals/123"');
    expect(html("[site](https://example.com/a?b=1)")).toContain('href="https://example.com/a?b=1"');
    expect(html("[mail](mailto:a@b.co)")).toContain('href="mailto:a@b.co"');
  });
  it("escapes quotes inside link targets and code", () => {
    const out = html('`<x onclick="y">` and [a](https://x.com/"onmouseover="alert(1))');
    expect(out).toContain("&lt;x onclick=&quot;y&quot;&gt;");
    expect(out).not.toMatch(/onmouseover="alert/);
  });
  it("safeHref unit cases", () => {
    expect(safeHref("/accounts/1")).toBe("/accounts/1");
    expect(safeHref("  https://a.b ")).toBe("https://a.b");
    expect(safeHref("javascript:void(0)")).toBeNull();
    expect(safeHref("//cdn.evil")).toBeNull();
    expect(safeHref("")).toBeNull();
  });
});

describe("markdown structure", () => {
  it("parses paragraphs, lists, headings, code and tables", () => {
    const blocks = parseMarkdown("## Title\n\nHello **world**\n\n- a\n- b\n\n1. one\n2. two\n\n```\ncode <x>\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    expect(blocks.map((b) => b.type)).toEqual(["h", "p", "ul", "ol", "code", "table"]);
    const out = html("| Stage | Deals |\n|---|---:|\n| Hot | 3 |");
    expect(out).toContain("<table");
    expect(out).toContain("<td");
  });
  it("parses inline bold/italic/code/link", () => {
    const nodes = parseInline("a **b** _c_ `d` [e](/f)");
    expect(nodes.map((n) => n.type)).toEqual(["text", "strong", "text", "em", "text", "code", "text", "link"]);
  });
  it("does not treat snake_case as italics", () => {
    expect(parseInline("use deals_at_risk now").map((n) => n.type)).toEqual(["text"]);
  });
});
