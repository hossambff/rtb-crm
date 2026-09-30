"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Circle, Loader2, MinusCircle, XCircle, Hourglass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { STATUS_COLORS } from "@/lib/palette";
import { resumeRunAction } from "@/lib/scout/actions";
import { RunStatusBadge, usd } from "./bits";

export type ProgressStep = {
  key: string;
  label: string;
  actorId: string | null;
  status: string;
  costUsd: number | null;
  costEstimated: boolean;
  items: number | null;
  quarantined: number;
  note: string | null;
  error: string | null;
};

type Snapshot = { status: string; costCents: number; estimatedCostCents: number; resultsCount: number; verifiedCount: number; error: string | null; steps: ProgressStep[] };

/** Live step list for a run: polls /api/scout/runs/[id] while running; refreshes the page when it finishes. */
export function RunProgress({ runId, initial, canResume }: { runId: string; initial: Snapshot; canResume: boolean }) {
  const router = useRouter();
  const [snap, setSnap] = React.useState(initial);
  const live = snap.status === "queued" || snap.status === "running";
  React.useEffect(() => {
    if (!live) return;
    let stop = false;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/scout/runs/${runId}`, { cache: "no-store" });
        if (!r.ok || stop) return;
        const j = (await r.json()) as Snapshot;
        setSnap(j);
        if (j.status !== "queued" && j.status !== "running") router.refresh();
      } catch {
        /* transient */
      }
    }, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [live, runId, router]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <RunStatusBadge status={snap.status} />
        <span className="text-sm tabular text-secondary">
          Cost {usd(snap.costCents)} <span className="text-muted">(estimated {usd(snap.estimatedCostCents)})</span>
        </span>
        {live && canResume ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const r = await resumeRunAction({ runId });
              if (r.ok) toast.success("Resuming — finished steps are skipped");
              else toast.error(r.error);
            }}
          >
            Resume if stuck
          </Button>
        ) : null}
      </div>
      {snap.error ? <p className="text-sm text-secondary">{snap.error}</p> : null}
      <ol className="divide-y divide-border rounded-lg border border-border bg-surface-1" aria-live="polite">
        {snap.steps.length === 0 ? <li className="px-4 py-3 text-sm text-muted">Waiting to start…</li> : null}
        {snap.steps.map((st) => (
          <li key={st.key} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
            <StepIcon status={st.status} />
            <div className="min-w-0 flex-1">
              <p className="text-fg">{st.label}</p>
              <p className="text-xs text-muted">
                {st.actorId ? <span className="font-mono">{st.actorId}</span> : null}
                {[st.items != null ? `${st.items} item${st.items === 1 ? "" : "s"}` : null, st.quarantined ? `${st.quarantined} malformed quarantined` : null, st.note]
                  .filter(Boolean)
                  .map((t) => (st.actorId ? ` · ${t}` : t))
                  .join(st.actorId ? "" : " · ")}
              </p>
              {st.error ? <p className="text-xs text-secondary">{st.error}</p> : null}
            </div>
            <span className="tabular text-xs text-secondary">
              {st.costUsd != null ? `$${st.costUsd.toFixed(3)}${st.costEstimated ? " est." : ""}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepIcon({ status }: { status: string }) {
  const cls = "mt-0.5 size-4 shrink-0";
  if (status === "succeeded") return <CheckCircle2 className={cls} style={{ color: STATUS_COLORS.good }} aria-label="Done" />;
  if (status === "failed") return <XCircle className={cls} style={{ color: STATUS_COLORS.critical }} aria-label="Failed" />;
  if (status === "running") return <Loader2 className={`${cls} animate-spin text-secondary`} aria-label="Running" />;
  if (status === "waiting") return <Hourglass className={`${cls} text-secondary`} aria-label="Waiting on Apify" />;
  if (status === "skipped") return <MinusCircle className={`${cls} text-muted`} aria-label="Skipped" />;
  return <Circle className={`${cls} text-muted`} aria-label="Pending" />;
}
