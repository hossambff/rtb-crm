import { StatusBadge } from "@/components/ui/badge";
import type { Severity } from "@/lib/alerts/rules";

const MAP: Record<Severity, { status: "info" | "warning" | "serious" | "critical"; label: string }> = {
  critical: { status: "critical", label: "Critical" },
  serious: { status: "serious", label: "Serious" },
  warning: { status: "warning", label: "Warning" },
  info: { status: "info", label: "Info" },
};

/** Alert severity: critical = rose, serious = peach, warning = butter, info = neutral gray — always icon + label. */
export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  const m = MAP[severity];
  return <StatusBadge status={m.status} label={m.label} className={className} />;
}
