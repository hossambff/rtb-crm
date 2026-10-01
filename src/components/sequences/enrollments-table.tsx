"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ellipsis, Pause, Play, RotateCcw, SkipForward, Square } from "lucide-react";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState } from "@/components/ui/misc";
import { RelativeTime } from "@/components/ui/relative-time";
import { pauseEnrollments, resumeEnrollments, retryEnrollment, skipEnrollmentStep, stopEnrollments } from "@/lib/sequences/actions";
import { EXIT_LABEL } from "@/lib/sequences/core";
import type { EnrollmentRow } from "@/lib/sequences/queries";
import { cn } from "@/lib/utils";

export function EnrollmentStatus({ row }: { row: Pick<EnrollmentRow, "status" | "exitReason" | "lastError"> }) {
  switch (row.status) {
    case "active":
      return <StatusBadge status="progress" label="Active" />;
    case "paused":
      return <StatusBadge status={row.lastError ? "warning" : "info"} label={row.lastError ? "Paused" : "Paused by hand"} />;
    case "failed":
      return <StatusBadge status="serious" label="Failed" />;
    case "completed":
      return <StatusBadge status="info" label="Completed" />;
    default: {
      const reason = row.exitReason ?? "manual";
      const good = reason === "replied" || reason === "meeting_booked";
      return <StatusBadge status={good ? "good" : reason === "bounced" ? "warning" : "info"} label={EXIT_LABEL[reason] ?? "Exited"} />;
    }
  }
}

type Op = "pause" | "resume" | "stop" | "retry" | "skip";

async function runOp(op: Op, ids: string[]) {
  if (op === "pause") return pauseEnrollments({ ids });
  if (op === "resume") return resumeEnrollments({ ids });
  if (op === "stop") return stopEnrollments({ ids });
  if (op === "retry") return retryEnrollment({ id: ids[0]! });
  return skipEnrollmentStep({ id: ids[0]! });
}

