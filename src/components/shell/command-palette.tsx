"use client";
import { Command } from "cmdk";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import * as Icons from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { CommandPreviewDialog } from "@/components/deals/list/command-preview";
import { myOpenTasks, previewCommandText } from "@/lib/commands/actions";
import { actionsLeadForQuery, looksLikeCommand, rankEntries, type PaletteEntry } from "@/lib/commands/parse";
import { getDealSelection, onDealSelection } from "@/lib/commands/selection";
import type { Preview } from "@/lib/commands/types";
import { logDealActivity } from "@/lib/deals/actions";
import { saveTask, snoozeTask } from "@/lib/tasks/actions";
import type { NavItem } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { ModKey } from "@/components/ui/mod-key";

type Hit = { type: "deal" | "account" | "contact"; id: string; title: string; subtitle?: string; href: string };
type Mode = { kind: "root" } | { kind: "task"; deal: { id: string; title: string } | null } | { kind: "activity"; type: "note" | "call"; deal: { id: string; title: string } | null } | { kind: "pickDeal"; then: "note" | "call" | "task" } | { kind: "snooze" };
type Entry = PaletteEntry & { icon: keyof typeof Icons; hint?: string; run: () => void };

const RECENTS_KEY = "rso.palette.recents.v1";
const DEAL_PATH = /^\/deals\/([0-9a-f-]{36})/i;

