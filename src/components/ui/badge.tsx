import * as React from "react";
import { CheckCircle2, AlertTriangle, AlertOctagon, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { STATUS_COLORS } from "@/lib/palette";

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border border-border-strong px-1.5 py-0.5 text-[11px] font-medium leading-4 text-secondary",
        className,
      )}
      {...props}
    />
  );
}

const ICONS = { good: CheckCircle2, warning: AlertTriangle, serious: AlertOctagon, critical: XCircle } as const;

/** Status badge: color + icon + label (never color alone). */
export function StatusBadge({ status, label, className }: { status: keyof typeof STATUS_COLORS; label: string; className?: string }) {
  const Icon = ICONS[status];
  return (
    <Badge className={cn("gap-1", className)}>
      <Icon className="size-3" style={{ color: STATUS_COLORS[status] }} aria-hidden />
      <span>{label}</span>
    </Badge>
  );
}

/** A small color tick for pipeline identity (the only color on monochrome surfaces). */
export function ColorTick({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block h-3 w-1 rounded-full", className)} style={{ background: color }} />;
}
