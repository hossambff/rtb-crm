"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Ellipsis, GitBranch, Pause, Play, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/misc";
import { applyNewStepsToEnrollments, createSequence, deleteSequence, resumeMyPaused, setSequenceActive } from "@/lib/sequences/actions";

export function NewSequenceButton({ duplicateOf, defaultName, variant = "primary", children }: { duplicateOf?: string; defaultName?: string; variant?: "primary" | "secondary"; children?: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(defaultName ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await createSequence({ name, duplicateOf });
    setBusy(false);
    if (!r.ok) return setError(r.fieldErrors?.name?.[0] ?? r.error);
    setOpen(false);
    toast.success(duplicateOf ? "Copy created" : "Sequence created — make it yours");
    router.push(`/sequences/${r.data.id}?tab=steps`);
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children ?? (
          <Button variant={variant} size="sm">
            <Plus aria-hidden /> New sequence
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{duplicateOf ? "Duplicate sequence" : "New sequence"}</DialogTitle>
            <DialogDescription>{duplicateOf ? "Copies the steps and rules; enrollments stay with the original." : "Starts from a proven 4-step template (intro, bump, LinkedIn, last note) you can edit."}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-1.5">
              <Label htmlFor="new-seq-name">Name</Label>
              <Input id="new-seq-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. NET cold intro — finance publishers" aria-invalid={Boolean(error)} />
              {error ? <p className="text-xs text-critical">{error}</p> : null}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || name.trim().length < 2}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SequenceMenu({ id, name, active, canEdit }: { id: string; name: string; active: boolean; canEdit: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [dupOpen, setDupOpen] = React.useState(false);
  async function toggle() {
    setBusy(true);
    const r = await setSequenceActive({ id, active: !active });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(r.data.active ? "Sequence resumed" : "Sequence paused — nothing will send until you resume");
    router.refresh();
  }
  async function remove() {
    if (!window.confirm(`Delete “${name}”? Active enrollments are stopped; history and logged emails stay.`)) return;
    setBusy(true);
    const r = await deleteSequence({ id });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(`Deleted${r.data.stopped ? ` · ${r.data.stopped} enrollments stopped` : ""}`);
    router.push("/sequences");
  }
  return (
    <>
      {canEdit ? (
        <Button size="sm" disabled={busy} onClick={toggle}>
          {active ? <Pause aria-hidden /> : <Play aria-hidden />} {active ? "Pause" : "Resume"}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="More actions">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setDupOpen(true)}>
            <Copy aria-hidden /> Duplicate
          </DropdownMenuItem>
          {canEdit ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={remove}>
                <Trash2 aria-hidden className="text-critical" /> Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {dupOpen ? <DuplicateDialog id={id} name={name} onClose={() => setDupOpen(false)} /> : null}
    </>
  );
}

function DuplicateDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const router = useRouter();
  const [value, setValue] = React.useState(`${name} (copy)`.slice(0, 120));
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate sequence</DialogTitle>
          <DialogDescription>Copies the steps and rules. You’ll own the copy.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Label htmlFor="dup-name">Name</Label>
          <Input id="dup-name" value={value} onChange={(e) => setValue(e.target.value)} maxLength={120} />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || value.trim().length < 2}
            onClick={async () => {
              setBusy(true);
              const r = await createSequence({ name: value, duplicateOf: id });
              setBusy(false);
              if (!r.ok) return void toast.error(r.error);
              onClose();
              router.push(`/sequences/${r.data.id}?tab=steps`);
            }}
          >
            Duplicate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ResumePausedButton({ sequenceId, count }: { sequenceId?: string; count: number }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  if (!count) return null;
  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await resumeMyPaused({ sequenceId });
        setBusy(false);
        if (!r.ok) return void toast.error(r.error);
        const kept = r.data.keptManual ? ` · ${r.data.keptManual} paused by hand stay paused` : "";
        toast.success(`Resumed ${r.data.changed}${kept}`);
        router.refresh();
      }}
    >
      <RotateCcw aria-hidden /> Resume {count} paused
    </Button>
  );
}

/**
 * SEC H-3: "N people are on an older version" + an explicit, confirmed switch. Only owners/admins see the button;
 * every affected sender is notified server-side.
 */
export function OlderVersionNotice({ sequenceId, version, enrollments, senders, canEdit }: { sequenceId: string; version: number; enrollments: number; senders: number; canEdit: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  if (!enrollments) return null;
  const people = `${enrollments} ${enrollments === 1 ? "person is" : "people are"}`;
  async function apply() {
    setBusy(true);
    const r = await applyNewStepsToEnrollments({ id: sequenceId, confirmed: true });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    setOpen(false);
    const skipped = r.data.skipped ? ` · ${r.data.skipped} kept their steps (already past a step that changed)` : "";
    toast.success(`Applied to ${r.data.applied}${skipped}`);
    router.refresh();
  }
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3 text-sm">
      <GitBranch className="size-4 text-muted" aria-hidden />
      <p className="min-w-0 flex-1 text-secondary">
        <span className="text-fg">{people} on an older version</span> of these steps. They keep receiving what they were enrolled with.
      </p>
      {canEdit ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm">Apply new steps…</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Apply version {version} to active enrollments?</DialogTitle>
              <DialogDescription>
                {people} still on an older version{senders > 1 ? `, sending from ${senders} mailboxes` : ""}. Their next emails will use the new steps. People already past a step that changed keep their current steps, so nobody gets an email twice. Each sender is notified.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={apply}>
                {busy ? "Applying…" : "Apply new steps"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
