"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, Handshake, Search, User, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { saveTask } from "@/lib/tasks/actions";
import type { TaskView, UserOption } from "@/lib/tasks/queries";
import { PRIORITIES, PRIORITY_LABELS, type Priority } from "@/lib/tasks/core";
import { toLocalInput } from "./reason-dialog";

type Related = { type: "deal" | "account" | "contact"; id: string; title: string };
type Hit = Related & { subtitle?: string };

type Defaults = { dealId?: string; dealName?: string; accountId?: string; accountName?: string; contactId?: string; contactName?: string };

const ICON = { deal: Handshake, account: Building2, contact: User } as const;

export function TaskDialog({
  open,
  onOpenChange,
  task,
  users,
  defaults,
  tz,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  task?: TaskView | null;
  users: UserOption[];
  defaults?: Defaults;
  /** The user's profile zone for the due-date picker (QA-12). */
  tz?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        {open ? <TaskForm task={task} users={users} defaults={defaults} tz={tz} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function initialRelated(task: TaskView | null | undefined, defaults: Defaults | undefined): Related[] {
  const r: Related[] = [];
  if (task?.dealId && task.dealName) r.push({ type: "deal", id: task.dealId, title: task.dealName });
  else if (!task && defaults?.dealId) r.push({ type: "deal", id: defaults.dealId, title: defaults.dealName ?? "Deal" });
  if (task?.accountId && task.accountName) r.push({ type: "account", id: task.accountId, title: task.accountName });
  else if (!task && defaults?.accountId) r.push({ type: "account", id: defaults.accountId, title: defaults.accountName ?? "Account" });
  if (task?.contactId && task.contactName) r.push({ type: "contact", id: task.contactId, title: task.contactName });
  else if (!task && defaults?.contactId) r.push({ type: "contact", id: defaults.contactId, title: defaults.contactName ?? "Contact" });
  return r;
}

/** Mounted fresh each time the dialog opens, so state initializes from props (no reset effect). */
function TaskForm({ task, users, defaults, tz, onDone }: { task?: TaskView | null; users: UserOption[]; defaults?: Defaults; tz?: string; onDone: () => void }) {
  const router = useRouter();
  const formId = useId();
  const [title, setTitle] = useState(task?.title ?? "");
  const [due, setDue] = useState(() => toLocalInput(task?.dueAt, tz));
  const [assigneeId, setAssigneeId] = useState(task?.assigneeId ?? users[0]?.id ?? "");
  const [priority, setPriority] = useState<Priority>((task?.priority as Priority) || "medium");
  const [description, setDescription] = useState(task?.description ?? "");
  const [related, setRelated] = useState<Related[]>(() => initialRelated(task, defaults));
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>({});
  const [busy, setBusy] = useState(false);

  const idOf = (t: Related["type"]) => related.find((r) => r.type === t)?.id ?? null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await saveTask({
      id: task?.id,
      title,
      description: description || null,
      // zone-less wall time: the server resolves it in the user's profile zone (QA-12)
      dueAt: due || null,
      assigneeId: assigneeId || null,
      priority,
      dealId: idOf("deal"),
      accountId: idOf("account"),
      contactId: idOf("contact"),
    });
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    toast.success(task ? "Task updated" : "Task created");
    onDone();
    router.refresh();
  }

  return (
        <form onSubmit={submit} aria-describedby={`${formId}-desc`}>
          <DialogHeader>
            <DialogTitle>{task ? "Edit task" : "New task"}</DialogTitle>
            <DialogDescription id={`${formId}-desc`}>
              {task?.origin && task.origin !== "manual" ? "Created automatically — edits are audit-logged." : "Press ⌘/Ctrl + Enter to save."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.currentTarget.closest("form") as HTMLFormElement | null)?.requestSubmit();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-title`}>Title</Label>
              <Input
                id={`${formId}-title`}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
                maxLength={300}
                aria-invalid={Boolean(errors.title)}
                placeholder="e.g. Send revised pro forma to Reach"
              />
              <FieldError msgs={errors.title} />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-due`}>Due</Label>
                <Input id={`${formId}-due`} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
                <FieldError msgs={errors.dueAt} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-assignee`}>Assignee</Label>
                <NativeSelect id={`${formId}-assignee`} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} disabled={users.length <= 1}>
                  {users.map((u, i) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                      {i === 0 ? " (me)" : ""}
                    </option>
                  ))}
                </NativeSelect>
                <FieldError msgs={errors.assigneeId} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-priority`}>Priority</Label>
                <NativeSelect id={`${formId}-priority`} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABELS[p]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
            <RelatedPicker related={related} onChange={setRelated} />
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-desc-text`}>Description</Label>
              <Textarea id={`${formId}-desc-text`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
            </div>
            {task?.evidence ? (
              <blockquote className="border-l-2 border-white/60 pl-3 text-xs italic text-secondary">
                “{task.evidence}”{task.evidenceSource ? <span className="not-italic text-muted"> — {task.evidenceSource}</span> : null}
              </blockquote>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
              {busy ? "Saving…" : task ? "Save" : "Create task"}
            </Button>
          </DialogFooter>
        </form>
  );
}

function FieldError({ msgs }: { msgs?: string[] }) {
  return msgs?.length ? (
    <p role="alert" className="text-xs text-critical">
      {msgs[0]}
    </p>
  ) : null;
}

/** Search deals/accounts/contacts via /api/search (permission-scoped) — one link of each type. */
function RelatedPicker({ related, onChange }: { related: Related[]; onChange: (r: Related[]) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const listId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      timer.current = setTimeout(() => setHits([]), 0);
      return;
    }
    const ctrl = new AbortController();
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal });
        const j = (await r.json()) as { hits?: Hit[] };
        setHits((j.hits ?? []).filter((h) => ["deal", "account", "contact"].includes(h.type)));
        setActive(0);
      } catch {
        /* aborted */
      }
    }, 200);
    return () => ctrl.abort();
  }, [q]);

  const pick = (h: Hit) => {
    onChange([...related.filter((r) => r.type !== h.type), { type: h.type, id: h.id, title: h.title }]);
    setQ("");
    setHits([]);
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${listId}-q`}>Related to</Label>
      {related.length ? (
        <div className="flex flex-wrap gap-1.5">
          {related.map((r) => {
            const Icon = ICON[r.type];
            return (
              <span key={r.type} className="inline-flex items-center gap-1 rounded border border-border-strong px-2 py-0.5 text-xs text-body">
                <Icon className="size-3 text-muted" aria-hidden />
                <span className="sr-only">{r.type}:</span>
                {r.title}
                <button type="button" aria-label={`Remove ${r.type} ${r.title}`} className="text-muted hover:text-fg" onClick={() => onChange(related.filter((x) => x.type !== r.type))}>
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" aria-hidden />
        <Input
          id={`${listId}-q`}
          className="pl-8"
          placeholder="Search a deal, account or contact…"
          value={q}
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (!hits.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(hits.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(hits[active]!);
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setHits([]);
            }
          }}
        />
        {hits.length ? (
          <ul id={listId} role="listbox" className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border-strong bg-surface-2 p-1">
            {hits.map((h, i) => {
              const Icon = ICON[h.type];
              return (
                <li
                  key={`${h.type}:${h.id}`}
                  role="option"
                  aria-selected={i === active}
                  className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm ${i === active ? "bg-surface-3 text-fg" : "text-body"}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(h);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <Icon className="size-3.5 text-muted" aria-hidden />
                  <span className="truncate">{h.title}</span>
                  {h.subtitle ? <span className="ml-auto truncate text-xs text-muted">{h.subtitle}</span> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
