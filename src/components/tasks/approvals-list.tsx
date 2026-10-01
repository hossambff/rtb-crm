"use client";
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Check, Clock, X } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { decideApproval } from "@/lib/approvals/actions";
import { approvalDetail, approvalKindLabel, approverRoleLabel } from "@/lib/approvals/kinds";
import type { ApprovalView } from "@/lib/approvals/service";
import { fmtInTz } from "@/lib/tasks/core";
import { cn } from "@/lib/utils";
import { ReasonDialog } from "./reason-dialog";

function StatusChip({ status }: { status: string }) {
  if (status === "approved") return <StatusBadge status="good" label="Approved" />;
  if (status === "rejected") return <StatusBadge status="critical" label="Rejected" />;
  if (status === "failed") return <StatusBadge status="serious" label="Failed" />;
  return <StatusBadge status="warning" label="Pending" />;
}

/** C7: SLA chip — overdue (critical), due soon (warning), on track (neutral). */
function SlaChip({ a }: { a: ApprovalView }) {
  if (!a.sla?.dueLabel) return null;
  const label = a.sla.dueLabel.replace(/^./, (c) => c.toUpperCase());
  if (a.sla.state === "overdue") return <StatusBadge status="critical" label={label} />;
  if (a.sla.state === "due_soon") return <StatusBadge status="warning" label={label} />;
  return <StatusBadge status="info" label={label} />;
}

function requester(a: ApprovalView) {
  return a.requesterName ?? (a.requestedBy.startsWith("system:") ? "the spreadsheet import (system)" : "someone");
}

