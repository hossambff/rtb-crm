import Link from "next/link";
import { fmtPct, fmtUsd } from "@/lib/format";
import { attainment } from "@/lib/quotas/core";
import { cn } from "@/lib/utils";

export type AttainmentRow = { key: string; label: string; href?: string; quotaUsd: number; proposed: boolean; commitUsd: number; bestUsd: number };

/** Commit and commit + best against the quarter's revenue quota: a thin monochrome bar with a quota tick. */
function Bar({ commit, best, quota }: { commit: number; best: number; quota: number }) {
  const max = Math.max(quota, commit + best) || 1;
  const pct = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  return (
    <div className="relative h-1.5 w-full rounded-full bg-border" aria-hidden>
      <div className="absolute inset-y-0 left-0 rounded-full bg-secondary/50" style={{ width: pct(commit + best) }} />
      <div className="absolute inset-y-0 left-0 rounded-full bg-fg" style={{ width: pct(commit) }} />
      <div className="absolute -top-1 h-3.5 w-px bg-fg" style={{ left: pct(quota) }} />
    </div>
  );
}

export function QuotaAttainment({ title, quarterLabel, rows, className }: { title: string; quarterLabel: string; rows: AttainmentRow[]; className?: string }) {
  if (!rows.length) return null;
  return (
    <section aria-label={title} className={cn("rounded-lg border border-border bg-surface-1", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="font-display text-lg text-fg">{title}</h2>
        <p className="text-xs text-muted">
          {quarterLabel} revenue quota · <span className="text-fg">■</span> commit <span className="text-secondary">■</span> + best case
        </p>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => {
          const a = attainment(r.commitUsd, r.quotaUsd);
          const ab = attainment(r.commitUsd + r.bestUsd, r.quotaUsd);
          return (
            <li key={r.key} className="grid grid-cols-1 items-center gap-2 px-4 py-3 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto] sm:gap-4">
              <p className="truncate text-sm text-fg">
                {r.href ? (
                  <Link href={r.href} className="hover:underline">
                    {r.label}
                  </Link>
                ) : (
                  r.label
                )}
                {r.proposed ? <span className="ml-1.5 text-xs text-muted">(proposed)</span> : null}
              </p>
              <Bar commit={r.commitUsd} best={r.bestUsd} quota={r.quotaUsd} />
              <p className="whitespace-nowrap text-xs text-muted tabular">
                <span className="font-display text-base text-fg">{a == null ? "—" : fmtPct(a)}</span> commit · {ab == null ? "—" : fmtPct(ab)} with best · of{" "}
                {fmtUsd(r.quotaUsd, { compact: true })}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
