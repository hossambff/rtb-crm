import * as React from "react";
import { cn } from "@/lib/utils";
import type { Block, PBlock, Span } from "@/lib/proposals/docx/preview";

/**
 * Paper rendering of a Word document's text (preview + print). Every string is rendered as a React text node — the
 * document and the substituted values are always escaped. Substituted values are highlighted when `highlight` is on.
 */
export function TermSheetDocument({ body, headers = [], footers = [], highlight = true, labels = {} }: { body: Block[]; headers?: Block[][]; footers?: Block[][]; highlight?: boolean; labels?: Record<string, string> }) {
  return (
    <article className="termsheet-paper mx-auto w-full max-w-[8.5in] rounded-md bg-[#fbfaf7] px-6 py-8 font-normal text-[#1d1d1b] sm:px-14 sm:py-14" style={{ fontFamily: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif' }}>
      {headers.map((h, i) => (
        <div key={`h${i}`} className="mb-6 border-b border-[#e4e1da] pb-3 text-[11px] leading-4 text-[#6b675f]">
          <Blocks blocks={h} highlight={highlight} labels={labels} small />
        </div>
      ))}
      <div className="text-[13.5px] leading-[1.6]">
        <Blocks blocks={body} highlight={highlight} labels={labels} />
      </div>
      {footers.map((f, i) => (
        <div key={`f${i}`} className="mt-8 border-t border-[#e4e1da] pt-3 text-[11px] leading-4 text-[#6b675f]">
          <Blocks blocks={f} highlight={highlight} labels={labels} small />
        </div>
      ))}
    </article>
  );
}

function Blocks({ blocks, highlight, labels, small }: { blocks: Block[]; highlight: boolean; labels: Record<string, string>; small?: boolean }) {
  return (
    <>
      {blocks.map((b, i) =>
        b.type === "p" ? (
          <Para key={i} p={b} highlight={highlight} labels={labels} small={small} />
        ) : (
          <div key={i} className="my-4 overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px] leading-[1.45]">
              <tbody>
                {b.rows.map((row, ri) => (
                  <tr key={ri} className={ri === 0 ? "bg-[#f1eee7]" : undefined}>
                    {row.map((cell, ci) => (
                      <td key={ci} className="border border-[#d9d5cc] px-2.5 py-1.5 align-top">
                        {cell.map((p, pi) => (
                          <Para key={pi} p={p} highlight={highlight} labels={labels} inCell />
                        ))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
    </>
  );
}

/** Inline so the global (unlayered) h2/h3 colour and display font do not apply on paper. */
const HEADING: React.CSSProperties = { color: "#1d1d1b", fontFamily: "inherit" };

function Para({ p, highlight, labels, small, inCell }: { p: PBlock; highlight: boolean; labels: Record<string, string>; small?: boolean; inCell?: boolean }) {
  const empty = p.spans.every((s) => !s.text.trim());
  if (empty) return inCell ? null : <div aria-hidden className={small ? "h-2" : "h-3"} />;
  const align = { left: "text-left", center: "text-center", right: "text-right", justify: "text-justify" }[p.align];
  const content = p.spans.map((s, i) => <SpanView key={i} s={s} highlight={highlight} label={s.mark ? labels[s.mark] : undefined} />);
  const style: React.CSSProperties = { tabSize: 4, ...(p.indent && !inCell ? { paddingLeft: `${Math.min(p.indent, 4) * 1.5}rem` } : {}) };
  const cls = cn("whitespace-pre-wrap break-words", align);
  if (!small && !inCell && p.heading !== null) {
    if (p.heading <= 1)
      return (
        <h2 className={cn(cls, "mb-3 mt-6 text-[22px] font-semibold leading-tight tracking-[-0.01em] first:mt-0")} style={{ ...style, ...HEADING }}>
          {content}
        </h2>
      );
    return (
      <h3 className={cn(cls, "mb-2 mt-5 text-[15px] font-semibold leading-snug")} style={{ ...style, ...HEADING }}>
        {content}
      </h3>
    );
  }
  return (
    <p className={cn(cls, inCell ? "my-0" : "my-1.5", p.list && "relative pl-5 before:absolute before:left-1 before:content-['•']")} style={style}>
      {content}
    </p>
  );
}

function SpanView({ s, highlight, label }: { s: Span; highlight: boolean; label?: string }) {
  const cls = cn(s.b && "font-semibold", s.i && "italic", s.u && "underline decoration-1 underline-offset-2", s.caps && "uppercase");
  if (s.mark && highlight)
    return (
      <mark title={label ? `Filled: ${label}` : "Filled from the form"} className={cn(cls, "rounded-sm bg-[#fde9a6] px-0.5 text-inherit [box-decoration-break:clone] print:bg-transparent")}>
        {s.text}
      </mark>
    );
  return cls ? <span className={cls}>{s.text}</span> : <>{s.text}</>;
}
