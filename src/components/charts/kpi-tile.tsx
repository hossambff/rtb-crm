import * as React from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { STATUS_COLORS, VIZ } from "@/lib/palette";
import { cn } from "@/lib/utils";
import { Sparkline } from "./sparkline";

/**
 * Hero KPI (PRD §16A.4): Playfair number in white, Work Sans label, optional basis line, delta and a small
 * pastel sparkline. Delta direction is shown with an icon in a status hue; the text itself stays neutral.
 */
export function KpiTile({
  label,
  value,
  basis,
  delta,
  trend,
  trendColor = VIZ[0],
  className,
}: {
  label: string;
  value: React.ReactNode;
  /** e.g. "Gross · weighted" — every number shows its basis (PRD §14.1). */
  basis?: React.ReactNode;
  delta?: { text: string; direction: "up" | "down" | "flat"; good?: boolean };
  trend?: number[];
  trendColor?: string;
  className?: string;
}) {
  const DeltaIcon = delta?.direction === "up" ? ArrowUpRight : delta?.direction === "down" ? ArrowDownRight : Minus;
  const deltaColor =
    delta == null || delta.direction === "flat" ? "#828282" : delta.good ? STATUS_COLORS.good : STATUS_COLORS.serious;
  return (
    <div className={cn("flex min-w-0 flex-col justify-between rounded-lg border border-border bg-surface-1 px-4 py-3.5", className)}>
      <p className="text-xs font-medium text-secondary">{label}</p>
      <div className="mt-1.5 flex items-end justify-between gap-2">
        <p className="truncate font-display text-[28px] leading-9 text-fg">{value}</p>
        {trend && trend.length > 1 ? <Sparkline values={trend} color={trendColor} label={`${label} trend`} /> : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
        {delta ? (
          <span className="inline-flex items-center gap-0.5 text-secondary">
            <DeltaIcon className="size-3" style={{ color: deltaColor }} aria-hidden />
            {delta.text}
          </span>
        ) : null}
        {basis ? <span>{basis}</span> : null}
      </div>
    </div>
  );
}
