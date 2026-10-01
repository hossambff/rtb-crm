"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  Activity,
  AlarmClock,
  ArrowRightLeft,
  BellRing,
  BookOpen,
  CalendarClock,
  Check,
  Ellipsis,
  LifeBuoy,
  ListChecks,
  Mail,
  Sparkles,
  Stamp,
  Target,
  TrendingUp,
  UserRoundPlus,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { NativeSelect, Label } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { dayBounds } from "@/lib/alerts/time";
import { fmtInTz } from "@/lib/tasks/core";
import { SNOOZE_LABELS } from "@/lib/queue/core";
import { focusedRowKey } from "@/lib/queue/undo-core";
import type { QueueAction, QueueItem, QueueKind, SnoozePreset } from "@/lib/queue/types";
import { queueDelegate, queueDone, queueRestore, queueSnooze, runQueueAction } from "@/lib/queue/actions";

const VISIBLE = 10;

const KIND: Record<QueueKind, { icon: LucideIcon; label: string }> = {
  task: { icon: ListChecks, label: "Task" },
  alert: { icon: BellRing, label: "Alert" },
  approval: { icon: Stamp, label: "Approval" },
  reply: { icon: Mail, label: "Reply" },
  meeting: { icon: CalendarClock, label: "Meeting" },
  deal: { icon: Target, label: "Deal" },
  handoff: { icon: ArrowRightLeft, label: "Handoff" },
  help: { icon: LifeBuoy, label: "Help request" },
  signal: { icon: Activity, label: "Signal" },
  forecast: { icon: TrendingUp, label: "Forecast" },
  sequence: { icon: Workflow, label: "Sequence" },
  story: { icon: BookOpen, label: "Story" },
  setup: { icon: Sparkles, label: "Setup" },
};

function dueLabel(dueAt: string | null | undefined, now: Date, tz: string): { text: string; overdue: boolean } | null {
  if (!dueAt) return null;
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return null;
  const ms = now.getTime() - due.getTime();
  if (ms > 0) {
    const h = Math.floor(ms / 3_600_000);
    return { text: h < 1 ? "Overdue" : h < 24 ? `${h}h overdue` : `${Math.floor(h / 24)}d overdue`, overdue: true };
  }
  const { end } = dayBounds(now, tz);
  if (due < end) return { text: `Due ${fmtInTz(due, tz, "time")}`, overdue: false };
  if (due < dayBounds(new Date(end.getTime() + 3_600_000), tz).end) return { text: "Tomorrow", overdue: false };
  return { text: fmtInTz(due, tz, "date"), overdue: false };
}

const has = (item: QueueItem, k: QueueAction["kind"]) => item.actions.some((a) => a.kind === k);
type ServerAction = Extract<QueueAction, { kind: "server" }>;
type LinkAction = Extract<QueueAction, { kind: "link" }>;

function primaryOf(item: QueueItem): LinkAction | ServerAction | null {
  const server = item.actions.filter((a): a is ServerAction => a.kind === "server");
  return server.find((a) => a.primary) ?? item.actions.find((a): a is LinkAction => a.kind === "link") ?? server[0] ?? null;
}

