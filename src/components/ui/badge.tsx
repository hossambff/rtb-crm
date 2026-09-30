import * as React from "react";
import { CheckCircle2, AlertTriangle, AlertOctagon, Info, Loader2, XCircle } from "lucide-react";
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

const ICONS = { good: CheckCircle2, warning: AlertTriangle, serious: AlertOctagon, critical: XCircle, info: Info, progress: Loader2 } as const;
/** Neutral states (QA-27): "info" is not "good", and "in progress" is not a warning — both use the gray axis tone. */
const NEUTRAL = "#828282";

/** Status badge: color + icon + label (never color alone). */
export function StatusBadge({
  status,
  label,
  className,
}: {
  status: keyof typeof STATUS_COLORS | "info" | "progress";
  label: string;
  className?: string;
}) {
  const Icon = ICONS[status];
  const color = status === "info" || status === "progress" ? NEUTRAL : STATUS_COLORS[status];
  return (
    <Badge className={cn("gap-1", className)}>
      <Icon className={cn("size-3", status === "progress" && "animate-spin motion-reduce:animate-none")} style={{ color }} aria-hidden />
      <span>{label}</span>
    </Badge>
  );
}

/** A small color tick for pipeline identity (the only color on monochrome surfaces). */
export function ColorTick({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block h-3 w-1 rounded-full", className)} style={{ background: color }} />;
}