function loadRecents(): Record<string, number> {
  try {
    return JSON.parse(window.localStorage.getItem(RECENTS_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}
function bumpRecent(id: string) {
  try {
    const r = loadRecents();
    r[id] = Math.min(50, (r[id] ?? 0) + 1);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(r));
  } catch {
    /* storage unavailable — ranking just loses its memory */
  }
}

const itemCls = "flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-body data-[selected=true]:bg-surface-3";
const groupCls = "text-[11px] text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1";

/**
 * ⌘K: search anything, go anywhere, create records, and run bulk commands in plain language (V2 A8).
 * Commands are parsed (rules → AI fallback) into a structured command and ALWAYS shown as a permission-filtered preview
 * before anything changes. Ranking: prefix > word start > fuzzy, boosted by what you use most (kept in this browser).
 */
export function CommandPalette({ open, onOpenChange, nav }: { open: boolean; onOpenChange: (o: boolean) => void; nav: NavItem[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<Hit[]>([]);
  const [mode, setMode] = React.useState<Mode>({ kind: "root" });
  const [recents, setRecents] = React.useState<Record<string, number>>({});
  const [selection, setSelection] = React.useState<string[]>([]);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const dealOnPage = React.useMemo(() => pathname.match(DEAL_PATH)?.[1] ?? null, [pathname]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  React.useEffect(() => onDealSelection(setSelection), []);

  const [wasOpen, setWasOpen] = React.useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setRecents(loadRecents());
      setSelection(getDealSelection());
      setMode({ kind: "root" });
    }
  }

  React.useEffect(() => {
    if (mode.kind !== "root" && mode.kind !== "pickDeal") return;
    if (q.trim().length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        if (res.ok) setHits((await res.json()).hits ?? []);
      } catch {
        /* aborted */
      }
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, mode.kind]);

  const close = () => {
    onOpenChange(false);
    setQ("");
    setHits([]);
    setMode({ kind: "root" });
  };
  const go = (href: string, id?: string) => {
    if (id) bumpRecent(id);
    close();
    router.push(href);
  };
  const prefill = (text: string, id: string) => {
    bumpRecent(id);
    setQ(text);
    setHits([]);
  };

  const runCommandText = async (text: string) => {
    bumpRecent("cmd:run");
    close();
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    setPreviewOpen(true);
    const r = await previewCommandText({ text, selection: selection.length ? selection : undefined });
    setPreviewLoading(false);
    if (!r.ok) return setPreviewError(r.error);
    if (r.data.command.verb === "show" && r.data.href) {
      setPreviewOpen(false);
      router.push(r.data.href);
      return;
    }
    setPreview(r.data);
  };

  const startActivity = (type: "note" | "call") => {
    bumpRecent(`cmd:${type}`);
    setQ("");
    if (dealOnPage) setMode({ kind: "activity", type, deal: { id: dealOnPage, title: "this deal" } });
    else setMode({ kind: "pickDeal", then: type });
  };

  const actions: Entry[] = [
    { id: "cmd:create-deal", label: "Create deal", keywords: ["new deal", "add deal"], group: "Create", icon: "Plus", run: () => go("/deals?create=1", "cmd:create-deal") },
    { id: "cmd:task", label: "New task", keywords: ["create task", "todo", "reminder"], group: "Create", icon: "ListPlus", hint: dealOnPage ? "on this deal" : undefined, run: () => (bumpRecent("cmd:task"), setQ(""), setMode({ kind: "task", deal: dealOnPage ? { id: dealOnPage, title: "this deal" } : null })) },
    { id: "cmd:note", label: "Add note to deal", keywords: ["note", "create note"], group: "Create", icon: "StickyNote", hint: dealOnPage ? "this deal" : "pick a deal", run: () => startActivity("note") },
    { id: "cmd:call", label: "Log call", keywords: ["call", "log activity", "phone"], group: "Create", icon: "PhoneCall", hint: dealOnPage ? "this deal" : "pick a deal", run: () => startActivity("call") },
    { id: "cmd:move", label: "Move deals to a stage…", keywords: ["move", "stage", "bulk"], group: "Bulk", icon: "MoveRight", hint: "e.g. move NET deals idle 30 days to Nurture", run: () => prefill(selection.length ? "move selected to " : "move ", "cmd:move") },
    { id: "cmd:assign", label: "Assign deals to…", keywords: ["assign", "reassign", "owner", "bulk"], group: "Bulk", icon: "UserRoundPlus", hint: "e.g. assign these to Will", run: () => prefill(selection.length ? "assign selected to " : "assign ", "cmd:assign") },
    { id: "cmd:tag", label: "Tag deals…", keywords: ["tag", "label", "bulk"], group: "Bulk", icon: "Tag", hint: "e.g. tag my top 10 ENT deals as q4-push", run: () => prefill(selection.length ? "tag selected as " : "tag ", "cmd:tag") },
    { id: "cmd:close", label: "Set expected close dates…", keywords: ["close date", "forecast", "bulk"], group: "Bulk", icon: "CalendarClock", hint: "e.g. set close date of my NET deals in Proposal Sent to end of quarter", run: () => prefill(selection.length ? "set close date of selected to " : "set close date of ", "cmd:close") },
    { id: "cmd:enroll", label: "Enroll in sequence…", keywords: ["enroll", "sequence", "outreach", "bulk"], group: "Bulk", icon: "Workflow", hint: "e.g. enroll selected in Q4 outreach", run: () => prefill(selection.length ? "enroll selected in " : "enroll ", "cmd:enroll") },
    { id: "cmd:snooze", label: "Snooze a task", keywords: ["snooze", "later", "defer"], group: "Create", icon: "AlarmClock", run: () => (bumpRecent("cmd:snooze"), setQ(""), setMode({ kind: "snooze" })) },
    { id: "cmd:forecast", label: "Confirm my forecast", keywords: ["forecast", "commit", "best case"], group: "Do", icon: "TrendingUp", run: () => go("/forecast?view=mine", "cmd:forecast") },
    { id: "cmd:no-next", label: "Show my deals with no next step", keywords: ["hygiene", "next step"], group: "Do", icon: "ListX", run: () => go("/deals?owner=me&nonext=1", "cmd:no-next") },
    { id: "cmd:idle", label: "Show my deals idle 30+ days", keywords: ["idle", "stale", "inactive"], group: "Do", icon: "Hourglass", run: () => go("/deals?owner=me&idle=30&sort=idle", "cmd:idle") },
  ];
  const navEntries: Entry[] = [
    { href: "/deals", label: "Deals", icon: "Table2" } as const,
    ...nav.map((n) => ({ href: n.href, label: n.label, icon: n.icon })),
  ]
    .filter((n, i, arr) => arr.findIndex((x) => x.href === n.href) === i)
    .map((n) => ({ id: `go:${n.href}`, label: n.label, keywords: [n.href.slice(1)], group: "Go to", icon: n.icon as keyof typeof Icons, run: () => go(n.href, `go:${n.href}`) }));

  const query = q.trim();
  // QA MAJ-20: actions and go-to stay ranked on the query even when it starts with a verb; the command preview is one
  // more option (first only when no action matches), never a mode that hides the rest.
  const isCmd = looksLikeCommand(query);
  const byQuery = rankEntries(query, actions, recents);
  // "add note to Acme": no label contains the whole sentence — rank on its leading verb phrase instead.
  const rankedActions = (byQuery.length || !isCmd ? byQuery : rankEntries(query.split(/\s+/).slice(0, 2).join(" "), actions, recents)).slice(0, query ? 6 : 5);
  const rankedNav = rankEntries(query, navEntries, recents).slice(0, query ? 6 : 8);
  const actionsFirst = !isCmd || actionsLeadForQuery(query, rankedActions);

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
        <DialogContent
          className="top-[15%] max-w-xl translate-y-0 p-0 sm:top-[20%]"
          onEscapeKeyDown={(e) => {
            if (mode.kind !== "root") {
              e.preventDefault();
              setMode({ kind: "root" });
              setQ("");
            }
          }}
        >
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          {mode.kind === "root" || mode.kind === "pickDeal" ? (
            <Command shouldFilter={false} className="text-sm" loop>
              <div className="flex items-center gap-2 border-b border-border px-4">
                {mode.kind === "pickDeal" ? <Icons.Briefcase className="size-4 shrink-0 text-muted" aria-hidden /> : <Icons.Search className="size-4 shrink-0 text-muted" aria-hidden />}
                <Command.Input
                  autoFocus
                  value={q}
                  onValueChange={setQ}
                  placeholder={mode.kind === "pickDeal" ? `Which deal? (${mode.then === "task" ? "task" : mode.then === "call" ? "log call" : "note"})` : "Search, go to, or type a command…"}
                  className="h-12 w-full bg-transparent text-body outline-none placeholder:text-muted"
                />
                {selection.length && mode.kind === "root" ? (
                  <span className="shrink-0 rounded border border-border-strong px-1.5 text-[10px] text-secondary tabular" title="Deals selected on the Deals list — say “these” or “selected”">
                    {selection.length} selected
                  </span>
                ) : null}
              </div>
              <Command.List className="max-h-[min(60vh,420px)] overflow-y-auto p-2">
                <Command.Empty className="px-3 py-6 text-center text-muted">{mode.kind === "pickDeal" ? "Type a deal name." : "No results."}</Command.Empty>
                {mode.kind === "root" && actionsFirst && rankedActions.length ? (
                  <Command.Group heading="Actions" className={groupCls}>
                    {rankedActions.map((a) => (
                      <EntryItem key={a.id} e={a} />
                    ))}
                  </Command.Group>
                ) : null}
                {mode.kind === "root" && isCmd ? (
                  <Command.Group heading="Command" className={groupCls}>
                    <Command.Item value="run-command" onSelect={() => void runCommandText(query)} className={itemCls}>
                      <Icons.Zap className="size-4 text-fg" strokeWidth={1.5} />
                      <span className="min-w-0 flex-1 truncate">
                        Preview: <span className="text-fg">{query}</span>
                      </span>
                      <span className="shrink-0 text-[11px] text-muted">nothing changes until you confirm</span>
                    </Command.Item>
                  </Command.Group>
                ) : null}
                {query.length >= 2 && hits.length ? (
                  <Command.Group heading={mode.kind === "pickDeal" ? "Deals" : "Records"} className={groupCls}>
                    {hits
                      .filter((h) => mode.kind !== "pickDeal" || h.type === "deal")
                      .map((h) => (
                        <Command.Item
                          key={`${h.type}:${h.id}`}
                          value={`${h.type}:${h.id}`}
                          onSelect={() => {
                            if (mode.kind === "pickDeal") {
                              const deal = { id: h.id, title: h.title };
                              setQ("");
                              setHits([]);
                              setMode(mode.then === "task" ? { kind: "task", deal } : { kind: "activity", type: mode.then, deal });
                              return;
                            }
                            go(h.href);
                          }}
                          className={itemCls}
                        >
                          <span className="w-16 text-[10px] uppercase tracking-wider text-muted">{h.type}</span>
                          <span className="truncate">{h.title}</span>
                          {h.subtitle ? <span className="ml-auto truncate text-xs text-muted">{h.subtitle}</span> : null}
                        </Command.Item>
                      ))}
                  </Command.Group>
                ) : null}
                {mode.kind === "root" && !actionsFirst && rankedActions.length ? (
                  <Command.Group heading="Actions" className={groupCls}>
                    {rankedActions.map((a) => (
                      <EntryItem key={a.id} e={a} />
                    ))}
                  </Command.Group>
                ) : null}
                {mode.kind === "root" && query.length >= 3 ? (
                  <Command.Group heading="Copilot" className={groupCls}>
                    <Command.Item value="ask-copilot" onSelect={() => go(`/copilot?q=${encodeURIComponent(query)}`, "cmd:copilot")} className={itemCls}>
                      <Icons.Sparkles className="size-4 text-muted" /> Ask Copilot: “{query}”
                    </Command.Item>
                  </Command.Group>
                ) : null}
                {mode.kind === "root" && rankedNav.length ? (
                  <Command.Group heading="Go to" className={groupCls}>
                    {rankedNav.map((a) => (
                      <EntryItem key={a.id} e={a} />
                    ))}
                  </Command.Group>
                ) : null}
              </Command.List>
              <Footer back={mode.kind === "pickDeal"} />
            </Command>
          ) : mode.kind === "task" ? (
            <TaskForm dealId={mode.deal?.id ?? null} dealTitle={mode.deal?.title ?? null} onDone={close} onBack={() => setMode({ kind: "root" })} />
          ) : mode.kind === "activity" ? (
            <ActivityForm type={mode.type} deal={mode.deal!} onDone={close} onBack={() => setMode({ kind: "root" })} />
          ) : (
            <SnoozeForm onDone={close} onBack={() => setMode({ kind: "root" })} />
          )}
        </DialogContent>
      </Dialog>
      <CommandPreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} preview={preview} loading={previewLoading} error={previewError} />
    </>
  );
}

function EntryItem({ e }: { e: Entry }) {
  const Icon = (Icons as unknown as Record<string, Icons.LucideIcon>)[e.icon] ?? Icons.Circle;
  return (
    <Command.Item value={e.id} onSelect={e.run} className={itemCls}>
      <Icon className="size-4 text-muted" strokeWidth={1.5} />
      <span className="truncate">{e.label}</span>
      {e.hint ? <span className="ml-auto hidden truncate text-[11px] text-muted sm:inline">{e.hint}</span> : null}
    </Command.Item>
  );
}

function Footer({ back }: { back?: boolean }) {
  return (
    <div className="hidden items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-muted sm:flex">
      <span>
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> move
      </span>
      <span>
        <Kbd>Enter</Kbd> select
      </span>
      <span>
        <Kbd>Esc</Kbd> {back ? "back" : "close"}
      </span>
      <span className="ml-auto">Try “move NET deals idle 30 days to Nurture”</span>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="mr-0.5 rounded border border-border-strong px-1 text-[10px] text-secondary">{children}</kbd>;
}

function FormShell({ title, icon, onBack, children }: { title: string; icon: keyof typeof Icons; onBack: () => void; children: React.ReactNode }) {
  const Icon = (Icons as unknown as Record<string, Icons.LucideIcon>)[icon] ?? Icons.Circle;
  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <button type="button" onClick={onBack} className="rounded p-1 text-muted hover:text-fg" aria-label="Back">
          <Icons.ChevronLeft className="size-4" />
        </button>
        <Icon className="size-4 text-muted" strokeWidth={1.5} aria-hidden />
        <p className="font-display text-lg text-fg">{title}</p>
      </div>
      {children}
    </div>
  );
}

function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function nextMonday(): string {
  const d = new Date();
  const add = ((8 - d.getDay()) % 7) || 7;
  return localDate(add);
}

function TaskForm({ dealId, dealTitle, onDone, onBack }: { dealId: string | null; dealTitle: string | null; onDone: () => void; onBack: () => void }) {
  const [title, setTitle] = React.useState("");
  const [due, setDue] = React.useState(localDate(1));
  const [linkDeal, setLinkDeal] = React.useState(Boolean(dealId));
  const [pending, start] = React.useTransition();
  const submit = () =>
    start(async () => {
      const r = await saveTask({ title: title.trim(), dueAt: due || null, dealId: linkDeal && dealId ? dealId : null });
      if (!r.ok) return void toast.error(r.error);
      toast.success("Task created", { description: `Due ${due}` });
      onDone();
    });
  return (
    <FormShell title="New task" icon="ListPlus" onBack={onBack}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) submit();
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="pal-task-title">What needs doing?</Label>
          <Input id="pal-task-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} placeholder="Send the revised proposal" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {[
            ["Today", localDate(0)],
            ["Tomorrow", localDate(1)],
            ["Next Monday", nextMonday()],
          ].map(([l, v]) => (
            <button key={l} type="button" onClick={() => setDue(v!)} className={cn("h-7 rounded-md border px-2 text-xs transition-colors duration-150", due === v ? "border-white/70 bg-surface-3 text-fg" : "border-border text-secondary hover:text-fg")}>
              {l}
            </button>
          ))}
          <Input type="date" aria-label="Due date" value={due} onChange={(e) => setDue(e.target.value)} className="h-7 w-auto text-xs" />
        </div>
        {dealId ? (
          <label className="flex items-center gap-2 text-xs text-secondary">
            <input type="checkbox" className="size-3.5 accent-white" checked={linkDeal} onChange={(e) => setLinkDeal(e.target.checked)} /> Link to {dealTitle ?? "this deal"}
          </label>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="sm" disabled={pending || !title.trim()}>
            {pending ? <Icons.Loader2 className="animate-spin" /> : null} Create task <Kbd>↵</Kbd>
          </Button>
        </div>
      </form>
    </FormShell>
  );
}