export function TodayQueue({
  items,
  nowIso,
  tz,
  users,
  meId,
  tomorrow,
}: {
  items: QueueItem[];
  nowIso: string;
  tz: string;
  users: { id: string; name: string }[];
  meId: string;
  tomorrow: { tasks: number; meetings: number; firstMeeting: { title: string | null; at: string } | null };
}) {
  const router = useRouter();
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(0);
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const [delegateFor, setDelegateFor] = useState<QueueItem | null>(null);
  const [confirmFor, setConfirmFor] = useState<{ item: QueueItem; action: ServerAction } | null>(null);
  const [, start] = useTransition();
  /** True while focus is inside the queue — the selection is only shown (and acted on) then. */
  const [focusIn, setFocusIn] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const live = useMemo(() => items.filter((i) => !hidden.has(i.key)), [items, hidden]);
  const shown = expanded ? live : live.slice(0, VISIBLE);
  const sel = Math.min(selected, Math.max(0, shown.length - 1));

  const hide = (key: string, on: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const undo = useCallback(
    (key: string, from: "done" | "snooze") =>
      start(async () => {
        const r = await queueRestore({ key, from });
        if (!r.ok) return void toast.error(r.error);
        hide(key, false);
        toast.success("Restored");
      }),
    [],
  );

  const done = useCallback(
    (item: QueueItem) => {
      if (!has(item, "done")) return void toast.message("This one needs action — open it, or snooze it.");
      hide(item.key, true);
      start(async () => {
        const r = await queueDone({ key: item.key });
        if (!r.ok) {
          hide(item.key, false);
          return void toast.error(r.error);
        }
        const verb = item.kind === "task" ? "Done" : item.kind === "alert" ? "Resolved" : item.kind === "reply" ? "Cleared until they write again" : "Cleared from Today";
        toast.success(`${verb}: ${item.title}`, r.data.undoable ? { action: { label: "Undo", onClick: () => undo(item.key, "done") } } : undefined);
      });
    },
    [undo],
  );

  const snooze = useCallback(
    (item: QueueItem, preset: SnoozePreset) => {
      setSnoozeFor(null);
      hide(item.key, true);
      start(async () => {
        const r = await queueSnooze({ key: item.key, preset });
        if (!r.ok) {
          hide(item.key, false);
          return void toast.error(r.error);
        }
        toast.success(`Snoozed until ${fmtInTz(r.data.until, tz, preset === "1h" ? "time" : "datetime")}`, r.data.undoable ? { action: { label: "Undo", onClick: () => undo(item.key, "snooze") } } : undefined);
      });
    },
    [tz, undo],
  );

  const runServer = useCallback((item: QueueItem, a: ServerAction) => {
    setConfirmFor(null);
    start(async () => {
      const r = await runQueueAction({ actionId: a.actionId, payload: a.payload });
      if (!r.ok) return void toast.error(r.error);
      if (!r.data.keep) hide(item.key, true);
      const href = r.data.href;
      if (href) {
        // e.g. a stage gate needs input: show the message with a link, and open it.
        toast.message(r.data.message ?? a.label, { action: { label: "Open", onClick: () => router.push(href) } });
        router.push(href);
      } else toast.success(r.data.message ?? `${a.label}: done`);
    });
  }, [router]);

  const activate = useCallback(
    (item: QueueItem, a: LinkAction | ServerAction | null = primaryOf(item)) => {
      if (!a) return;
      if (a.kind === "link") router.push(a.href);
      else if (a.confirm) setConfirmFor({ item, action: a });
      else runServer(item, a);
    },
    [router, runServer],
  );

  // Keyboard (QA MAJ-01): j/k move · e done · s snooze · Enter open. Keys act ONLY on the row that visibly holds focus
  // (or contains the focused control). From the page body, j/k just enter the queue on the first row; e/s/Enter do
  // nothing. Ignored while typing, in menus/dialogs, or with modifiers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.closest("[role=dialog],[role=menu]"))) return;
      if (!shown.length) return;
      const focus = (i: number) => {
        const idx = Math.max(0, Math.min(shown.length - 1, i));
        setSelected(idx);
        rowRefs.current.get(shown[idx]!.key)?.focus();
      };
      const rowKey = focusedRowKey(t);
      const idx = rowKey ? shown.findIndex((i) => i.key === rowKey) : -1;
      if (idx < 0) {
        // Not in the queue: only j/k from the page body, and only to enter it (never to act).
        if ((e.key === "j" || e.key === "k") && (!t || t === document.body)) {
          e.preventDefault();
          focus(0);
        }
        return;
      }
      const item = shown[idx]!;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        focus(idx + 1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        focus(idx - 1);
      } else if (e.key === "e") {
        e.preventDefault();
        done(item);
      } else if (e.key === "s" && has(item, "snooze")) {
        e.preventDefault();
        setSnoozeFor(item.key);
      } else if (e.key === "Enter" && t?.getAttribute("data-queue-row") === item.key) {
        e.preventDefault();
        activate(item);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, done, activate]);

  if (!live.length) return <ClearState tomorrow={tomorrow} tz={tz} />;

  return (
    <div
      data-queue
      onFocus={() => setFocusIn(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusIn(false);
      }}
    >
      <ol className="-mx-2 space-y-px" aria-label="Today, most urgent first">
        {shown.map((item, idx) => {
          const k = KIND[item.kind] ?? KIND.task;
          const Icon = k.icon;
          const due = dueLabel(item.dueAt, now, tz);
          const primary = primaryOf(item);
          const secondaryServer = item.actions.filter((a): a is ServerAction => a.kind === "server" && a !== primary);
          // Extra links (e.g. a signal's "Review move", "Open email") — shown next to the primary and in the ⋯ menu.
          const secondaryLinks = item.actions.filter((a): a is LinkAction => a.kind === "link" && a !== primary);
          const isSel = idx === sel;
          const showSel = isSel && focusIn; // only highlight the row the keys would act on
          return (
            <li
              key={item.key}
              ref={(el) => {
                if (el) rowRefs.current.set(item.key, el);
                else rowRefs.current.delete(item.key);
              }}
              data-queue-row={item.key}
              tabIndex={isSel ? 0 : -1}
              aria-label={`${k.label}: ${item.title}`}
              aria-current={showSel ? "true" : undefined}
              onFocus={() => setSelected(idx)}
              onClick={() => setSelected(idx)}
              className={cn(
                "group relative flex items-start gap-3 rounded-md px-2 py-2.5 outline-none transition-colors duration-150",
                showSel ? "bg-surface-2/70" : "hover:bg-surface-2/40",
                "focus-visible:ring-2 focus-visible:ring-white/80",
              )}
            >
              <span aria-hidden className={cn("absolute inset-y-2 left-0 w-px rounded-full transition-colors duration-150", showSel ? "bg-fg" : "bg-transparent")} />
              <Icon className="mt-0.5 size-4 shrink-0 text-muted" strokeWidth={1.5} aria-hidden />
              <div className="min-w-0 flex-1">
                <Link href={item.href} className="line-clamp-2 text-sm text-fg hover:underline" tabIndex={-1}>
                  {item.title}
                </Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                  {item.severity === "critical" || item.severity === "serious" || item.severity === "warning" ? (
                    <StatusBadge status={item.severity} label={item.severity[0]!.toUpperCase() + item.severity.slice(1)} />
                  ) : null}
                  {due ? due.overdue ? <StatusBadge status="critical" label={due.text} /> : <span className="tabular">{due.text}</span> : null}
                  {item.context ? <span className="min-w-0 max-w-[16rem] truncate">{item.context}</span> : null}
                  {item.detail ? <span className="line-clamp-1 min-w-0 max-w-full text-muted">{item.detail}</span> : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {primary ? (
                  primary.kind === "link" ? (
                    <Button asChild size="sm" variant={showSel ? "primary" : "secondary"} className="hidden sm:inline-flex">
                      <Link href={primary.href} tabIndex={isSel ? 0 : -1}>
                        {primary.label}
                      </Link>
                    </Button>
                  ) : (
                    <Button size="sm" variant={showSel ? "primary" : "secondary"} className="hidden sm:inline-flex" tabIndex={isSel ? 0 : -1} onClick={() => activate(item, primary)}>
                      {primary.label}
                    </Button>
                  )
                ) : null}
                {secondaryLinks[0] ? (
                  <Button asChild size="sm" variant="ghost" className="hidden md:inline-flex">
                    <Link href={secondaryLinks[0].href} tabIndex={isSel ? 0 : -1}>
                      {secondaryLinks[0].label}
                    </Link>
                  </Button>
                ) : null}
                {has(item, "done") ? (
                  <Button variant="ghost" size="icon-sm" aria-label={`Done: ${item.title}`} title="Done (e)" tabIndex={isSel ? 0 : -1} onClick={() => done(item)}>
                    <Check />
                  </Button>
                ) : null}
                {has(item, "snooze") ? (
                  <DropdownMenu open={snoozeFor === item.key} onOpenChange={(o) => setSnoozeFor(o ? item.key : null)}>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Snooze: ${item.title}`} title="Snooze (s)" tabIndex={isSel ? 0 : -1}>
                        <AlarmClock />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <p className="px-2 py-1 text-[11px] uppercase tracking-wider text-muted">Snooze</p>
                      {(Object.keys(SNOOZE_LABELS) as SnoozePreset[]).map((p) => (
                        <DropdownMenuItem key={p} onSelect={() => snooze(item, p)}>
                          {SNOOZE_LABELS[p]}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                {primary || secondaryServer.length || secondaryLinks.length || has(item, "delegate") ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`More actions: ${item.title}`} tabIndex={isSel ? 0 : -1}>
                        <Ellipsis />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {primary ? (
                        <DropdownMenuItem className="sm:hidden" onSelect={() => activate(item, primary)}>
                          {primary.label}
                        </DropdownMenuItem>
                      ) : null}
                      {secondaryServer.map((a) => (
                        <DropdownMenuItem key={a.actionId} onSelect={() => activate(item, a)}>
                          {a.label}
                        </DropdownMenuItem>
                      ))}
                      {secondaryLinks.map((a) => (
                        <DropdownMenuItem key={`${a.label}-${a.href}`} asChild>
                          <Link href={a.href}>{a.label}</Link>
                        </DropdownMenuItem>
                      ))}
                      {has(item, "delegate") ? (
                        <>
                          {secondaryServer.length ? <DropdownMenuSeparator /> : null}
                          <DropdownMenuItem onSelect={() => setDelegateFor(item)}>
                            <UserRoundPlus /> Delegate…
                          </DropdownMenuItem>
                        </>
                      ) : null}
                      <DropdownMenuItem asChild>
                        <Link href={item.href}>Open details</Link>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        {live.length > VISIBLE ? (
          <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            {expanded ? "Show fewer" : `Show ${live.length - VISIBLE} more`}
          </Button>
        ) : (
          <span className="text-xs text-muted">That&apos;s everything for today.</span>
        )}
        <p className="hidden items-center gap-2 text-[11px] text-muted sm:flex" aria-hidden>
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> move <Kbd>e</Kbd> done <Kbd>s</Kbd> snooze <Kbd>↵</Kbd> open · on the focused row
        </p>
      </div>

      <DelegateDialog item={delegateFor} users={users.filter((u) => u.id !== meId)} onClose={() => setDelegateFor(null)} onDone={(key) => hide(key, true)} />

      <Dialog open={Boolean(confirmFor)} onOpenChange={(o) => !o && setConfirmFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmFor?.action.label}</DialogTitle>
            <DialogDescription>{confirmFor?.item.title}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm text-body">{confirmFor?.action.confirm}</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmFor(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={() => confirmFor && runServer(confirmFor.item, confirmFor.action)}>
              {confirmFor?.action.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border-strong px-1 font-sans text-[10px] leading-4 text-secondary">{children}</kbd>;
}

function DelegateDialog({ item, users, onClose, onDone }: { item: QueueItem | null; users: { id: string; name: string }[]; onClose: () => void; onDone: (key: string) => void }) {
  const [to, setTo] = useState("");
  const [pending, start] = useTransition();
  return (
    <Dialog open={Boolean(item)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delegate</DialogTitle>
          <DialogDescription className="line-clamp-2">{item?.title}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!item || !to) return;
            start(async () => {
              const r = await queueDelegate({ key: item.key, userId: to });
              if (!r.ok) return void toast.error(r.error);
              onDone(item.key);
              onClose();
              setTo("");
              toast.success(`Handed to ${users.find((u) => u.id === to)?.name ?? "teammate"} — they've been notified.`);
            });
          }}
        >
          <DialogBody>
            {users.length ? (
              <div className="space-y-1.5">
                <Label htmlFor="delegate-to">Hand it to</Label>
                <NativeSelect id="delegate-to" value={to} onChange={(e) => setTo(e.target.value)} required>
                  <option value="">Choose a teammate…</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : (
              <p className="text-sm text-muted">There&apos;s nobody you can delegate to.</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={pending || !to}>
              {pending ? "Delegating…" : "Delegate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The calm "inbox zero" moment: a quietly drawn check, and a peek at tomorrow. */
function ClearState({ tomorrow, tz }: { tomorrow: { tasks: number; meetings: number; firstMeeting: { title: string | null; at: string } | null }; tz: string }) {
  const parts: string[] = [];
  if (tomorrow.meetings) parts.push(`${tomorrow.meetings} meeting${tomorrow.meetings === 1 ? "" : "s"}${tomorrow.firstMeeting ? `, first at ${fmtInTz(tomorrow.firstMeeting.at, tz, "time")}` : ""}`);
  if (tomorrow.tasks) parts.push(`${tomorrow.tasks} task${tomorrow.tasks === 1 ? "" : "s"} due`);
  return (
    <div className="flex flex-col items-center px-4 py-12 text-center" role="status">
      <svg aria-hidden width="56" height="56" viewBox="0 0 56 56" fill="none" className="mb-5">
        <circle cx="28" cy="28" r="26" stroke="var(--color-border-strong)" />
        <path d="M18 29l7 7 13-15" stroke="var(--color-fg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="rtb-draw" pathLength={1} />
      </svg>
      <p className="font-display text-2xl text-fg">You&apos;re clear for today</p>
      <p className="mt-2 max-w-sm text-sm text-muted">
        {parts.length ? `Tomorrow: ${parts.join(" · ")}.` : "Nothing waiting tomorrow yet. A good moment to prospect or tidy a deal."}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button asChild variant="secondary" size="sm">
          <Link href="/pipelines">Review my pipeline</Link>
        </Button>
      </div>
      <style>{`.rtb-draw{stroke-dasharray:1;stroke-dashoffset:1;animation:rtb-draw .6s .15s ease-out forwards}@keyframes rtb-draw{to{stroke-dashoffset:0}}@media (prefers-reduced-motion:reduce){.rtb-draw{animation:none;stroke-dashoffset:0}}`}</style>
    </div>
  );
}
