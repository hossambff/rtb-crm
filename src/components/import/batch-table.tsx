import Link from "next/link";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { fmtDate, fmtNumber, fmtRelative } from "@/lib/format";
import { RollbackButton } from "./rollback-button";

export type BatchRow = {
  id: string;
  fileName: string;
  sheetName: string | null;
  target: string;
  pipelineKey: string | null;
  status: string;
  stats: Record<string, number>;
  createdAt: Date;
  rolledBackAt: Date | null;
  createdByName: string | null;
  canRollback: boolean;
};

export function BatchStatus({ status }: { status: string }) {
  if (status === "completed") return <StatusBadge status="good" label="Completed" />;
  if (status === "rolled_back") return <StatusBadge status="warning" label="Rolled back" />;
  if (status === "failed") return <StatusBadge status="critical" label="Failed" />;
  return <StatusBadge status="serious" label={status} />;
}

export function BatchTable({ batches }: { batches: BatchRow[] }) {
  if (!batches.length) return <EmptyState title="No imports yet" description="Imports you run appear here with row-level results and one-click rollback." />;
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface-1">
      <table className="w-full min-w-[860px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="h-9 px-3 font-medium">File</th>
            <th className="px-3 font-medium">Target</th>
            <th className="px-3 font-medium">Status</th>
            <th className="px-3 text-right font-medium">Rows</th>
            <th className="px-3 text-right font-medium">Accounts +/~</th>
            <th className="px-3 text-right font-medium">Deals +/~</th>
            <th className="px-3 text-right font-medium">Contacts +</th>
            <th className="px-3 font-medium">By</th>
            <th className="px-3 font-medium">When</th>
            <th className="px-3" />
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id} className="border-b border-border last:border-0 hover:bg-surface-2">
              <td className="max-w-[300px] px-3 py-2">
                <Link href={`/import/history/${b.id}`} className="block truncate text-fg hover:underline" title={b.fileName}>
                  {b.fileName}
                </Link>
                {b.sheetName ? <span className="block truncate text-xs text-muted" title={b.sheetName}>{b.sheetName}</span> : null}
              </td>
              <td className="px-3">
                <Badge className="whitespace-nowrap">
                  {b.target.replace(/_/g, " ")}
                  {b.pipelineKey ? ` · ${b.pipelineKey}` : ""}
                </Badge>
              </td>
              <td className="px-3">
                <BatchStatus status={b.status} />
              </td>
              <td className="px-3 text-right tabular text-secondary">{fmtNumber(b.stats.rows ?? 0)}</td>
              <td className="px-3 text-right tabular text-secondary">
                {fmtNumber(b.stats.accountsCreated ?? 0)} / {fmtNumber(b.stats.accountsUpdated ?? 0)}
              </td>
              <td className="px-3 text-right tabular text-secondary">
                {fmtNumber(b.stats.dealsCreated ?? 0)} / {fmtNumber(b.stats.dealsUpdated ?? 0)}
              </td>
              <td className="px-3 text-right tabular text-secondary">{fmtNumber(b.stats.contactsCreated ?? 0)}</td>
              <td className="px-3 text-secondary">{b.createdByName ?? "Migration script"}</td>
              <td className="whitespace-nowrap px-3 text-xs text-muted" title={fmtDate(b.createdAt, "d MMM yyyy HH:mm")}>
                {fmtRelative(b.createdAt)}
              </td>
              <td className="px-3 text-right">{b.canRollback && b.status !== "rolled_back" ? <RollbackButton batchId={b.id} label={`${b.fileName}${b.sheetName ? ` › ${b.sheetName}` : ""}`} /> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
