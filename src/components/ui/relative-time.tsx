import { fmtDate, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * "13 minutes ago" that is safe to render on the server and in client components (QA-15): the server and the
 * browser compute it a few seconds apart, so the text can legitimately differ by a unit — the mismatch warning is
 * suppressed for this element only, and the absolute date is always available as a tooltip.
 */
export function RelativeTime({ value, className }: { value: Date | string | null | undefined; className?: string }) {
  if (!value) return <span className={className}>—</span>;
  const iso = typeof value === "string" ? value : value.toISOString();
  return (
    <time dateTime={iso} title={fmtDate(iso, "d MMM yyyy, HH:mm")} className={cn(className)} suppressHydrationWarning>
      {fmtRelative(value)}
    </time>
  );
}
