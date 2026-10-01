"use client";
import * as React from "react";
import { BarChart3, Table2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TableSpec } from "./format";

export type LegendItem = { label: string; color: string; shape?: "rect" | "line" };

/** Legend: swatch mirrors the mark (rect for bars/areas, line for lines). Text is never in the series color. */
export function Legend({ items, className }: { items: LegendItem[]; className?: string }) {
  if (items.length < 2) return null;
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-secondary", className)} aria-label="Legend">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          {it.shape === "line" ? (
            <span aria-hidden className="inline-block h-0.5 w-3 rounded-full" style={{ background: it.color }} />
          ) : (
            <span aria-hidden className="inline-block size-2.5 rounded-[2px]" style={{ background: it.color }} />
          )}
          <span>{it.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** Accessible table twin of a chart. */
export function DataTable({ table, caption }: { table: TableSpec; caption?: string }) {
  return (
    <div className="max-h-[420px] overflow-auto overscroll-x-contain">
      <table className="table-sticky-first w-full text-left text-xs">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="sticky top-0 z-[2] bg-surface-1">
          <tr className="border-b border-border">
            {table.columns.map((c) => (
              <th key={c.label} scope="col" className={cn("px-2 py-1.5 font-medium text-muted", c.numeric && "text-right")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i} className="border-b border-border/60 last:border-0">
              {r.map((cell, j) => (
                <td key={j} className={cn("px-2 py-1.5 text-body", table.columns[j]?.numeric && "text-right tabular")}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Card frame shared by every chart: title, basis/provenance footnote, legend, and the "view as table" toggle
 * (PRD §16A.4 hover layer + accessibility twin).
 */
export function ChartCard({
  title,
  description,
  footnote,
  legend,
  table,
  empty,
  emptyText = "No data for this selection.",
  actions,
  className,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  footnote?: React.ReactNode;
  legend?: LegendItem[];
  table: TableSpec;
  empty?: boolean;
  emptyText?: string;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const [view, setView] = React.useState<"chart" | "table">("chart");
  const id = React.useId();
  return (
    <figure className={cn("flex min-w-0 flex-col rounded-lg border border-border bg-surface-1", className)} aria-labelledby={`${id}-t`}>
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5">
        <div className="min-w-0">
          <h3 id={`${id}-t`} className="font-display text-base font-medium leading-6 text-fg">
            {title}
          </h3>
          {description ? <p className="text-xs text-muted">{description}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {!empty ? (
            <button
              type="button"
              onClick={() => setView((v) => (v === "chart" ? "table" : "chart"))}
              aria-pressed={view === "table"}
              aria-label={view === "chart" ? `View ${title} as table` : `View ${title} as chart`}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
            >
              {view === "chart" ? <Table2 className="size-3.5" /> : <BarChart3 className="size-3.5" />}
              {view === "chart" ? "Table" : "Chart"}
            </button>
          ) : null}
        </div>
      </div>
      {legend && !empty && view === "chart" ? <Legend items={legend} className="px-4 pt-2" /> : null}
      <div className="min-w-0 flex-1 px-3 pb-2 pt-2">
        {empty ? (
          <div className="flex h-full min-h-32 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted">
            {emptyText}
          </div>
        ) : view === "chart" ? (
          children
        ) : (
          <DataTable table={table} caption={title} />
        )}
      </div>
      {footnote ? <figcaption className="border-t border-border px-4 py-2 text-[11px] leading-4 text-muted">{footnote}</figcaption> : null}
    </figure>
  );
}
