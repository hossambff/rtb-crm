import { fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * MUU display with provenance: research estimates are shown with "~", italic and a dotted underline so they are never
 * mistaken for reported/verified audience (PRD ACC-3).
 */
export function MuuValue({ value, confidence, source, className }: { value: number | null | undefined; confidence?: string | null; source?: string | null; className?: string }) {
  if (value == null) return <span className={cn("text-muted", className)}>—</span>;
  const estimate = confidence === "estimate";
  const title = [estimate ? "Estimate" : confidence === "verified" ? "Verified" : "Reported", source].filter(Boolean).join(" · ");
  return (
    <span
      title={title}
      className={cn("tabular", estimate ? "italic text-secondary underline decoration-dotted decoration-border-strong underline-offset-4" : "text-body", className)}
    >
      {estimate ? "~" : ""}
      {fmtNumber(value, { compact: true })}
    </span>
  );
}

/** Source + confidence chip for audience metrics. */
export function ConfidenceBadge({ confidence }: { confidence: string | null | undefined }) {
  if (!confidence) return null;
  const label = confidence === "estimate" ? "estimate" : confidence === "verified" ? "verified" : "reported";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide",
        confidence === "estimate" ? "border-dashed border-border-strong italic text-muted" : confidence === "verified" ? "border-border-strong text-fg" : "border-border text-secondary",
      )}
    >
      {label}
    </span>
  );
}
