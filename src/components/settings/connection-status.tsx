import { StatusBadge } from "@/components/ui/badge";
import { fmtRelative } from "@/lib/format";

/** connected → good, error → critical, revoked/paused → warning, missing → "Not connected". */
export function ConnectionStatus({ status, lastSyncAt, pausedLabel = "Paused" }: { status: string | null | undefined; lastSyncAt?: string | null; pausedLabel?: string }) {
  if (!status) return <StatusBadge status="warning" label="Not connected" />;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {status === "connected" ? (
        <StatusBadge status="good" label="Connected" />
      ) : status === "error" ? (
        <StatusBadge status="critical" label="Needs attention" />
      ) : (
        <StatusBadge status="warning" label={pausedLabel} />
      )}
      {lastSyncAt ? <span className="text-xs text-muted">Last sync {fmtRelative(lastSyncAt)}</span> : null}
    </span>
  );
}
