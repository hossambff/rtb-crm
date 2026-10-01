import Link from "next/link";
import { Lock } from "lucide-react";
import { ColorTick, StatusBadge } from "@/components/ui/badge";
import { fmtUsd } from "@/lib/format";
import { EXCEPTION_KINDS, EXCEPTION_META, type DealException, type ExceptionKind } from "@/lib/review/core";
import type { ReviewRow } from "@/lib/review/queries";

export function ExceptionChip({ e }: { e: DealException }) {
  const tone = EXCEPTION_META[e.kind].tone;
  return (
    <span title={e.detail}>
      <StatusBadge status={tone} label={e.label} />
    </span>
  );
}

export function ExceptionSummary({ counts }: { counts: Record<ExceptionKind, number> }) {
  const shown = EXCEPTION_KINDS.filter((k) => counts[k] > 0);
  if (!shown.length) return null;
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Exceptions by type">
      {shown.map((k) => (
        <li key={k} className="flex items-baseline gap-1.5">
          <span className="font-display text-2xl leading-8 text-fg tabular">{counts[k]}</span>
          <span className="text-xs text-muted">{EXCEPTION_META[k].label.toLowerCase()}</span>
        </li>
      ))}
    </ul>
  );
}

/** Ranked exception list (read-only preview before starting the walk-through). */
export function ExceptionList({ rows, limit }: { rows: ReviewRow[]; limit: number }) {
  return (
    <ol className="divide-y divide-border rounded-lg border border-border bg-surface-1">
      {rows.slice(0, limit).map((r, i) => (
        <li key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className="w-6 shrink-0 pt-0.5 text-right text-xs text-muted tabular">{i + 1}</span>
            <ColorTick color={r.pipelineColor} className="mt-1" />
            <div className="min-w-0">
              <Link href={`/deals/${r.id}`} className="block truncate text-sm font-medium text-fg hover:underline">
                {r.restricted ? <Lock className="mr-1 inline size-3 text-muted" aria-label="Restricted" /> : null}
                {r.name}
              </Link>
              <p className="truncate text-xs text-muted">
                {[r.accountName, r.stageName, r.ownerName ?? "Unassigned"].filter(Boolean).join(" · ")}
                {r.valueUsd ? ` · ${fmtUsd(r.valueUsd, { compact: true })}` : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 pl-9 sm:max-w-[50%] sm:justify-end sm:pl-0">
            {r.exceptions.map((e) => (
              <ExceptionChip key={e.kind} e={e} />
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}
