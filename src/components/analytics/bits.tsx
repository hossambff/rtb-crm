import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { ColorTick } from "@/components/ui/badge";
import { PIPELINE_COLORS, VIZ } from "@/lib/palette";
import { fmtRelative } from "@/lib/format";
import { formatValue, type ValueFormat } from "@/components/charts/format";

export function KpiGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4", className)}>{children}</div>;
}

export function ChartGrid({ children, cols = 2, className }: { children: React.ReactNode; cols?: 1 | 2 | 3; className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 gap-4", cols === 2 && "xl:grid-cols-2", cols === 3 && "lg:grid-cols-2 2xl:grid-cols-3", className)}>{children}</div>
  );
}

export function Section({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-display text-xl font-medium text-fg">{title}</h2>
        {description ? <p className="text-xs text-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Plain card for lists that aren't charts (movement lists, deal tables). */
export function Panel({
  title,
  description,
  footnote,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  footnote?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col rounded-lg border border-border bg-surface-1", className)}>
      <div className="px-4 pt-3.5">
        <h3 className="font-display text-base font-medium leading-6 text-fg">{title}</h3>
        {description ? <p className="text-xs text-muted">{description}</p> : null}
      </div>
      <div className="min-w-0 flex-1 px-4 pb-3 pt-2">{children}</div>
      {footnote ? <p className="border-t border-border px-4 py-2 text-[11px] leading-4 text-muted">{footnote}</p> : null}
    </div>
  );
}

export function MotionTick({ motion }: { motion: string }) {
  return <ColorTick color={PIPELINE_COLORS[motion] ?? "#828282"} />;
}

/** Ranked table with an inline magnitude bar (one hue) — used for Top-25 brands. */
export function RankTable({
  rows,
  format,
  valueLabel,
  columns,
  empty = "Nothing to rank yet.",
}: {
  rows: { key: string; label: React.ReactNode; value: number; cells: React.ReactNode[] }[];
  format: ValueFormat;
  valueLabel: string;
  columns: string[];
  empty?: string;
}) {
  if (!rows.length) return <p className="py-6 text-center text-xs text-muted">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead>
          <tr className="border-b border-border text-muted">
            <th scope="col" className="w-8 py-1.5 pr-2 font-medium">#</th>
            <th scope="col" className="py-1.5 pr-2 font-medium">Brand</th>
            {columns.map((c) => (
              <th key={c} scope="col" className="py-1.5 pr-3 text-right font-medium">
                {c}
              </th>
            ))}
            <th scope="col" className="w-[28%] py-1.5 font-medium">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className="border-b border-border/60 last:border-0 hover:bg-surface-2/50">
              <td className="py-1.5 pr-2 text-muted tabular">{i + 1}</td>
              <td className="max-w-56 truncate py-1.5 pr-2 text-body">{r.label}</td>
              {r.cells.map((c, j) => (
                <td key={j} className="py-1.5 pr-3 text-right text-secondary tabular">
                  {c}
                </td>
              ))}
              <td className="py-1.5">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 rounded-r-sm" style={{ width: `${Math.max(2, (r.value / max) * 70)}%`, background: VIZ[0] }} aria-hidden />
                  <span className="font-semibold text-fg tabular">{formatValue(r.value, format)}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type DealLine = {
  id: string;
  name: string;
  pipeline: string;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  value: number;
};

/** Compact deal list (movement, attention). */
export function DealLines({ items, format, href, empty }: { items: DealLine[]; format: ValueFormat; href: (id: string) => string; empty: string }) {
  if (!items.length) return <p className="py-4 text-xs text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-border/60">
      {items.map((d) => (
        <li key={d.id} className="flex items-center gap-2 py-1.5 text-xs">
          <MotionTick motion={d.pipeline} />
          <div className="min-w-0 flex-1">
            <Link href={href(d.id)} className="block truncate text-body hover:text-fg hover:underline">
              {d.name}
            </Link>
            <p className="truncate text-muted">
              {d.primary}
              {d.secondary ? <> · {d.secondary}</> : null}
            </p>
          </div>
          <span className="shrink-0 font-semibold text-fg tabular">{formatValue(d.value, format)}</span>
        </li>
      ))}
    </ul>
  );
}

export function relative(d: Date | null | undefined): string {
  return d ? fmtRelative(d) : "never";
}
