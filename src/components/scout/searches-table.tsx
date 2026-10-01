"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Play, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import { fmtRelative } from "@/lib/format";
import { deleteSearch, previewSearchRun, runSearch } from "@/lib/scout/actions";
import { RunStatusBadge } from "./bits";
import { CostEstimate, type BudgetView, type EstimateLine } from "./budget-notice";

export type SearchRow = {
  id: string;
  name: string;
  summary: string;
  schedule: string;
  ownerName: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunId: string | null;
  total: number;
  pending: number;
  accepted: number;
  canEdit: boolean;
};

export function SearchesTable({ rows, canCreate }: { rows: SearchRow[]; canCreate: boolean }) {
  const router = useRouter();
  const [runFor, setRunFor] = React.useState<SearchRow | null>(null);
  if (!rows.length)
    return (
      <EmptyState
        title="No searches yet"
        description="Build a search from filters, a plain-English description, lookalikes of won partners, or a domain list."
        action={
          canCreate ? (
            <Button asChild variant="primary" size="sm">
              <Link href="/scout/searches/new">New search</Link>
            </Button>
          ) : undefined
        }
      />
    );
  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="table-cards w-full min-w-[860px] text-sm">
          <thead className="bg-surface-1 text-left text-xs font-medium text-muted">
            <tr className="border-b border-border">
              <th className="px-4 py-2">Search</th>
              <th className="px-3 py-2">Owner</th>
              <th className="px-3 py-2">Schedule</th>
              <th className="px-3 py-2">Last run</th>
              <th className="px-3 py-2 text-right">Candidates</th>
              <th className="px-3 py-2 text-right">To review</th>
              <th className="px-3 py-2 text-right">Accepted</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-2/60">
                <td data-primary className="px-4 py-2.5">
                  <div className="min-w-0">
                    <Link href={`/scout?tab=queue&search=${r.id}&state=all`} className="font-medium text-fg hover:underline">
                      {r.name}
                    </Link>
                    <p className="text-xs font-normal text-muted">{r.summary}</p>
                  </div>
                </td>
                <td data-label="Owner" className="px-3 py-2.5 text-secondary">{r.ownerName ?? "—"}</td>
                <td data-label="Schedule" className="px-3 py-2.5">
                  <Badge>{r.schedule === "weekly" ? "Weekly" : "Once"}</Badge>
                </td>
                <td data-label="Last run" className="px-3 py-2.5 text-secondary">
                  {r.lastRunStatus ? (
                    <Link href={r.lastRunId ? `/scout/runs/${r.lastRunId}` : "#"} className="inline-flex items-center gap-2">
                      <RunStatusBadge status={r.lastRunStatus} />
                      <span className="text-xs text-muted">{r.lastRunAt ? fmtRelative(r.lastRunAt) : ""}</span>
                    </Link>
                  ) : (
                    <span className="text-muted">Never</span>
                  )}
                </td>
                <td data-label="Candidates" className="px-3 py-2.5 text-right tabular">{r.total}</td>
                <td data-label="To review" className="px-3 py-2.5 text-right tabular">{r.pending}</td>
                <td data-label="Accepted" className="px-3 py-2.5 text-right tabular">{r.accepted}</td>
                <td data-actions className="px-3 py-2.5">
                  <div className="flex justify-end gap-1">
                    {r.canEdit ? (
                      <>
                        <Button size="sm" onClick={() => setRunFor(r)}>
                          <Play aria-hidden /> Run
                        </Button>
                        <Button asChild size="icon-sm" variant="ghost" aria-label={`Edit ${r.name}`}>
                          <Link href={`/scout/searches/${r.id}`}>
                            <Pencil />
                          </Link>
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Delete ${r.name}`}
                          onClick={async () => {
                            if (!window.confirm(`Delete “${r.name}” and its unreviewed candidates?`)) return;
                            const res = await deleteSearch({ id: r.id });
                            if (!res.ok) return void toast.error(res.error);
                            toast.success("Search deleted");
                            router.refresh();
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </>
                    ) : (
                      <span className="text-xs text-muted">View only</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RunDialog search={runFor} onClose={() => setRunFor(null)} />
    </>
  );
}

function RunDialog({ search, onClose }: { search: SearchRow | null; onClose: () => void }) {
  const router = useRouter();
  const [data, setData] = React.useState<{ lines: EstimateLine[]; budget: BudgetView; pending: boolean; domains: number } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!search) return;
    let live = true;
    previewSearchRun({ searchId: search.id }).then((r) => {
      if (!live) return;
      if (!r.ok) setErr(r.error);
      else setData({ lines: r.data.estimate.lines, budget: r.data.budget, pending: r.data.pendingRequest, domains: r.data.estimate.domainsExpected });
    });
    return () => {
      live = false;
      setData(null);
      setErr(null);
    };
  }, [search]);
  return (
    <Dialog open={Boolean(search)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run “{search?.name}”</DialogTitle>
          <DialogDescription>Only new domains are added; already-scouted, suppressed and recently rejected domains are skipped.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {err ? <p className="text-sm text-secondary">{err}</p> : data ? <CostEstimate lines={data.lines} budget={data.budget} entity="scout_search" entityId={search?.id} pendingRequest={data.pending} /> : <Skeleton className="h-28 w-full" />}
          {data ? <p className="text-xs text-muted">Up to ~{data.domains} domains.</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!data?.budget.allowed || busy}
            onClick={async () => {
              if (!search) return;
              setBusy(true);
              const r = await runSearch({ searchId: search.id });
              setBusy(false);
              if (!r.ok) return void toast.error(r.error);
              if (r.data.blocked) return void toast.error(r.data.message);
              toast.success("Run started");
              onClose();
              router.push(r.data.runId ? `/scout/runs/${r.data.runId}` : "/scout?tab=runs");
            }}
          >
            {busy ? "Starting…" : "Run now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
