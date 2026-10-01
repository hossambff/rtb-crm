import Link from "next/link";
import { ListTodo, Mail, UserPlus } from "lucide-react";
import { StatusBadge } from "@/components/ui/badge";
import { fmtNumber, fmtPct } from "@/lib/format";
import type { SequenceMetrics, Step } from "@/lib/sequences/core";
import type { SequenceListRow } from "@/lib/sequences/queries";
import { cn } from "@/lib/utils";

const ICON = { email: Mail, task: ListTodo, linkedin: UserPlus } as const;

/** Compact cadence: one glyph per step with its business-day offset. */
export function StepStrip({ steps, className }: { steps: Step[]; className?: string }) {
  const days = steps.reduce<number[]>((acc, s) => [...acc, (acc.at(-1) ?? 0) + s.delayDays], []);
  return (
    <ol className={cn("flex flex-wrap items-center gap-1", className)} aria-label="Steps">
      {steps.map((s, i) => {
        const day = days[i]!;
        const Icon = ICON[s.kind];
        return (
          <li key={i} className="flex items-center gap-1">
            {i > 0 ? <span aria-hidden className="h-px w-3 bg-border-strong" /> : null}
            <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-secondary" title={`Step ${i + 1}: ${s.kind} on business day ${day}`}>
              <Icon className="size-3" aria-hidden />
              <span className="tabular">D{day}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function MetricsRow({ m, compact = false }: { m: SequenceMetrics; compact?: boolean }) {
  const items: [string, string][] = [
    ["Enrolled", fmtNumber(m.enrolled)],
    ["Active", fmtNumber(m.active)],
    ["Replied", m.replyRate == null ? "—" : fmtPct(m.replyRate)],
    ["Meetings", fmtNumber(m.meetings)],
    ["Bounced", fmtNumber(m.bounced)],
    // QA MIN-26: opt-outs are not counted as replies
    ...(compact ? [] : ([["Opted out", fmtNumber(m.unsubscribed)]] as [string, string][])),
  ];
  return (
    <dl className={cn("grid", compact ? "grid-cols-5 gap-2" : "grid-cols-3 gap-3 sm:grid-cols-6")}>
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="truncate text-[11px] uppercase tracking-wide text-muted">{k}</dt>
          <dd className={cn("tabular text-fg", compact ? "text-sm" : "font-display text-2xl")}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SequenceCard({ row }: { row: SequenceListRow }) {
  return (
    <Link
      href={`/sequences/${row.id}`}
      className="group block rounded-lg border border-border bg-surface-1 p-4 transition-colors duration-150 hover:border-border-strong hover:bg-surface-2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-display text-lg text-fg">{row.name}</p>
          <p className="truncate text-xs text-muted">
            {row.mine ? "Yours" : (row.ownerName ?? "Team")}
            {row.shared ? " · shared" : " · private"}
            {row.pipelineKeys.length ? ` · ${row.pipelineKeys.join(", ")}` : ""}
          </p>
        </div>
        {row.problems.length ? <StatusBadge status="warning" label="Needs edits" /> : row.active ? <StatusBadge status="good" label="Live" /> : <StatusBadge status="info" label="Paused" />}
      </div>
      {row.description ? <p className="mb-3 line-clamp-2 text-sm text-secondary">{row.description}</p> : null}
      <StepStrip steps={row.steps} className="mb-4" />
      <MetricsRow m={row.metrics} compact />
    </Link>
  );
}
