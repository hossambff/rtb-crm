"use client";
import * as React from "react";
import { toast } from "sonner";
import { DndContext, PointerSensor, KeyboardSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { ExternalLink, LayoutGrid, Plus, Rows3 } from "lucide-react";
import { Badge, ColorTick, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Field } from "@/components/r100/field";
import { fmtDate } from "@/lib/format";
import { PIPELINE_COLORS } from "@/lib/palette";
import { cn } from "@/lib/utils";
import { createProject, moveProject, updateChecklist, updateProject } from "@/lib/onboarding/actions";
import { MIGRATION_STAGE_LABELS, MIGRATION_STAGES, STALL_DAYS, type MigrationStage } from "@/lib/onboarding/calc";
import type { ProjectRow } from "@/lib/onboarding/queries";

type Props = {
  projects: ProjectRow[];
  wonDeals: { id: string; name: string; pipelineKey: string }[];
  owners: { id: string; name: string }[];
  perms: { canCreate: boolean; canEdit: boolean };
};

export function OnboardingView({ projects, wonDeals, owners, perms }: Props) {
  const [view, setView] = React.useState<"board" | "table">("board");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [local, setLocal] = React.useState(projects);
  const [synced, setSynced] = React.useState(projects);
  if (synced !== projects) {
    setSynced(projects);
    setLocal(projects);
  }
  const open = local.find((p) => p.id === openId) ?? null;

  const move = (id: string, stage: MigrationStage) => {
    const prev = local;
    setLocal(local.map((p) => (p.id === id ? { ...p, stage, daysInStage: 0, stalled: false } : p)));
    void moveProject({ id, stage }).then((res) => {
      if (!res.ok) {
        setLocal(prev);
        toast.error(res.error);
      } else toast.success(`Moved to ${MIGRATION_STAGE_LABELS[stage]}`);
    });
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="View">
          <Button size="sm" variant={view === "board" ? "secondary" : "ghost"} aria-pressed={view === "board"} onClick={() => setView("board")}>
            <LayoutGrid /> Board
          </Button>
          <Button size="sm" variant={view === "table" ? "secondary" : "ghost"} aria-pressed={view === "table"} onClick={() => setView("table")}>
            <Rows3 /> Table
          </Button>
        </div>
        {perms.canCreate ? (
          <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
            <Plus /> Create project
          </Button>
        ) : null}
      </div>

      {local.length === 0 ? (
        <EmptyState
          title="No migration projects"
          description="Won NetDev, Enterprise and Sports deals hand off here. Create a project for a won deal to start the checklist."
          action={perms.canCreate ? <Button onClick={() => setCreating(true)}>Create project</Button> : undefined}
        />
      ) : view === "board" ? (
        <Board projects={local} canEdit={perms.canEdit} onMove={move} onOpen={setOpenId} />
      ) : (
        <ProjectTable projects={local} onOpen={setOpenId} />
      )}

      {open ? <ProjectSheet project={open} owners={owners} onClose={() => setOpenId(null)} onMove={move} /> : null}
      {creating ? <CreateDialog wonDeals={wonDeals} owners={owners} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function Board({ projects, canEdit, onMove, onOpen }: { projects: ProjectRow[]; canEdit: boolean; onMove: (id: string, s: MigrationStage) => void; onOpen: (id: string) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const to = e.over?.id as MigrationStage | undefined;
    const p = projects.find((x) => x.id === id);
    if (!p || !to || p.stage === to || !p.canEdit) return;
    onMove(id, to);
  };
  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-3">
        {MIGRATION_STAGES.map((stage) => (
          <Column key={stage} stage={stage} items={projects.filter((p) => p.stage === stage)} canEdit={canEdit} onOpen={onOpen} />
        ))}
      </div>
    </DndContext>
  );
}

function Column({ stage, items, canEdit, onOpen }: { stage: MigrationStage; items: ProjectRow[]; canEdit: boolean; onOpen: (id: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage, disabled: !canEdit });
  return (
    <section
      ref={setNodeRef}
      aria-label={MIGRATION_STAGE_LABELS[stage]}
      className={cn("flex w-64 shrink-0 flex-col rounded-lg border border-border bg-surface-1 transition-colors", isOver && "border-border-strong bg-surface-2/40")}
    >
      <header className="flex items-baseline justify-between border-b border-border px-3 py-2">
        <h3 className="font-sans text-sm font-medium text-fg">{MIGRATION_STAGE_LABELS[stage]}</h3>
        <span className="text-xs text-muted tabular">{items.length}</span>
      </header>
      <div className="flex min-h-24 flex-col gap-2 p-2">
        {items.map((p) => (
          <Card key={p.id} project={p} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function Card({ project: p, onOpen }: { project: ProjectRow; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: p.id, disabled: !p.canEdit });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  return (
    <article
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(p.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(p.id);
      }}
      aria-label={`${p.name}, open details`}
      className={cn(
        "cursor-pointer rounded-md border border-border bg-surface-2 p-3 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-white/80",
        isDragging && "z-10 opacity-80",
      )}
    >
      <div className="flex items-start gap-2">
        <ColorTick color={PIPELINE_COLORS[p.pipelineKey ?? ""] ?? "#828282"} className="mt-1" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-fg">{p.name}</p>
          <p className="truncate text-[11px] text-muted">{p.ownerName ?? "No owner"}</p>
        </div>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-3" aria-label={`Checklist ${p.progress.done} of ${p.progress.total}`}>
        <div className="h-full rounded-full bg-white/80" style={{ width: `${p.progress.pct * 100}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-muted tabular">
        {p.progress.done}/{p.progress.total} · {p.daysInStage}d in stage{p.targetGoLive ? ` · go-live ${fmtDate(p.targetGoLive, "d MMM")}` : ""}
      </p>
      {p.stalled || p.slipped ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {p.stalled ? <StatusBadge status="warning" label={`Stalled ${p.daysInStage}d`} /> : null}
          {p.slipped ? <StatusBadge status="serious" label="Go-live slipped" /> : null}
        </div>
      ) : null}
    </article>
  );
}

function ProjectTable({ projects, onOpen }: { projects: ProjectRow[]; onOpen: (id: string) => void }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[960px] text-sm">
        <thead className="bg-surface-1 text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Project</th>
            <th className="px-3 py-2 font-medium">Stage</th>
            <th className="px-3 py-2 font-medium">Owner</th>
            <th className="px-3 py-2 font-medium">Checklist</th>
            <th className="px-3 py-2 font-medium">Target go-live</th>
            <th className="px-3 py-2 font-medium">Actual go-live</th>
            <th className="px-3 py-2 font-medium">Launched</th>
            <th className="px-3 py-2 font-medium">Flags</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id} className="cursor-pointer border-t border-border hover:bg-surface-1" onClick={() => onOpen(p.id)}>
              <td className="px-3 py-2">
                <button type="button" className="text-left font-medium text-fg hover:underline" onClick={() => onOpen(p.id)}>
                  {p.name}
                </button>
                <p className="text-[11px] text-muted">{p.dealName ?? p.accountName ?? "—"}</p>
              </td>
              <td className="px-3 py-2 text-secondary">{MIGRATION_STAGE_LABELS[p.stage]}</td>
              <td className="px-3 py-2 text-secondary">{p.ownerName ?? "—"}</td>
              <td className="px-3 py-2 tabular">
                {p.progress.done}/{p.progress.total}
              </td>
              <td className="px-3 py-2 tabular">{fmtDate(p.targetGoLive)}</td>
              <td className="px-3 py-2 tabular">{fmtDate(p.actualGoLive)}</td>
              <td className="px-3 py-2">{p.launched ? <StatusBadge status="good" label="Launched" /> : <span className="text-xs text-muted">No</span>}</td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {p.stalled ? <StatusBadge status="warning" label={`Stalled ${p.daysInStage}d`} /> : null}
                  {p.slipped ? <StatusBadge status="serious" label="Slipped" /> : null}
                  {p.blockers ? <Badge>Blocked</Badge> : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProjectSheet({ project: p, owners, onClose, onMove }: { project: ProjectRow; owners: { id: string; name: string }[]; onClose: () => void; onMove: (id: string, s: MigrationStage) => void }) {
  const [checklist, setChecklist] = React.useState(p.checklist);
  const [newItem, setNewItem] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, start] = React.useTransition();
  const ro = !p.canEdit;

  const saveChecklist = (next: { item: string; done: boolean }[]) => {
    const prev = checklist;
    setChecklist(next);
    start(async () => {
      const res = await updateChecklist({ id: p.id, checklist: next });
      if (!res.ok) {
        setChecklist(prev);
        toast.error(res.error);
      }
    });
  };

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) ?? "").trim() || null;
    start(async () => {
      const res = await updateProject({
        id: p.id,
        ownerId: str("ownerId"),
        targetGoLive: str("targetGoLive"),
        actualGoLive: str("actualGoLive"),
        cloneUrl: str("cloneUrl"),
        liveUrl: str("liveUrl"),
        blockers: str("blockers"),
        notes: str("notes"),
        launched: f.get("launched") === "on",
      });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      setErrors({});
      toast.success("Project saved");
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent side="right">
        <DialogHeader>
          <DialogTitle>{p.name}</DialogTitle>
          <DialogDescription>
            {p.dealName ?? p.accountName ?? "No linked deal"} · {p.daysInStage} days in {MIGRATION_STAGE_LABELS[p.stage]}
            {p.stalled ? ` (stall threshold ${STALL_DAYS}d)` : ""}
          </DialogDescription>
          <div className="mt-2 flex flex-wrap gap-1">
            {p.stalled ? <StatusBadge status="warning" label={`Stalled ${p.daysInStage}d`} /> : null}
            {p.slipped ? <StatusBadge status="serious" label="Go-live slipped" /> : null}
            {p.launched ? <StatusBadge status="good" label="Launched" /> : null}
          </div>
        </DialogHeader>
        <DialogBody>
          <Field label="Stage">
            <NativeSelect value={p.stage} disabled={ro} onChange={(e) => onMove(p.id, e.target.value as MigrationStage)}>
              {MIGRATION_STAGES.map((s) => (
                <option key={s} value={s}>
                  {MIGRATION_STAGE_LABELS[s]}
                </option>
              ))}
            </NativeSelect>
          </Field>

          <form onSubmit={submit} className="space-y-4" key={`${p.id}-${p.launched}-${p.actualGoLive}`}>
            <fieldset disabled={ro} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Owner" error={errors.ownerId?.[0]}>
                  <NativeSelect name="ownerId" defaultValue={p.ownerId ?? ""}>
                    <option value="">Unassigned</option>
                    {owners.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <div className="flex items-end pb-2">
                  <label className="inline-flex items-center gap-2 text-sm text-body">
                    <input type="checkbox" name="launched" defaultChecked={p.launched} className="size-4 accent-white" />
                    Launched
                  </label>
                </div>
                <Field label="Target go-live" error={errors.targetGoLive?.[0]}>
                  <Input type="date" name="targetGoLive" defaultValue={p.targetGoLive?.slice(0, 10) ?? ""} />
                </Field>
                <Field label="Actual go-live" error={errors.actualGoLive?.[0]}>
                  <Input type="date" name="actualGoLive" defaultValue={p.actualGoLive?.slice(0, 10) ?? ""} />
                </Field>
                <Field label="Clone URL" error={errors.cloneUrl?.[0]}>
                  <Input type="url" name="cloneUrl" placeholder="https://" defaultValue={p.cloneUrl ?? ""} />
                </Field>
                <Field label="Live URL" error={errors.liveUrl?.[0]}>
                  <Input type="url" name="liveUrl" placeholder="https://" defaultValue={p.liveUrl ?? ""} />
                </Field>
              </div>
              <div className="flex gap-3 text-xs">
                {p.cloneUrl ? (
                  <a className="inline-flex items-center gap-1 text-fg hover:underline" href={p.cloneUrl} target="_blank" rel="noreferrer">
                    Open clone <ExternalLink className="size-3" />
                  </a>
                ) : null}
                {p.liveUrl ? (
                  <a className="inline-flex items-center gap-1 text-fg hover:underline" href={p.liveUrl} target="_blank" rel="noreferrer">
                    Open live site <ExternalLink className="size-3" />
                  </a>
                ) : null}
              </div>
              <Field label="Blockers" error={errors.blockers?.[0]}>
                <Textarea name="blockers" rows={2} defaultValue={p.blockers ?? ""} placeholder="Waiting on DNS access from client…" />
              </Field>
              <Field label="Notes" error={errors.notes?.[0]}>
                <Textarea name="notes" rows={3} defaultValue={p.notes ?? ""} />
              </Field>
              {!ro ? (
                <div className="flex justify-end">
                  <Button type="submit" variant="primary" disabled={pending}>
                    Save details
                  </Button>
                </div>
              ) : null}
            </fieldset>
          </form>

          <div className="border-t border-border pt-4">
            <p className="mb-2 font-display text-base text-fg">
              Checklist{" "}
              <span className="font-sans text-xs text-muted tabular">
                {checklist.filter((c) => c.done).length}/{checklist.length}
              </span>
            </p>
            <ul className="space-y-1">
              {checklist.map((c, i) => (
                <li key={`${c.item}-${i}`}>
                  <label className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-surface-3/40">
                    <input
                      type="checkbox"
                      checked={c.done}
                      disabled={ro || pending}
                      onChange={(e) => saveChecklist(checklist.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)))}
                      className="size-4 accent-white"
                    />
                    <span className={cn(c.done ? "text-muted line-through" : "text-body")}>{c.item}</span>
                  </label>
                </li>
              ))}
            </ul>
            {!ro ? (
              <form
                className="mt-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!newItem.trim()) return;
                  saveChecklist([...checklist, { item: newItem.trim(), done: false }]);
                  setNewItem("");
                }}
              >
                <Input aria-label="New checklist item" placeholder="Add checklist item" value={newItem} onChange={(e) => setNewItem(e.target.value)} />
                <Button type="submit" size="md" disabled={!newItem.trim()}>
                  Add
                </Button>
              </form>
            ) : null}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function CreateDialog({ wonDeals, owners, onClose }: { wonDeals: Props["wonDeals"]; owners: Props["owners"]; onClose: () => void }) {
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, start] = React.useTransition();
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    start(async () => {
      const res = await createProject({
        dealId: String(f.get("dealId") ?? ""),
        ownerId: String(f.get("ownerId") ?? "") || null,
        targetGoLive: String(f.get("targetGoLive") ?? "") || null,
      });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success("Migration project created with the default checklist");
      onClose();
    });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Create migration project</DialogTitle>
            <DialogDescription>For a won NetDev, Enterprise or Sports deal. Starts in Discovery with the default checklist.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {wonDeals.length === 0 ? (
              <p className="text-sm text-muted">Every won deal you can see already has a project.</p>
            ) : (
              <>
                <Field label="Won deal" error={errors.dealId?.[0]}>
                  <NativeSelect name="dealId" required defaultValue="">
                    <option value="" disabled>
                      Select a deal…
                    </option>
                    {wonDeals.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} · {d.pipelineKey}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Owner" error={errors.ownerId?.[0]}>
                    <NativeSelect name="ownerId" defaultValue="">
                      <option value="">Unassigned</option>
                      {owners.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="Target go-live" error={errors.targetGoLive?.[0]}>
                    <Input type="date" name="targetGoLive" />
                  </Field>
                </div>
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || wonDeals.length === 0}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