function ActivityForm({ type, deal, onDone, onBack }: { type: "note" | "call"; deal: { id: string; title: string }; onDone: () => void; onBack: () => void }) {
  const [subject, setSubject] = React.useState(type === "call" ? "Call" : "");
  const [body, setBody] = React.useState("");
  const [minutes, setMinutes] = React.useState(type === "call" ? "15" : "");
  const [pending, start] = React.useTransition();
  const submit = () =>
    start(async () => {
      const r = await logDealActivity({ dealId: deal.id, type, subject: subject.trim() || undefined, body: body.trim() || undefined, durationMin: type === "call" && minutes ? Number(minutes) : undefined, direction: type === "call" ? "outbound" : undefined });
      if (!r.ok) return void toast.error(r.error);
      toast.success(type === "call" ? "Call logged" : "Note added", { description: deal.title === "this deal" ? undefined : deal.title });
      onDone();
    });
  return (
    <FormShell title={type === "call" ? `Log call · ${deal.title}` : `Note · ${deal.title}`} icon={type === "call" ? "PhoneCall" : "StickyNote"} onBack={onBack}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="pal-act-subject">Subject</Label>
            <Input id="pal-act-subject" autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
          </div>
          {type === "call" ? (
            <div className="w-24 space-y-1">
              <Label htmlFor="pal-act-min">Minutes</Label>
              <Input id="pal-act-min" type="number" min={0} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </div>
          ) : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor="pal-act-body">{type === "call" ? "What happened" : "Note"}</Label>
          <Textarea id="pal-act-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={20_000} rows={4} />
        </div>
        <div className="flex items-center justify-end gap-2">
          <span className="text-[11px] text-muted">
            <Kbd>
              <ModKey />
            </Kbd>
            <Kbd>Enter</Kbd>
          </span>
          <Button type="submit" variant="primary" size="sm" disabled={pending || (!subject.trim() && !body.trim())}>
            {pending ? <Icons.Loader2 className="animate-spin" /> : null} {type === "call" ? "Log call" : "Add note"}
          </Button>
        </div>
      </form>
    </FormShell>
  );
}

function SnoozeForm({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [q, setQ] = React.useState("");
  const [tasks, setTasks] = React.useState<{ id: string; title: string; dueAt: Date | null; dealName: string | null }[] | null>(null);
  const [picked, setPicked] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  React.useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const r = await myOpenTasks({ q });
      if (live) setTasks(r.ok ? r.data : []);
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  const snooze = (until: string, label: string) =>
    start(async () => {
      if (!picked) return;
      const at = until === "1h" ? new Date(Date.now() + 3_600_000).toISOString() : until;
      const r = await snoozeTask({ id: picked, until: at, reason: "Snoozed from ⌘K" });
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Snoozed until ${label}`, { description: r.data.escalated ? "Snoozed several times — your manager was notified." : undefined });
      onDone();
    });
  return (
    <FormShell title="Snooze a task" icon="AlarmClock" onBack={onBack}>
      {!picked ? (
        <div className="space-y-2">
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find one of your open tasks" aria-label="Find task" />
          <ul className="max-h-72 space-y-0.5 overflow-y-auto" role="listbox" aria-label="Your open tasks">
            {tasks == null ? <li className="px-2 py-3 text-xs text-muted">Loading…</li> : null}
            {tasks?.length === 0 ? <li className="px-2 py-3 text-xs text-muted">No open tasks.</li> : null}
            {tasks?.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => setPicked(t.id)} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm text-body hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:outline-none">
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className="shrink-0 truncate text-[11px] text-muted">{[t.dealName, t.dueAt ? new Date(t.dueAt).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null].filter(Boolean).join(" · ")}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {[
            ["In 1 hour", "1h"],
            ["Tomorrow 9 am", `${localDate(1)}T09:00`],
            ["Next Monday 9 am", `${nextMonday()}T09:00`],
          ].map(([label, until], i) => (
            <Button key={label} variant={i === 1 ? "primary" : "secondary"} disabled={pending} autoFocus={i === 1} onClick={() => snooze(until!, label!)}>
              {label}
            </Button>
          ))}
        </div>
      )}
    </FormShell>
  );
}
