"use client";
import * as React from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { tableFeatures, useTable, type ColumnDef, type RowData } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export const listFeatures = tableFeatures({});
export type ListFeatures = typeof listFeatures;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ListColumn<T extends RowData> = ColumnDef<ListFeatures, T, any>;

export type ColumnUi = { sortKey?: string; align?: "right"; className?: string; hideOnMobile?: boolean };

/**
 * Dense, server-paginated table (sorting/paging live in the URL; the server does the work).
 * Headers with a sortKey are buttons; rows navigate to `rowHref` on click (the primary cell should also be a Link).
 */
export function ServerTable<T extends RowData & { id: string }>({
  columns,
  ui,
  data,
  sort,
  dir,
  onSort,
  rowHref,
  pending,
}: {
  columns: ListColumn<T>[];
  ui: Record<string, ColumnUi>;
  data: T[];
  sort: string;
  dir: "asc" | "desc";
  onSort: (key: string) => void;
  rowHref?: (row: T) => string;
  pending?: boolean;
}) {
  const router = useRouter();
  const table = useTable({ features: listFeatures, columns, data, getRowId: (r) => r.id });
  return (
    <div className={cn("overflow-x-auto rounded-lg border border-border bg-surface-1 transition-opacity duration-150", pending && "opacity-60")}>
      <table className="w-full border-collapse text-sm md:min-w-[720px]">
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className="border-b border-border">
              {group.headers.map((header) => {
                const u = ui[header.column.id] ?? {};
                const active = u.sortKey && u.sortKey === sort;
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
                    className={cn(
                      "h-9 whitespace-nowrap px-3 text-left text-[11px] font-medium uppercase tracking-wide text-muted",
                      u.align === "right" && "text-right",
                      u.hideOnMobile && "hidden md:table-cell",
                      u.className,
                    )}
                  >
                    {header.isPlaceholder ? null : u.sortKey ? (
                      <button
                        type="button"
                        onClick={() => onSort(u.sortKey!)}
                        className={cn("inline-flex items-center gap-1 uppercase hover:text-fg", active && "text-fg", u.align === "right" && "flex-row-reverse")}
                      >
                        <table.FlexRender header={header} />
                        {active ? dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : null}
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              onClick={(e) => {
                if (!rowHref || (e.target as HTMLElement).closest("a,button,input,select")) return;
                router.push(rowHref(row.original));
              }}
              className={cn("border-b border-border last:border-0 transition-colors duration-100 hover:bg-surface-2", rowHref && "cursor-pointer")}
            >
              {row.getAllCells().map((cell) => {
                const u = ui[cell.column.id] ?? {};
                return (
                  <td key={cell.id} className={cn("h-10 whitespace-nowrap px-3 align-middle text-body", u.align === "right" && "text-right tabular", u.hideOnMobile && "hidden md:table-cell", u.className)}>
                    <table.FlexRender cell={cell} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage, onSize }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; onSize?: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
      <span className="tabular">
        {fmtNumber(from)}–{fmtNumber(to)} of {fmtNumber(total)}
      </span>
      <div className="flex items-center gap-2">
        {onSize ? (
          <label className="flex items-center gap-1.5">
            <span>Rows</span>
            <select
              value={pageSize}
              onChange={(e) => onSize(Number(e.target.value))}
              className="h-7 rounded border border-border bg-surface-2 px-1 text-xs text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            >
              {[25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft />
        </Button>
        <span className="tabular">
          {page} / {pages}
        </span>
        <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