export function ApprovalsList({ pending, mine, tz }: { pending: ApprovalView[]; mine: ApprovalView[]; tz: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const deepLinked = params.get("approval");
  // The sticky mobile decision bar belongs to the full approvals inbox, not to embeds (My Day).
  const bar = usePathname() === "/tasks";
  const [busy, start] = React.useTransition();
  const [rejecting, setRejecting] = React.useState<ApprovalView | null>(null);
  const [done, setDone] = React.useState<Set<string>>(() => new Set());
  const visible = React.useMemo(() => pending.filter((a) => !done.has(a.id)), [pending, done]);
  const [selectedId, setSelectedId] = React.useState<string | null>(() => (deepLinked && pending.some((a) => a.id === deepLinked) ? deepLinked : (pending[0]?.id ?? null)));
  const selected = visible.find((a) => a.id === selectedId) ?? visible[0] ?? null;
  const overdue = visible.filter((a) => a.sla?.state === "overdue").length;

  React.useEffect(() => {
    if (!deepLinked) return;
    document.getElementById(`approval-${deepLinked}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [deepLinked]);

  const markDone = (a: ApprovalView) => {
    setDone((prev) => new Set(prev).add(a.id));
    const idx = visible.findIndex((x) => x.id === a.id);
    setSelectedId(visible[idx + 1]?.id ?? visible[idx - 1]?.id ?? null);
  };

  const approve = (a: ApprovalView) =>
    start(async () => {
      const res = await decideApproval({ id: a.id, decision: "approved" });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Approved");
      markDone(a);
      router.refresh();
    });

  return (
    <div className={cn("space-y-8", bar && "pb-28 sm:pb-0")}>
      <section aria-labelledby="appr-pending">
        <h3 id="appr-pending" className="mb-2 flex flex-wrap items-baseline gap-x-2 text-xs font-medium uppercase tracking-wide text-muted">
          Waiting on you <span className="tabular">{visible.length}</span>
          {overdue ? <span className="normal-case tracking-normal text-secondary">· {overdue} overdue</span> : null}
        </h3>
        {!visible.length ? (
          <EmptyState title="No pending approvals" description="Probability overrides, proposals, registrations and budget requests you can decide appear here." />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
            {visible.map((a) => {
              const isSel = selected?.id === a.id;
              const detail = approvalDetail(a.payload);
              return (
                <li
                  key={a.id}
                  id={`approval-${a.id}`}
                  className={cn(
                    "relative flex flex-wrap items-start gap-3 px-4 py-3 transition-colors duration-150",
                    a.id === deepLinked && "bg-surface-2/60",
                    isSel && "max-sm:bg-surface-2",
                  )}
                >
                  {/* Mobile: the whole row selects it for the sticky decision bar. */}
                  <button
                    type="button"
                    className={cn("absolute inset-0 sm:hidden", !bar && "hidden")}
                    aria-pressed={isSel}
                    aria-label={`Select ${approvalKindLabel(a.kind)}: ${a.label}`}
                    onClick={() => setSelectedId(a.id)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>{approvalKindLabel(a.kind)}</Badge>
                      <span className="text-sm font-medium text-fg">{a.label}</span>
                    </div>
                    {detail ? <p className="mt-0.5 text-xs text-secondary">{detail}</p> : null}
                    {a.note ? <p className="mt-0.5 line-clamp-3 text-xs italic text-secondary">“{a.note}”</p> : null}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                      <SlaChip a={a} />
                      {a.escalatedAt ? <Badge>Escalated</Badge> : null}
                      <span>
                        {requester(a)} · <span title={fmtInTz(a.createdAt, tz)}>waiting {a.sla?.waiting ?? "—"}</span>
                      </span>
                    </div>
                  </div>
                  <div className={cn("shrink-0 gap-2", bar ? "hidden sm:flex" : "flex")}>
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => approve(a)}>
                      <Check /> Approve
                    </Button>
                    <Button size="sm" variant="destructive" disabled={busy} onClick={() => setRejecting(a)}>
                      <X /> Reject
                    </Button>
                  </div>
                </li>
              );
            })}
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
                    {approvalKindLabel(a.kind)} · {a.label}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-1 text-[11px] text-muted">
                    {a.status === "pending" ? (
                      <>
                        <Clock className="size-3" aria-hidden />
                        <span>
                          With {approverRoleLabel(a.approverRole)}
                          {a.escalatedAt ? " (escalated)" : ""} · waiting {a.sla?.waiting ?? "—"}
                          {a.sla?.dueLabel ? ` · ${a.sla.dueLabel}` : ""}
                        </span>
                      </>
                    ) : (
                      <span>
                        {fmtInTz(a.createdAt, tz)}
                        {a.deciderName ? ` · decided by ${a.deciderName}` : ""}
                        {a.note ? ` — “${a.note}”` : ""}
                      </span>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Mobile sticky decision bar (375 px): big targets for the selected request. */}
      {bar && selected ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border-strong bg-surface-2/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:hidden" role="region" aria-label="Decide selected request">
          <p className="mb-2 truncate text-xs text-secondary">
            <span className="text-muted">{approvalKindLabel(selected.kind)} · </span>
            {selected.label}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button size="lg" variant="destructive" className="h-12 text-base" disabled={busy} onClick={() => setRejecting(selected)}>
              <X /> Reject
            </Button>
            <Button size="lg" variant="primary" className="h-12 text-base" disabled={busy} onClick={() => approve(selected)}>
              <Check /> Approve
            </Button>
          </div>
        </div>
      ) : null}

      <ReasonDialog
        open={Boolean(rejecting)}
        onOpenChange={(o) => !o && setRejecting(null)}
        title="Reject request"
        description={rejecting ? `${approvalKindLabel(rejecting.kind)} · ${rejecting.label}` : undefined}
        confirmLabel="Reject"
        onSubmit={async ({ reason }) => {
          const target = rejecting!;
          const res = await decideApproval({ id: target.id, decision: "rejected", note: reason });
          if (!res.ok) return res.error;
          toast.success("Rejected");
          markDone(target);
          router.refresh();
          return null;
        }}
      />
    </div>
  );
}