export function EnrollmentsTable({ rows, showSequence = false, compact = false, emptyText }: { rows: EnrollmentRow[]; showSequence?: boolean; compact?: boolean; emptyText?: string }) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const manageable = rows.filter((r) => r.canManage && ["active", "paused", "failed"].includes(r.status));
  const sel = rows.filter((r) => selected.has(r.id));

  async function act(op: Op, ids: string[], confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    const r = await runOp(op, ids);
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    const verb = { pause: "Paused", resume: "Resumed", stop: "Stopped", retry: "Retrying", skip: "Skipped a step for" }[op];
    toast.success(`${verb} ${r.data.changed} enrollment${r.data.changed === 1 ? "" : "s"}`);
    setSelected(new Set());
    router.refresh();
  }

  if (!rows.length) return <EmptyState title="Nobody enrolled yet" description={emptyText ?? "Enroll contacts from here, a contact, a deal, an account, or a Lead Scout batch."} />;

  return (
    <div className="space-y-2">
      {!compact && manageable.length ? (
        <div className="flex min-h-8 flex-wrap items-center gap-2" aria-live="polite">
          <span className="text-xs tabular text-muted">{sel.length ? `${sel.length} selected` : `${rows.length} enrollment${rows.length === 1 ? "" : "s"}`}</span>
          {sel.length ? (
            <>
              <Button size="sm" disabled={busy || !sel.some((r) => r.status === "active")} onClick={() => act("pause", sel.filter((r) => r.status === "active").map((r) => r.id))}>
                <Pause aria-hidden /> Pause
              </Button>
              <Button size="sm" disabled={busy || !sel.some((r) => r.status === "paused")} onClick={() => act("resume", sel.filter((r) => r.status === "paused").map((r) => r.id))}>
                <Play aria-hidden /> Resume
              </Button>
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => act("stop", sel.map((r) => r.id), `Stop ${sel.length} enrollment${sel.length === 1 ? "" : "s"}? Pending steps won't run.`)}>
                <Square aria-hidden /> Stop
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {/* QA MIN-29: stacked cards under `sm` (actions stay on screen at 375 px) */}
      <ul className="space-y-2 sm:hidden" aria-label="Enrollments">
        {rows.map((r) => {
          const canAct = r.canManage && ["active", "paused", "failed"].includes(r.status);
          return (
            <li key={r.id} className="rounded-lg border border-border bg-surface-1 px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/contacts/${r.contactId}`} className="font-medium text-fg hover:underline">
                    {r.contactName}
                  </Link>
                  <p className="truncate text-xs text-muted">{showSequence ? r.sequenceName : [r.accountName, r.dealName].filter(Boolean).join(" · ") || r.contactEmail || "—"}</p>
                </div>
                {canAct ? <RowActions r={r} busy={busy} act={act} /> : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary">
                <EnrollmentStatus row={r} />
                <span className="tabular">
                  Step {Math.min(r.currentStep + (r.status === "completed" ? 0 : 1), r.stepCount)}/{r.stepCount} · {r.sentCount} sent
                </span>
                {r.status === "active" && r.nextRunAt ? <RelativeTime value={r.nextRunAt} /> : null}
                {r.olderVersion ? <span className="text-muted">older steps</span> : null}
              </div>
              {r.lastError && (r.status === "failed" || r.status === "paused") ? <p className="mt-1 text-xs text-warning">{r.lastError}</p> : null}
            </li>
          );
        })}
      </ul>
      <div className="hidden overflow-x-auto rounded-lg border border-border sm:block">
        <table className={cn("w-full text-sm", compact ? "min-w-[520px]" : "min-w-[860px]")}>
          <thead className="bg-surface-1 text-left text-xs font-medium text-muted">
            <tr className="border-b border-border">
              {!compact ? (
                <th className="w-9 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    className="size-4 accent-white"
                    checked={manageable.length > 0 && manageable.every((r) => selected.has(r.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(manageable.map((r) => r.id)) : new Set())}
                  />
                </th>
              ) : null}
              <th className="px-3 py-2">{showSequence ? "Contact · sequence" : "Contact"}</th>
              <th className="px-3 py-2">Step</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">{compact ? "Next" : "Next / last"}</th>
              {!compact ? <th className="px-3 py-2">Sender</th> : null}
              <th className="px-3 py-2 text-right">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const canAct = r.canManage && ["active", "paused", "failed"].includes(r.status);
              return (
                <tr key={r.id} className={cn("border-b border-border align-top last:border-0 hover:bg-surface-2/60", selected.has(r.id) && "bg-surface-2/60")}>
                  {!compact ? (
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.contactName}`}
                        className="size-4 accent-white"
                        disabled={!canAct}
                        checked={selected.has(r.id)}
                        onChange={(e) => {
                          const n = new Set(selected);
                          if (e.target.checked) n.add(r.id);
                          else n.delete(r.id);
                          setSelected(n);
                        }}
                      />
                    </td>
                  ) : null}
                  <td className="px-3 py-2.5">
                    <Link href={`/contacts/${r.contactId}`} className="font-medium text-fg hover:underline">
                      {r.contactName}
                    </Link>
                    <p className="text-xs text-muted">
                      {showSequence ? (
                        <Link href={`/sequences/${r.sequenceId}`} className="hover:text-fg">
                          {r.sequenceName}
                        </Link>
                      ) : (
                        [r.accountName, r.dealName].filter(Boolean).join(" · ") || r.contactEmail || "—"
                      )}
                    </p>
                    {r.lastError && (r.status === "failed" || r.status === "paused") ? <p className="mt-1 max-w-md text-xs text-warning">{r.lastError}</p> : null}
                  </td>
                  <td className="px-3 py-2.5 tabular text-secondary">
                    {Math.min(r.currentStep + (r.status === "completed" ? 0 : 1), r.stepCount)}/{r.stepCount}
                    <span className="block text-xs text-muted">{r.sentCount} sent</span>
                    {r.olderVersion ? (
                      <span className="block text-xs text-muted" title="Enrolled before the steps were last edited — they keep the steps they started with">
                        older steps
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5">
                    <EnrollmentStatus row={r} />
                  </td>
                  <td className="px-3 py-2.5 text-xs text-secondary">
                    {r.status === "active" && r.nextRunAt ? <RelativeTime value={r.nextRunAt} /> : r.lastEventAt ? <RelativeTime value={r.lastEventAt} className="text-muted" /> : "—"}
                    {r.lastEventKind === "reconciled" ? <span className="block text-muted">Found in Sent after an interrupted send — not re-sent</span> : null}
                  </td>
                  {!compact ? <td className="px-3 py-2.5 text-xs text-secondary">{r.senderName ?? "—"}</td> : null}
                  <td className="px-3 py-2.5 text-right">
                    {canAct ? <RowActions r={r} busy={busy} act={act} /> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowActions({ r, busy, act }: { r: EnrollmentRow; busy: boolean; act: (op: Op, ids: string[], confirmText?: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${r.contactName}`} disabled={busy}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {r.status === "failed" ? (
          <DropdownMenuItem onSelect={() => act("retry", [r.id])}>
            <RotateCcw aria-hidden /> Retry step
          </DropdownMenuItem>
        ) : null}
        {r.status === "active" ? (
          <DropdownMenuItem onSelect={() => act("pause", [r.id])}>
            <Pause aria-hidden /> Pause
          </DropdownMenuItem>
        ) : null}
        {r.status === "paused" ? (
          <DropdownMenuItem onSelect={() => act(r.systemPaused ? "retry" : "resume", [r.id])}>
            <Play aria-hidden /> Resume
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => act("skip", [r.id], "Skip the current step and continue with the next one (after its delay)?")}>
          <SkipForward aria-hidden /> Skip this step
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => act("stop", [r.id], `Stop the sequence for ${r.contactName}?`)}>
          <Square aria-hidden /> Stop
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
