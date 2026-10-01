"use client";
import * as React from "react";
import Link from "next/link";
import { CheckCircle2, ListChecks, Mail, PauseCircle, Pencil, Plus, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, ColorTick } from "@/components/ui/badge";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AdminSection, Field, Switch, useAction } from "@/components/admin/form";
import { savePlaybook, setPlaybookActive } from "@/lib/playbooks/actions";
import { ASSIGN_TO, playbookInputSchema, type PlaybookEmail, type PlaybookTask } from "@/lib/playbooks/core";
import type { StagePlaybook } from "@/lib/playbooks/service";
import { cn } from "@/lib/utils";
import { ScrollStrip } from "@/components/ui/scroll-strip";

type StageLite = { id: string; name: string; category: string; slaDays: number | null; probability: number };

const ASSIGN_LABEL: Record<(typeof ASSIGN_TO)[number], string> = { owner: "Deal owner", manager: "Owner's manager", onboarding: "Onboarding" };
const CAT_ICON = { won: CheckCircle2, lost: XCircle, hold: PauseCircle } as const;

/** /admin/playbooks: per pipeline → per stage guidance, task templates and email templates (V2 §A7). */
export function PlaybooksEditor({
  pipelines,
  pipelineKey,
  stages,
  playbooks,
}: {
  pipelines: { key: string; name: string; color: string }[];
  pipelineKey: string;
  stages: StageLite[];
  playbooks: StagePlaybook[];
}) {
  const [editing, setEditing] = React.useState<StageLite | null>(null);
  const byStage = new Map(playbooks.map((p) => [p.stageId, p]));
  const covered = stages.filter((st) => byStage.get(st.id)?.active).length;
  return (
    <>
      <ScrollStrip as="nav" aria-label="Pipelines" activeKey={pipelineKey} className="-mx-1 flex gap-1 pb-1">
        {pipelines.map((p) => (
          <Link
            key={p.key}
            href={`/admin/playbooks?pipeline=${p.key}`}
            aria-current={p.key === pipelineKey ? "page" : undefined}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors duration-150",
              p.key === pipelineKey ? "border-border-strong bg-surface-2 text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            <ColorTick color={p.color} /> {p.name}
          </Link>
        ))}
      </ScrollStrip>
      <AdminSection
        title="Stage playbooks"
        description={`${covered} of ${stages.length} stages have an active playbook. Entering a stage creates its tasks once per deal (re-entering never duplicates them); the guidance shows on the deal page.`}
      >
        <ul className="divide-y divide-border">
          {stages.map((st) => {
            const pb = byStage.get(st.id);
            const Icon = st.category !== "open" ? CAT_ICON[st.category as keyof typeof CAT_ICON] : null;
            return (
              <li key={st.id} className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 py-3", pb && !pb.active ? "opacity-60" : "")}>
                <div className="min-w-0 flex-1 basis-56">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
                    {Icon ? <Icon className="size-3.5 text-muted" aria-hidden /> : null}
                    {st.name}
                    <span className="text-[11px] font-normal text-muted tabular">
                      {Math.round(st.probability * 100)}%{st.slaDays ? ` · SLA ${st.slaDays}d` : ""}
                    </span>
                  </p>
                  {pb ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-secondary">{pb.guidance || pb.name}</p>
                  ) : (
                    <p className="mt-0.5 text-xs text-muted">No playbook</p>
                  )}
                </div>
                {pb ? (
                  <div className="flex items-center gap-1.5">
                    <Badge>
                      <ListChecks className="size-3" aria-hidden /> {pb.tasks.length} task{pb.tasks.length === 1 ? "" : "s"}
                    </Badge>
                    {pb.emailTemplates.length ? (
                      <Badge>
                        <Mail className="size-3" aria-hidden /> {pb.emailTemplates.length}
                      </Badge>
                    ) : null}
                    <ActiveToggle stageId={st.id} name={st.name} active={pb.active} />
                  </div>
                ) : null}
                <Button size="sm" variant={pb ? "ghost" : "secondary"} onClick={() => setEditing(st)} aria-label={`${pb ? "Edit" : "Create"} playbook for ${st.name}`}>
                  {pb ? <Pencil /> : <Plus />} {pb ? "Edit" : "Create"}
                </Button>
              </li>
            );
          })}
        </ul>
      </AdminSection>
      {editing ? <PlaybookDialog key={editing.id} stage={editing} playbook={byStage.get(editing.id) ?? null} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function ActiveToggle({ stageId, name, active }: { stageId: string; name: string; active: boolean }) {
  const { run, pending } = useAction(setPlaybookActive, { success: (d) => (d.active ? "Playbook enabled" : "Playbook paused") });
  return <Switch checked={active} disabled={pending} label={`Playbook for ${name} active`} onCheckedChange={(v) => void run({ stageId, active: v })} />;
}

type TaskDraft = { title: string; description: string; dueInDays: string; assignTo: PlaybookTask["assignTo"]; priority: NonNullable<PlaybookTask["priority"]> };

function PlaybookDialog({ stage, playbook, onClose }: { stage: StageLite; playbook: StagePlaybook | null; onClose: () => void }) {
  const [name, setName] = React.useState(playbook?.name ?? stage.name);
  const [guidance, setGuidance] = React.useState(playbook?.guidance ?? "");
  const [active, setActive] = React.useState(playbook?.active ?? true);
  const [tasks, setTasks] = React.useState<TaskDraft[]>(
    (playbook?.tasks ?? []).map((t) => ({ title: t.title, description: t.description ?? "", dueInDays: String(t.dueInDays), assignTo: t.assignTo, priority: t.priority ?? "medium" })),
  );
  const [emails, setEmails] = React.useState<PlaybookEmail[]>(playbook?.emailTemplates ?? []);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const { run, pending } = useAction(savePlaybook, { success: "Playbook saved", onSuccess: onClose });

  const setTask = (i: number, patch: Partial<TaskDraft>) => setTasks((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const setEmail = (i: number, patch: Partial<PlaybookEmail>) => setEmails((es) => es.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const move = (i: number, dir: -1 | 1) =>
    setTasks((ts) => {
      const j = i + dir;
      if (j < 0 || j >= ts.length) return ts;
      const next = [...ts];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const submit = () => {
    const input = {
      stageId: stage.id,
      name,
      guidance,
      active,
      tasks: tasks.map((t) => ({ title: t.title, description: t.description || undefined, dueInDays: Number(t.dueInDays || 0), assignTo: t.assignTo, priority: t.priority })),
      emailTemplates: emails,
    };
    const parsed = playbookInputSchema.safeParse(input);
    if (!parsed.success) {
      setLocalError(parsed.error.issues[0]?.message ?? "Check the playbook fields.");
      return;
    }
    setLocalError(null);
    void run(parsed.data);
  };

  return (
    <Dialog open onOpenChange={(o) => (!o && !pending ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{playbook ? "Edit" : "Create"} playbook · {stage.name}</DialogTitle>
            <DialogDescription>Tasks are created when a deal enters this stage. The first owner task pre-fills the next step in the move dialog.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field label="Name" htmlFor="pb-name">
                <Input id="pb-name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} />
              </Field>
              {/* POL-13: the switch carries the accessible name; the visible word is decorative (no "Active Active"). */}
              <div className="flex items-center gap-2 pb-2 text-sm text-body">
                <Switch checked={active} onCheckedChange={setActive} label="Active" />
                <span aria-hidden>Active</span>
              </div>
            </div>
            <Field label="Guidance" htmlFor="pb-guidance" hint="One or two sentences: how to win this stage. Shown on the deal page.">
              <Textarea id="pb-guidance" rows={3} value={guidance} onChange={(e) => setGuidance(e.target.value)} maxLength={2000} />
            </Field>

            <fieldset className="space-y-2">
              <legend className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Tasks on entry</legend>
              {tasks.length === 0 ? <p className="text-xs text-muted">No tasks — entering this stage only shows the guidance.</p> : null}
              {tasks.map((t, i) => (
                <div key={i} className="space-y-2 rounded-md border border-border p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="w-5 text-center text-xs text-muted tabular">{i + 1}</span>
                    <Input aria-label={`Task ${i + 1} title`} value={t.title} onChange={(e) => setTask(i, { title: e.target.value })} placeholder="e.g. Send recap with next steps" maxLength={200} />
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move task ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move task ${i + 1} down`} disabled={i === tasks.length - 1} onClick={() => move(i, 1)}>
                      ↓
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove task ${i + 1}`} onClick={() => setTasks((ts) => ts.filter((_, j) => j !== i))}>
                      <Trash2 />
                    </Button>
                  </div>
                  <div className="pl-7">
                    <Input aria-label={`Task ${i + 1} description`} value={t.description} onChange={(e) => setTask(i, { description: e.target.value })} placeholder="Details for the assignee (optional)" maxLength={1000} />
                  </div>
                  <div className="grid grid-cols-2 gap-2 pl-7 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor={`pb-due-${i}`}>Due in (business days)</Label>
                      <Input id={`pb-due-${i}`} inputMode="numeric" value={t.dueInDays} onChange={(e) => setTask(i, { dueInDays: e.target.value.replace(/[^\d]/g, "") })} className="tabular" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`pb-assign-${i}`}>Assign to</Label>
                      <NativeSelect id={`pb-assign-${i}`} value={t.assignTo} onChange={(e) => setTask(i, { assignTo: e.target.value as TaskDraft["assignTo"] })}>
                        {ASSIGN_TO.map((a) => (
                          <option key={a} value={a}>
                            {ASSIGN_LABEL[a]}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`pb-prio-${i}`}>Priority</Label>
                      <NativeSelect id={`pb-prio-${i}`} value={t.priority} onChange={(e) => setTask(i, { priority: e.target.value as TaskDraft["priority"] })}>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                      </NativeSelect>
                    </div>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={tasks.length >= 12}
                onClick={() => setTasks((ts) => [...ts, { title: "", description: "", dueInDays: "2", assignTo: "owner", priority: "medium" }])}
              >
                <Plus /> Add task
              </Button>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">Email templates</legend>
              <p className="text-xs text-muted">
                Variables: <code className="text-secondary">{"{{first_name}} {{company}} {{sender_first_name}} {{deal}}"}</code>. Templates are suggestions — nothing is sent automatically.
              </p>
              {emails.map((em, i) => (
                <div key={i} className="space-y-2 rounded-md border border-border p-2.5">
                  <div className="flex items-center gap-2">
                    <Input aria-label={`Template ${i + 1} name`} value={em.name} onChange={(e) => setEmail(i, { name: e.target.value })} placeholder="Template name" maxLength={80} />
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove template ${i + 1}`} onClick={() => setEmails((es) => es.filter((_, j) => j !== i))}>
                      <Trash2 />
                    </Button>
                  </div>
                  <Input aria-label={`Template ${i + 1} subject`} value={em.subject} onChange={(e) => setEmail(i, { subject: e.target.value })} placeholder="Subject" maxLength={200} />
                  <Textarea aria-label={`Template ${i + 1} body`} rows={5} value={em.body} onChange={(e) => setEmail(i, { body: e.target.value })} maxLength={5000} />
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" disabled={emails.length >= 6} onClick={() => setEmails((es) => [...es, { name: "", subject: "", body: "" }])}>
                <Plus /> Add template
              </Button>
            </fieldset>
            {localError ? (
              <p role="alert" className="text-xs text-secondary">
                <span aria-hidden className="mr-1 text-critical">✕</span>
                {localError}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || name.trim().length < 2}>
              Save playbook
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
