"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Eye, ListTodo, Lock, Mail, Plus, Trash2, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { previewSequence, saveSequence, searchContactsForEnroll } from "@/lib/sequences/actions";
import { hasOptOutLine, KNOWN_VARIABLES, normalizeSteps, OPT_OUT_HINT, VARIABLE_HELP, validateSequence, type ExitRules, type Step, type StepKind } from "@/lib/sequences/core";
import { cn } from "@/lib/utils";
import { ModKey } from "@/components/ui/mod-key";

export type BuilderInitial = {
  id: string;
  name: string;
  description: string | null;
  steps: Step[];
  exitOn: ExitRules;
  dailyCap: number;
  shared: boolean;
  pipelineKeys: string[];
};

const KIND_ICON: Record<StepKind, React.ComponentType<{ className?: string }>> = { email: Mail, task: ListTodo, linkedin: UserPlus };
const KIND_LABEL: Record<StepKind, string> = { email: "Email", task: "Task", linkedin: "LinkedIn" };

type Field = { step: number; field: "subject" | "body" | "title" };

export function SequenceBuilder({ initial, canEdit, activeEnrollments, pipelines }: { initial: BuilderInitial; canEdit: boolean; activeEnrollments: number; pipelines: { key: string; name: string }[] }) {
  const router = useRouter();
  const [name, setName] = React.useState(initial.name);
  const [description, setDescription] = React.useState(initial.description ?? "");
  const [steps, setSteps] = React.useState<Step[]>(initial.steps.length ? initial.steps : [{ kind: "email", delayDays: 0, subject: "", body: "" }]);
  const [exitOn, setExitOn] = React.useState<ExitRules>({ reply: true, meetingBooked: true, stageChange: true, unsubscribe: true, ...initial.exitOn });
  const [dailyCap, setDailyCap] = React.useState(initial.dailyCap);
  const [shared, setShared] = React.useState(initial.shared);
  const [pipelineKeys, setPipelineKeys] = React.useState<string[]>(initial.pipelineKeys);
  const [busy, setBusy] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const focused = React.useRef<Field | null>(null);
  const refs = React.useRef(new Map<string, HTMLInputElement | HTMLTextAreaElement>());

  const normalized = React.useMemo(() => normalizeSteps(steps), [steps]);
  const problems = React.useMemo(() => validateSequence(normalized), [normalized]);
  const firstEmail = normalized.findIndex((s) => s.kind === "email");
  const optOutMissing = firstEmail >= 0 && !hasOptOutLine(normalized[firstEmail]!.body ?? "");
  const dayOf = React.useMemo(() => {
    let acc = 0;
    return normalized.map((s) => (acc += s.delayDays));
  }, [normalized]);

  const touch = () => setDirty(true);
  const update = (i: number, patch: Partial<Step>) => {
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
    touch();
  };
  const move = (i: number, d: -1 | 1) => {
    setSteps((prev) => {
      const n = [...prev];
      const j = i + d;
      if (j < 0 || j >= n.length) return prev;
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
    touch();
  };
  const add = (kind: StepKind) => {
    setSteps((prev) => [
      ...prev,
      kind === "email"
        ? { kind, delayDays: prev.length ? 3 : 0, subject: "", body: prev.some((s) => s.kind === "email") ? "Hi {{first_name}},\n\n\n{{sender_first_name}}" : `Hi {{first_name}},\n\n\n{{sender_first_name}}\n\n${OPT_OUT_HINT}`, replyInThread: true }
        : { kind, delayDays: prev.length ? 2 : 0, title: kind === "linkedin" ? "Connect with {{full_name}} on LinkedIn" : "Call {{full_name}}" },
    ]);
    touch();
  };

  function insertVariable(v: string) {
    const f = focused.current;
    if (!f) return void toast.message("Click into a subject, body or title first");
    const el = refs.current.get(`${f.step}:${f.field}`);
    const token = `{{${v}}}`;
    const cur = (steps[f.step]?.[f.field] as string | undefined) ?? "";
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    update(f.step, { [f.field]: cur.slice(0, start) + token + cur.slice(end) } as Partial<Step>);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function save(confirmed = false) {
    setBusy(true);
    const r = await saveSequence({ id: initial.id, name, description: description || null, steps: normalized, exitOn: { reply: exitOn.reply !== false, meetingBooked: exitOn.meetingBooked !== false, stageChange: exitOn.stageChange !== false, unsubscribe: true }, dailyCap, shared, pipelineKeys, confirmed });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    if (r.data.status === "confirm") {
      const list = r.data.hits.map((h) => `“${h.match}”${h.alternative ? ` (approved: “${h.alternative}”)` : ""}`).join(", ");
      if (window.confirm(`These phrases are flagged by the claims library: ${list}. Save anyway?`)) return save(true);
      return;
    }
    setDirty(false);
    toast.success(r.data.problems.length ? "Saved — fix the highlighted issues before enrolling" : "Sequence saved");
    router.refresh();
  }

  // ⌘S / Ctrl+S saves
  const saveRef = React.useRef(save);
  React.useEffect(() => {
    saveRef.current = save;
  });
  React.useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        // QA MIN-28: never save the sequence underneath an open dialog (enroll, claims confirm, …)
        if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit]);

  const ro = !canEdit;
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-5">
        <Card>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="seq-name">Name</Label>
              <Input id="seq-name" value={name} disabled={ro} onChange={(e) => (setName(e.target.value), touch())} maxLength={120} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="seq-desc">When to use it</Label>
              <Input id="seq-desc" value={description} disabled={ro} placeholder="e.g. Cold intro to independent finance publishers" onChange={(e) => (setDescription(e.target.value), touch())} maxLength={500} />
            </div>
          </CardContent>
        </Card>

        {canEdit ? (
          <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-1.5 bg-bg/95 px-1 py-2 backdrop-blur-sm" aria-label="Insert variable">
            <span className="mr-1 text-xs text-muted">Insert</span>
            {KNOWN_VARIABLES.map((v) => (
              <button
                key={v}
                type="button"
                title={VARIABLE_HELP[v]}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertVariable(v)}
                className="rounded border border-border-strong px-1.5 py-0.5 font-mono text-[11px] text-secondary transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
              >
                {`{{${v}}}`}
              </button>
            ))}
          </div>
        ) : null}

        <ol className="relative space-y-3 before:absolute before:bottom-6 before:left-[15px] before:top-6 before:w-px before:bg-border">
          {normalized.map((s, i) => {
            const Icon = KIND_ICON[s.kind];
            const isFirstEmail = i === firstEmail;
            const inThread = s.kind === "email" && !isFirstEmail && s.replyInThread !== false;
            return (
              <li key={i} className="relative flex gap-3">
                <span className="relative z-[1] mt-3 inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-2 text-secondary">
                  <Icon className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1 rounded-lg border border-border bg-surface-1">
                  <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                    <span className="text-sm font-medium text-fg">
                      {i + 1}. {KIND_LABEL[s.kind]}
                    </span>
                    <Badge className="tabular">Day {dayOf[i]}</Badge>
                    <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
                      {i === 0 ? "Wait after enrolling" : "Wait"}
                      <Input
                        type="number"
                        min={0}
                        max={60}
                        disabled={ro}
                        aria-label={`Business days to wait before step ${i + 1}`}
                        className="h-7 w-16 px-2 text-xs tabular"
                        value={s.delayDays}
                        onChange={(e) => update(i, { delayDays: Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0))) })}
                      />
                      business days
                    </label>
                    {canEdit ? (
                      <span className="flex gap-0.5">
                        <Button size="icon-sm" variant="ghost" aria-label="Move step up" disabled={i === 0} onClick={() => move(i, -1)}>
                          <ArrowUp />
                        </Button>
                        <Button size="icon-sm" variant="ghost" aria-label="Move step down" disabled={i === normalized.length - 1} onClick={() => move(i, 1)}>
                          <ArrowDown />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Delete step"
                          disabled={normalized.length === 1}
                          onClick={() => {
                            setSteps((prev) => prev.filter((_, j) => j !== i));
                            touch();
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </span>
                    ) : null}
                  </div>
                  <div className="space-y-3 px-4 py-3">
                    {s.kind === "email" ? (
                      <>
                        {!isFirstEmail ? (
                          <label className="flex items-center gap-2 text-xs text-secondary">
                            <input type="checkbox" className="size-4 accent-white" disabled={ro} checked={inThread} onChange={(e) => update(i, { replyInThread: e.target.checked })} />
                            Reply in the same thread (recommended)
                          </label>
                        ) : null}
                        {inThread ? (
                          <p className="text-xs text-muted">Subject: “Re: {normalized[firstEmail]?.subject || "…"}”</p>
                        ) : (
                          <div className="space-y-1.5">
                            <Label htmlFor={`s${i}-subject`}>Subject</Label>
                            <Input
                              id={`s${i}-subject`}
                              disabled={ro}
                              ref={(el) => void (el ? refs.current.set(`${i}:subject`, el) : refs.current.delete(`${i}:subject`))}
                              onFocus={() => (focused.current = { step: i, field: "subject" })}
                              value={s.subject ?? ""}
                              maxLength={300}
                              onChange={(e) => update(i, { subject: e.target.value })}
                            />
                          </div>
                        )}
                        <div className="space-y-1.5">
                          <Label htmlFor={`s${i}-body`}>Message</Label>
                          <Textarea
                            id={`s${i}-body`}
                            disabled={ro}
                            rows={isFirstEmail ? 9 : 5}
                            ref={(el) => void (el ? refs.current.set(`${i}:body`, el) : refs.current.delete(`${i}:body`))}
                            onFocus={() => (focused.current = { step: i, field: "body" })}
                            value={s.body ?? ""}
                            onChange={(e) => update(i, { body: e.target.value })}
                          />
                          {isFirstEmail && optOutMissing ? (
                            <p className="text-xs text-warning">
                              Add an opt-out line, e.g. “{OPT_OUT_HINT}”{" "}
                              {canEdit ? (
                                <button type="button" className="text-fg underline underline-offset-2" onClick={() => update(i, { body: `${(s.body ?? "").trimEnd()}\n\n${OPT_OUT_HINT}` })}>
                                  Add it
                                </button>
                              ) : null}
                            </p>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="space-y-1.5">
                          <Label htmlFor={`s${i}-title`}>{s.kind === "linkedin" ? "LinkedIn task" : "Task"}</Label>
                          <Input
                            id={`s${i}-title`}
                            disabled={ro}
                            ref={(el) => void (el ? refs.current.set(`${i}:title`, el) : refs.current.delete(`${i}:title`))}
                            onFocus={() => (focused.current = { step: i, field: "title" })}
                            value={s.title ?? ""}
                            maxLength={200}
                            onChange={(e) => update(i, { title: e.target.value })}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`s${i}-notes`}>Notes (optional)</Label>
                          <Textarea
                            id={`s${i}-notes`}
                            disabled={ro}
                            rows={2}
                            ref={(el) => void (el ? refs.current.set(`${i}:body`, el) : refs.current.delete(`${i}:body`))}
                            onFocus={() => (focused.current = { step: i, field: "body" })}
                            value={s.body ?? ""}
                            onChange={(e) => update(i, { body: e.target.value })}
                          />
                        </div>
                        <p className="text-xs text-muted">Creates a task for the sender; the sequence continues when it’s marked done.</p>
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        {canEdit ? (
          <div className="flex flex-wrap gap-2 pl-11">
            <Button size="sm" onClick={() => add("email")} disabled={normalized.length >= 12}>
              <Plus aria-hidden /> Email
            </Button>
            <Button size="sm" onClick={() => add("task")} disabled={normalized.length >= 12}>
              <Plus aria-hidden /> Call / task
            </Button>
            <Button size="sm" onClick={() => add("linkedin")} disabled={normalized.length >= 12}>
              <Plus aria-hidden /> LinkedIn
            </Button>
          </div>
        ) : null}
      </div>

      <aside className="space-y-5">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Rules</CardTitle>
              <CardDescription>Checked before every step.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-2.5 text-sm">
            {(
              [
                ["reply", "Stop when they reply"],
                ["meetingBooked", "Stop when a meeting is booked"],
                ["stageChange", "Stop when the deal changes stage"],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="flex items-center gap-2.5 text-body">
                <input type="checkbox" className="size-4 accent-white" disabled={ro} checked={exitOn[k] !== false} onChange={(e) => (setExitOn({ ...exitOn, [k]: e.target.checked }), touch())} />
                {l}
              </label>
            ))}
            <p className="flex items-center gap-2.5 text-secondary">
              <Lock className="size-4 text-muted" aria-hidden /> Unsubscribe, do-not-contact and bounces always stop it
            </p>
            <div className="flex items-center gap-2 pt-2">
              <Label htmlFor="seq-cap" className="flex-1">
                Daily send cap per mailbox
              </Label>
              <Input id="seq-cap" type="number" min={1} max={200} disabled={ro} className="h-8 w-20 tabular" value={dailyCap} onChange={(e) => (setDailyCap(Math.max(1, Math.min(200, Math.round(Number(e.target.value) || 1)))), touch())} />
            </div>
            <label className="flex items-center gap-2.5 pt-1 text-body">
              <input type="checkbox" className="size-4 accent-white" disabled={ro} checked={shared} onChange={(e) => (setShared(e.target.checked), touch())} />
              Shared with the team
            </label>
            {pipelines.length ? (
              <div className="space-y-1.5 pt-1">
                <p className="text-xs font-medium text-secondary">Motions (optional tag)</p>
                <div className="flex flex-wrap gap-1.5">
                  {pipelines.map((p) => {
                    const on = pipelineKeys.includes(p.key);
                    return (
                      <button
                        key={p.key}
                        type="button"
                        disabled={ro}
                        aria-pressed={on}
                        onClick={() => (setPipelineKeys(on ? pipelineKeys.filter((k) => k !== p.key) : [...pipelineKeys, p.key]), touch())}
                        className={cn("rounded border px-2 py-0.5 text-xs transition-colors duration-150", on ? "border-white text-fg" : "border-border-strong text-muted hover:text-fg")}
                      >
                        {p.key}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {problems.length ? (
          <div role="status" className="rounded-lg border border-warning/50 px-4 py-3 text-sm">
            <p className="mb-1 font-medium text-fg">Before anyone can be enrolled</p>
            <ul className="list-disc space-y-0.5 pl-4 text-secondary">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <Preview steps={normalized} />

        {canEdit ? (
          <div className="sticky bottom-3 flex items-center gap-3 rounded-lg border border-border-strong bg-surface-2 px-4 py-3">
            <div className="min-w-0 flex-1 text-xs text-muted">
              {dirty ? "Unsaved changes" : "All changes saved"}
              {activeEnrollments ? ` · ${activeEnrollments} active enrollment${activeEnrollments === 1 ? "" : "s"} keep the steps they were enrolled with — apply a new version from the People tab` : ""}
            </div>
            <Button variant="primary" disabled={busy || !dirty} onClick={() => save()}>
              {busy ? "Saving…" : "Save"} <kbd className="ml-1 hidden rounded border border-accent-inverse/20 px-1 text-[10px] sm:inline">
                <ModKey then="S" />
              </kbd>
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted">Only the owner or an admin can edit this sequence. Duplicate it to make your own version.</p>
        )}
      </aside>
    </div>
  );
}

type PreviewData = { contact: { name: string; email: string | null; dnc: boolean }; steps: { kind: string; subject: string; body: string; missing: string[] }[]; blocked: boolean };

function Preview({ steps }: { steps: Step[] }) {
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<{ id: string; fullName: string; accountName: string | null }[]>([]);
  const [contactId, setContactId] = React.useState<string | null>(null);
  const [chosenName, setChosenName] = React.useState<string | null>(null);
  const [data, setData] = React.useState<PreviewData | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const listId = React.useId();
  const choose = (r: { id: string; fullName: string }) => {
    setContactId(r.id);
    setChosenName(r.fullName);
    setQ(r.fullName);
    setResults([]);
  };

  React.useEffect(() => {
    if (q.trim().length < 2) return;
    let live = true;
    const t = setTimeout(() => searchContactsForEnroll({ q }).then((r) => live && setResults(r.ok ? r.data.slice(0, 6) : [])), 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  React.useEffect(() => {
    if (!contactId) return;
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      void previewSequence({ steps, contactId }).then((r) => {
          if (!live) return;
          setLoading(false);
          if (r.ok) setData(r.data);
          else toast.error(r.error);
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [contactId, steps]);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Eye className="size-4 text-muted" aria-hidden /> Preview
          </CardTitle>
          <CardDescription>Render every step for a real contact (you as the sender).</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          {(() => {
            const open = q.trim().length >= 2 && q !== chosenName && results.length > 0;
            return (
              <>
                <Input
                  role="combobox"
                  aria-label="Preview with contact"
                  aria-expanded={open}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={open ? `${listId}-${active}` : undefined}
                  placeholder="Search a contact…"
                  value={q}
                  onChange={(e) => (setQ(e.target.value), setActive(0))}
                  onKeyDown={(e) => {
                    if (!open) return;
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setActive((a) => Math.min(results.length - 1, a + 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setActive((a) => Math.max(0, a - 1));
                    } else if (e.key === "Enter" && results[active]) {
                      e.preventDefault();
                      choose(results[active]!);
                    } else if (e.key === "Escape") setResults([]);
                  }}
                />
                {open ? (
                  <ul id={listId} role="listbox" aria-label="Contacts" className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border-strong bg-surface-2">
                    {results.map((r, i) => (
                      <li
                        key={r.id}
                        id={`${listId}-${i}`}
                        role="option"
                        aria-selected={i === active}
                        className={cn("cursor-pointer px-3 py-1.5 text-sm text-body hover:bg-surface-3", i === active && "bg-surface-3")}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          choose(r);
                        }}
                        onMouseEnter={() => setActive(i)}
                      >
                        {r.fullName}
                        {r.accountName ? <span className="text-muted"> · {r.accountName}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            );
          })()}
        </div>
        {loading && !data ? <Skeleton className="h-32 w-full" /> : null}
        {data ? (
          <div className={cn("space-y-3 transition-opacity duration-150", loading && "opacity-60")}>
            {data.contact.dnc ? <p className="text-xs text-critical">{data.contact.name} is marked do-not-contact — they’d be skipped.</p> : null}
            {data.blocked ? <p className="text-xs text-warning">Missing variables block sending for this contact — they’d be skipped at enrollment.</p> : null}
            {data.steps.map((st, i) => (
              <div key={i} className="rounded-md border border-border p-3">
                <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">
                  Step {i + 1} · {KIND_LABEL[st.kind as StepKind]}
                </p>
                {st.subject ? <p className="text-sm font-medium text-fg">{st.subject}</p> : null}
                {st.body ? <p className="mt-1 whitespace-pre-wrap text-sm text-body">{st.body}</p> : null}
                {st.missing.length ? <p className="mt-2 text-xs text-warning">Missing: {st.missing.map((m) => `{{${m}}}`).join(", ")}</p> : null}
              </div>
            ))}
          </div>
        ) : !loading ? (
          <p className="text-xs text-muted">Pick a contact to see exactly what they’d receive.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
