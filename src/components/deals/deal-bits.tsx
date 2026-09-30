import { Lock } from "lucide-react";
import { Avatar, Tooltip } from "@/components/ui/misc";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { fmtDate, fmtNumber, fmtRelative, fmtUsd } from "@/lib/format";
import { healthStatus } from "@/lib/palette";
import { PRIORITY_LABELS, type Priority, type Unit, type UserLite } from "@/lib/deals/types";
import { cn } from "@/lib/utils";

/** Presentational pieces shared by the board, list and record page (no hooks; safe in server + client trees). */

export function HealthBadge({ score, explanation, className }: { score: number | null; explanation?: string | null; className?: string }) {
  if (score == null) return null;
  const badge = <StatusBadge status={healthStatus(score)} label={`${score}`} className={cn("tabular", className)} />;
  return explanation ? (
    <Tooltip content={<span className="block max-w-64">Health {score}/100 — {explanation}</span>}>
      <span className="inline-flex" tabIndex={0} aria-label={`Health ${score} of 100. ${explanation}`}>
        {badge}
      </span>
    </Tooltip>
  ) : (
    badge
  );
}

export function PriorityTag({ priority, className }: { priority: Priority | null; className?: string }) {
  if (!priority) return null;
  return (
    <Badge className={cn(priority === "top10" ? "border-white/60 text-fg" : "", "uppercase tracking-wide text-[10px]", className)}>{PRIORITY_LABELS[priority]}</Badge>
  );
}

export function RestrictedLock({ className }: { className?: string }) {
  return (
    <Tooltip content="Restricted (MNPI) — visible only to the access list. Views are logged.">
      <span className={cn("inline-flex text-secondary", className)} aria-label="Restricted record" tabIndex={0}>
        <Lock className="size-3.5" strokeWidth={1.75} />
      </span>
    </Tooltip>
  );
}

export function OwnerStack({ owners, size = 20, max = 3 }: { owners: (UserLite & { pct?: number | null })[]; size?: number; max?: number }) {
  if (!owners.length) return <span className="text-[11px] text-muted">Unassigned</span>;
  const shown = owners.slice(0, max);
  const label = owners.map((o) => `${o.name}${o.pct != null ? ` (${Math.round(o.pct)}%)` : ""}`).join(", ");
  return (
    <Tooltip content={label}>
      <span className="flex -space-x-1.5" aria-label={`Owners: ${label}`} tabIndex={0}>
        {shown.map((o) => (
          <Avatar key={o.id} name={o.name} src={o.image} size={size} className="ring-2 ring-surface-2" />
        ))}
        {owners.length > max ? (
          <span className="inline-flex items-center justify-center rounded-full border border-border-strong bg-surface-3 text-[9px] text-secondary ring-2 ring-surface-2" style={{ width: size, height: size }}>
            +{owners.length - max}
          </span>
        ) : null}
      </span>
    </Tooltip>
  );
}

/** Primary value for a deal: MUU (+ gross $) for MUU motions, $ for USD motions, "Activation" for R100. */
export function valueLabel(unit: Unit, d: { muu: number; grossUsd: number }): string {
  if (unit === "muu") return d.muu ? `${fmtNumber(d.muu, { compact: true })} MUU` : "MUU —";
  if (unit === "usd") return d.grossUsd ? fmtUsd(d.grossUsd, { compact: true }) : "$ —";
  return "Activation";
}

export function NextStepLine({
  nextStep,
  dueAt,
  overdueDays,
  waitingReason,
  compact,
}: {
  nextStep: string | null;
  dueAt: string | null;
  overdueDays: number;
  waitingReason?: string | null;
  compact?: boolean;
}) {
  if (!nextStep) {
    return waitingReason ? (
      <p className="truncate text-[12px] text-secondary" title={waitingReason}>
        Waiting · {waitingReason}
      </p>
    ) : (
      <StatusBadge status="warning" label="No next step" />
    );
  }
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", compact ? "" : "flex-wrap")}>
      <span className="min-w-0 truncate text-[12px] text-body" title={nextStep}>
        {nextStep}
      </span>
      {overdueDays > 0 ? (
        <StatusBadge status="critical" label={`Overdue ${overdueDays}d`} className="shrink-0" />
      ) : dueAt ? (
        <span className="shrink-0 text-[11px] text-muted tabular">{fmtDate(dueAt, "d MMM")}</span>
      ) : null}
    </div>
  );
}

/** Relative time ("3 days ago"); server and client clocks differ, so hydration text mismatches are expected. */
export function RelativeTime({ iso, prefix, className }: { iso: string | null; prefix?: string; className?: string }) {
  if (!iso) return <span className={className}>—</span>;
  return (
    <time dateTime={iso} title={fmtDate(iso, "d MMM yyyy HH:mm")} className={className} suppressHydrationWarning>
      {prefix}
      {fmtRelative(iso)}
    </time>
  );
}

export function Money({ usd, className }: { usd: number | null | undefined; className?: string }) {
  return <span className={cn("tabular", className)}>{fmtUsd(usd, { compact: true })}</span>;
}
