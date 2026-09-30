"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, X } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { decideApproval } from "@/lib/approvals/actions";
import type { ApprovalView } from "@/lib/approvals/service";
import { fmtInTz } from "@/lib/tasks/core";
import { ReasonDialog } from "./reason-dialog";

const KIND_LABELS: Record<string, string> = {
  probability_override: "Probability override",
  proposal: "Proposal",
  lead_registration: "Lead registration",
  scout_budget: "Scout budget",
  stage_gate: "Stage gate",
};

function PayloadLine({ p }: { p: Record<string, unknown> }) {
  const parts: string[] = [];
  if (typeof p.probability === "number") parts.push(`Requested ${Math.round(p.probability * 100)}%`);
  if (typeof p.fromProbability === "number") parts.push(`from ${Math.round(p.fromProbability * 100)}%`);
  if (typeof p.monthlyCents === "number") parts.push(`$${(p.monthlyCents / 100).toFixed(2)}/month`);
  if (typeof p.reason === "string") parts.push(`“${p.reason}”`);
  if (typeof p.dealIds === "string") parts.push(p.dealIds);
  return parts.length ? <p className="mt-0.5 text-xs text-secondary">{parts.join(" · ")}</p> : null;
}

function StatusChip({ status }: { status: string }) {
  if (status === "approved") return <StatusBadge status="good" label="Approved" />;
  if (status === "rejected") return <StatusBadge status="critical" label="Rejected" />;
  return <StatusBadge status="warning" label="Pending" />;
}

export function ApprovalsList({ pending, mine, tz }: { pending: ApprovalView[]; mine: ApprovalView[]; tz: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [rejecting, setRejecting] = useState<ApprovalView | null>(null);

  const approve = (a: ApprovalView) =>
    start(async () => {
      const res = await decideApproval({ id: a.id, decision: "approved" });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Approved");
      router.refresh();
    });

  return (
    <div className="space-y-8">
      <section aria-labelledby="appr-pending">
        <h3 id="appr-pending" className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
          Waiting on you <span className="tabular">{pending.length}</span>
        </h3>
        {!pending.length ? (
          <EmptyState title="No pending approvals" description="Probability overrides, proposals, registrations and budget requests you can decide appear here." />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
            {pending.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{KIND_LABELS[a.kind] ?? a.kind}</Badge>
                    <span className="text-sm font-medium text-fg">{a.label}</span>
                  </div>
                  <PayloadLine p={a.payload} />
                  {a.note ? <p className="mt-0.5 text-xs italic text-secondary">“{a.note}”</p> : null}
                  <p className="mt-1 text-[11px] text-muted">
                    Requested by {a.requesterName ?? "someone"} · {fmtInTz(a.createdAt, tz)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => approve(a)}>
                    <Check /> Approve
                  </Button>
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => setRejecting(a)}>
                    <X /> Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {mine.length ? (
        <section aria-labelledby="appr-mine">
          <h3 id="appr-mine" className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Your requests
          </h3>
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
            {mine.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <StatusChip status={a.status} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-fg">
                    {KIND_LABELS[a.kind] ?? a.kind} · {a.label}
                  </p>
                  <p className="text-[11px] text-muted">
                    {fmtInTz(a.createdAt, tz)}
                    {a.deciderName ? ` · decided by ${a.deciderName}` : ""}
                    {a.status !== "pending" && a.note ? ` — “${a.note}”` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ReasonDialog
        open={Boolean(rejecting)}
        onOpenChange={(o) => !o && setRejecting(null)}
        title="Reject request"
        description={rejecting ? `${KIND_LABELS[rejecting.kind] ?? rejecting.kind} · ${rejecting.label}` : undefined}
        confirmLabel="Reject"
        onSubmit={async ({ reason }) => {
          const res = await decideApproval({ id: rejecting!.id, decision: "rejected", note: reason });
          if (!res.ok) return res.error;
          toast.success("Rejected");
          router.refresh();
          return null;
        }}
      />
    </div>
  );
}
