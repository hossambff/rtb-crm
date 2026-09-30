"use client";
import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlarmClock, Check, Circle, MoreHorizontal, Pencil, RotateCcw, Sparkles, XCircle } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState } from "@/components/ui/misc";
import { setTaskStatus, snoozeTask } from "@/lib/tasks/actions";
import type { TaskView, UserOption } from "@/lib/tasks/queries";
import { fmtInTz, ORIGIN_LABELS, PRIORITY_LABELS, type Bucket, type Priority } from "@/lib/tasks/core";
import { cn } from "@/lib/utils";
import { ReasonDialog } from "./reason-dialog";
import { TaskDialog } from "./task-dialog";

export type TaskGroup = { key: Bucket | "done" | string; label: string; tasks: TaskView[] };

/**
 * Grouped task list. Keyboard: ↑/↓ or j/k move between tasks, x = complete/reopen, e/Enter = edit, s = snooze.
 */
export function TaskList({
  groups,
  users,
  tz,
  showAssignee = false,
  initialOpenId,
  emptyTitle = "You're all caught up",
  emptyDescription = "No open tasks. Promises from email and calls land here automatically.",
}: {
  groups: TaskGroup[];
  users: UserOption[];
  tz: string;
  showAssignee?: boolean;
  initialOpenId?: string | null;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  // QA-18 optimistic UI: a local override per task, applied only while the server copy still has the state it was
  // made from (`from`), so it disappears by itself once the refreshed data arrives — or is superseded by an undo.
  const [local, setLocal] = useState<Record<string, { status?: TaskView["status"]; snoozed?: boolean; from: string }>>({});
  const fingerprint = (t: TaskView) => `${t.status}|${t.snoozeCount}`;
  const view = (t: TaskView): TaskView & { snoozedNow?: boolean } => {
    const o = local[t.id];
    if (!o || o.from !== fingerprint(t)) return t;
    return { ...t, status: o.status ?? t.status, snoozedNow: o.snoozed };
  };
  const all = groups.flatMap((g) => g.tasks);
  const [editing, setEditing] = useState<TaskView | null>(() => (initialOpenId ? (all.find((t) => t.id === initialOpenId) ?? null) : null));
  const [snoozing, setSnoozing] = useState<TaskView | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  if (!all.length) return <EmptyState title={emptyTitle} description={emptyDescription} />;

  const setStatus = (t: TaskView, status: "open" | "done" | "cancelled") => {
    const base = all.find((x) => x.id === t.id) ?? t;
    setLocal((m) => ({ ...m, [t.id]: { status, from: fingerprint(base) } })); // instant feedback
    start(async () => {
      const res = await setTaskStatus({ id: t.id, status });
      if (!res.ok) {
        setLocal((m) => {
          const { [t.id]: _drop, ...rest } = m;
          void _drop;
          return rest;
        });
        return void toast.error(res.error);
      }
      toast.success(status === "done" ? "Task completed" : status === "open" ? "Task reopened" : "Task cancelled", {
        action: status === "done" ? { label: "Undo", onClick: () => setStatus({ ...base, status: "done" }, "open") } : undefined,
      });
      router.refresh();
    });
  };

  const move = (from: HTMLElement, dir: 1 | -1) => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-task-row]") ?? []);
    const i = rows.indexOf(from);
    rows[Math.max(0, Math.min(rows.length - 1, i + dir))]?.focus();
  };

  return (
    <div ref={listRef} className="space-y-6">
      {groups
        .filter((g) => g.tasks.length)
        .map((g) => (
          <section key={g.key} aria-labelledby={`grp-${g.key}`}>
            <h3 id={`grp-${g.key}`} className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
              {g.key === "overdue" ? <StatusBadge status="critical" label={g.label} /> : g.label}
              <span className="tabular text-muted">{g.tasks.length}</span>
            </h3>
            <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
              {g.tasks.map((raw) => {
                const t = view(raw);
                const done = t.status !== "open";
                return (
                  <li
                    key={t.id}
                    data-task-row
                    tabIndex={0}
                    aria-label={`${t.title}${t.dueAt ? `, due ${fmtInTz(t.dueAt, tz)}` : ""}`}
                    className={cn(
                      "group flex items-start gap-3 px-4 py-3 outline-none transition-colors duration-150 focus-visible:bg-surface-2 focus-visible:ring-1 focus-visible:ring-white/60",
                      t.snoozedNow && "opacity-50",
                    )}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
                      const k = e.key;
                      let handled = true;
                      if (k === "ArrowDown" || k === "j") move(e.currentTarget, 1);
                      else if (k === "ArrowUp" || k === "k") move(e.currentTarget, -1);
                      else if (k === "x" && t.canEdit) setStatus(t, done ? "open" : "done");
                      else if ((k === "e" || k === "Enter") && t.canEdit && !done) setEditing(t);
                      else if (k === "s" && t.canEdit && !done) setSnoozing(t);
                      else handled = false;
                      if (handled) e.preventDefault();
                    }}
                  >
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={t.status === "done"}
                      aria-label={done ? `Reopen ${t.title}` : `Complete ${t.title}`}
                      disabled={!t.canEdit}
                      onClick={() => setStatus(t, done ? "open" : "done")}
                      className="mt-0.5 shrink-0 text-muted transition-colors duration-150 hover:text-fg disabled:opacity-40"
                    >
                      {t.status === "done" ? <Check className="size-4 text-good" /> : t.status === "cancelled" ? <XCircle className="size-4" /> : <Circle className="size-4" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <button
                          type="button"
                          tabIndex={-1}
                          className={cn("text-left text-sm font-medium text-fg hover:underline", done && "text-muted line-through")}
                          onClick={() => t.canEdit && !done && setEditing(t)}
                        >
                          {t.title}
                        </button>
                        {t.priority && (t.priority === "top10" || t.priority === "high") ? <Badge>{PRIORITY_LABELS[t.priority as Priority]}</Badge> : null}
                        {t.origin !== "manual" ? (
                          <Badge title={t.evidenceSource ?? undefined}>
                            <Sparkles className="size-3" aria-hidden /> {ORIGIN_LABELS[t.origin] ?? t.origin}
                          </Badge>
                        ) : null}
                        {t.owedBy === "us" ? <Badge>We owe</Badge> : t.owedBy === "them" ? <Badge>They owe</Badge> : null}
                        {t.snoozedNow ? <Badge>Snoozed</Badge> : null}
                        {t.snoozeCount >= 3 ? (
                          <StatusBadge status="warning" label={`Snoozed ${t.snoozeCount}×`} />
                        ) : t.snoozeCount > 0 ? (
                          <Badge>Snoozed {t.snoozeCount}×</Badge>
                        ) : null}
                      </div>
                      {t.evidence ? (
                        <blockquote className="mt-1.5 line-clamp-2 border-l-2 border-white/50 pl-2 text-xs italic text-secondary">“{t.evidence}”</blockquote>
                      ) : null}
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                        <span className={cn("tabular", g.key === "overdue" && "text-secondary")}>
                          {done ? `${t.status === "done" ? "Completed" : "Cancelled"} ${fmtInTz(t.completedAt ?? t.dueAt, tz)}` : t.dueAt ? `Due ${fmtInTz(t.dueAt, tz)}` : "No due date"}
                        </span>
                        {showAssignee && t.assigneeName ? (
                          <>
                            <span aria-hidden>·</span>
                            <span>{t.assigneeName}</span>
                          </>
                        ) : null}
                        {t.dealId && t.dealName ? (
                          <>
                            <span aria-hidden>·</span>
                            <Link href={`/deals/${t.dealId}`} className="hover:text-fg hover:underline" tabIndex={-1}>
                              {t.dealName}
                            </Link>
                          </>
                        ) : null}
                        {t.accountId && t.accountName ? (
                          <>
                            <span aria-hidden>·</span>
                            <Link href={`/accounts/${t.accountId}`} className="hover:text-fg hover:underline" tabIndex={-1}>
                              {t.accountName}
                            </Link>
                          </>
                        ) : null}
                        {t.contactId && t.contactName ? (
                          <>
                            <span aria-hidden>·</span>
                            <Link href={`/contacts/${t.contactId}`} className="hover:text-fg hover:underline" tabIndex={-1}>
                              {t.contactName}
                            </Link>
                          </>
                        ) : null}
                      </p>
                    </div>
                    {t.canEdit ? (
                      <div className="flex shrink-0 items-center gap-1">
                        {!done ? (
                          <Button size="icon-sm" variant="ghost" aria-label={`Snooze ${t.title}`} title="Snooze (s)" onClick={() => setSnoozing(t)}>
                            <AlarmClock />
                          </Button>
                        ) : null}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${t.title}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {!done ? (
                              <DropdownMenuItem onSelect={() => setEditing(t)}>
                                <Pencil /> Edit
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onSelect={() => setStatus(t, "open")}>
                                <RotateCcw /> Reopen
                              </DropdownMenuItem>
                            )}
                            {!done ? (
                              <DropdownMenuItem asChild>
                                <Link href={`/copilot?taskId=${t.id}`}>
                                  <Sparkles /> Draft it for me
                                </Link>
                              </DropdownMenuItem>
                            ) : null}
                            {!done ? (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={() => setStatus(t, "cancelled")}>
                                  <XCircle className="text-critical" /> Cancel task
                                </DropdownMenuItem>
                              </>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

      <TaskDialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)} task={editing} users={users} tz={tz} />
      <ReasonDialog
        open={Boolean(snoozing)}
        onOpenChange={(o) => !o && setSnoozing(null)}
        title="Snooze task"
        description={snoozing ? `${snoozing.title}${snoozing.snoozeCount >= 2 ? " — a 3rd snooze notifies your manager (or your team lead / sales leaders if you have none)." : ""}` : undefined}
        withUntil
        tz={tz}
        confirmLabel="Snooze"
        onSubmit={async ({ reason, until }) => {
          const target = snoozing!;
          const res = await snoozeTask({ id: target.id, reason, until: until! });
          if (!res.ok) return res.fieldErrors?.reason?.[0] ?? res.fieldErrors?.until?.[0] ?? res.error;
          setLocal((m) => ({ ...m, [target.id]: { snoozed: true, from: fingerprint(target) } }));
          toast.success(res.data.escalated ? "Snoozed — your manager (or sales leadership) was notified (3+ snoozes)" : "Task snoozed");
          router.refresh();
          return null;
        }}
      />
    </div>
  );
}
