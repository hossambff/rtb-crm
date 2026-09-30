"use client";
import * as React from "react";
import { Loader2, Pencil, Plus, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { StatusBadge } from "@/components/ui/badge";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { setSplits, updateDealQuick } from "@/lib/deals/actions";
import { validateSplits } from "@/lib/deals/rules";
import { fmtDate } from "@/lib/format";
import { PRIORITY_LABELS, type Priority, type UserLite } from "@/lib/deals/types";
import { useRun } from "./use-run";

/* ───────────── Next step (DEAL-3) ───────────── */

export function NextStepEditor({
  dealId,
  nextStep,
  dueAt,
  waitingReason,
  overdueDays,
  canEdit,
  isOpen,
}: {
  dealId: string;
  nextStep: string | null;
  dueAt: string | null;
  waitingReason: string | null;
  overdueDays: number;
  canEdit: boolean;
  isOpen: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [step, setStep] = React.useState(nextStep ?? "");
  const [due, setDue] = React.useState(dueAt?.slice(0, 10) ?? "");
  const [waiting, setWaiting] = React.useState(waitingReason ?? "");
  const [run, pending] = useRun();

  if (!editing) {
    return (
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          {nextStep ? (
            <p className="text-sm text-fg">{nextStep}</p>
          ) : waitingReason ? (
            <p className="text-sm text-secondary">Waiting — {waitingReason}</p>
          ) : (
            <StatusBadge status="warning" label={isOpen ? "No next step — required for open deals" : "No next step"} />
          )}
          <div className="mt-1 flex items-center gap-2 text-xs text-muted">
            {dueAt ? <span className="tabular">Due {fmtDate(dueAt, "EEE d MMM")}</span> : null}
            {overdueDays > 0 ? <StatusBadge status="critical" label={`Overdue ${overdueDays}d`} /> : null}
          </div>
        </div>
        {canEdit ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit next step"
            onClick={() => {
              setStep(nextStep ?? "");
              setDue(dueAt?.slice(0, 10) ?? "");
              setWaiting(waitingReason ?? "");
              setEditing(true);
            }}
          >
            <Pencil />
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => updateDealQuick({ dealId, patch: { nextStep: step.trim() || null, nextStepDueAt: due || null, nextStepWaitingReason: waiting.trim() || null } }), {
          success: "Next step saved",
          onOk: () => setEditing(false),
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
        <Input aria-label="Next step" value={step} onChange={(e) => setStep(e.target.value)} placeholder="What happens next?" autoFocus />
        <Input aria-label="Due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      </div>
      <Input aria-label="Waiting reason" value={waiting} onChange={(e) => setWaiting(e.target.value)} placeholder="Or a waiting reason, e.g. “Waiting on client until 15 Oct”" />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : null} Save
        </Button>
      </div>
    </form>
  );
}

/* ───────────── Priority / close date inline ───────────── */

export function PrioritySelect({ dealId, value, canEdit }: { dealId: string; value: Priority | null; canEdit: boolean }) {
  const [run, pending] = useRun();
  if (!canEdit) return <span className="text-sm text-body">{value ? PRIORITY_LABELS[value] : "—"}</span>;
  return (
    <NativeSelect
      aria-label="Priority"
      className="h-8 w-auto text-[13px]"
      defaultValue={value ?? ""}
      disabled={pending}
      onChange={(e) => run(() => updateDealQuick({ dealId, patch: { priority: (e.target.value || null) as Priority | null } }), { success: "Priority updated" })}
    >
      <option value="">No priority</option>
      {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </NativeSelect>
  );
}

export function CloseDateInput({ dealId, value, canEdit }: { dealId: string; value: string | null; canEdit: boolean }) {
  const [run, pending] = useRun();
  if (!canEdit) return <span className="text-sm text-body tabular">{fmtDate(value)}</span>;
  return (
    <input
      type="date"
      aria-label="Expected close date"
      disabled={pending}
      defaultValue={value?.slice(0, 10) ?? ""}
      className="h-8 rounded-md border border-border bg-surface-3/40 px-2 text-[13px] text-body tabular [color-scheme:dark]"
      onChange={(e) => run(() => updateDealQuick({ dealId, patch: { expectedCloseDate: e.target.value || null } }), { success: "Close date updated" })}
    />
  );
}

/* ───────────── Owner & splits (DEAL-6) ───────────── */

type Split = { userId: string; pct: number; role: string | null; name: string; image: string | null };

export function OwnersBlock({
  dealId,
  owner,
  splits,
  assignable,
  users,
  canEdit,
  canAssign,
}: {
  dealId: string;
  owner: UserLite | null;
  splits: Split[];
  assignable: UserLite[];
  users: UserLite[];
  canEdit: boolean;
  canAssign: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const list: Split[] = splits.length ? splits : owner ? [{ userId: owner.id, pct: 100, role: "owner", name: owner.name, image: owner.image }] : [];
  return (
    <div className="flex items-center gap-2">
      <div className="flex -space-x-1.5">
        {list.slice(0, 4).map((s) => (
          <Avatar key={s.userId} name={s.name} src={s.image} size={26} className="ring-2 ring-bg" />
        ))}
      </div>
      <div className="min-w-0 text-sm leading-tight">
        <p className="truncate text-fg">{owner?.name ?? "Unassigned"}</p>
        <p className="truncate text-[11px] text-muted">
          {splits.length > 1 ? splits.map((s) => `${s.name.split(" ")[0]} ${Math.round(s.pct)}%`).join(" · ") : "Primary owner"}
        </p>
      </div>
      {canEdit ? (
        <Button variant="ghost" size="icon-sm" aria-label="Edit owner and splits" onClick={() => setOpen(true)}>
          <Users />
        </Button>
      ) : null}
      {open ? (
        <SplitsDialog dealId={dealId} ownerId={owner?.id ?? null} initial={list} assignable={assignable} users={users} canAssign={canAssign} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}

function SplitsDialog({
  dealId,
  ownerId,
  initial,
  assignable,
  users,
  canAssign,
  onClose,
}: {
  dealId: string;
  ownerId: string | null;
  initial: Split[];
  assignable: UserLite[];
  users: UserLite[];
  canAssign: boolean;
  onClose: () => void;
}) {
  const [primary, setPrimary] = React.useState(ownerId ?? "");
  const [rows, setRows] = React.useState(initial.map((s) => ({ userId: s.userId, pct: String(s.pct), role: s.role ?? "owner" })));
  const [run, pending] = useRun();
  const parsed = rows.map((r) => ({ userId: r.userId, pct: Number(r.pct) }));
  const error = rows.length ? validateSplits(parsed) : null;
  const total = parsed.reduce((a, r) => a + (Number.isFinite(r.pct) ? r.pct : 0), 0);
  const pickable = canAssign ? assignable : users.filter((u) => initial.some((s) => s.userId === u.id));
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? "Unknown";

  const save = () =>
    run(
      async () => {
        if (primary && primary !== ownerId) {
          const r = await updateDealQuick({ dealId, patch: { ownerId: primary } });
          if (!r.ok) return r;
        }
        return rows.length ? setSplits({ dealId, splits: rows.map((r) => ({ userId: r.userId, pct: Number(r.pct), role: r.role as "owner" })) }) : { ok: true as const, data: { ok: true } };
      },
      { success: "Owners updated", onOk: onClose },
    );

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Owner & splits</DialogTitle>
          <DialogDescription>The primary owner is accountable for next steps. Credit splits must total 100%.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-1">
            <Label htmlFor="primary-owner">Primary owner</Label>
            <NativeSelect id="primary-owner" value={primary} onChange={(e) => setPrimary(e.target.value)} disabled={!canAssign}>
              {!primary ? <option value="">Unassigned</option> : null}
              {(canAssign ? assignable : users.filter((u) => u.id === primary)).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Credit splits</Label>
              <span className={total === 100 ? "text-xs text-muted tabular" : "text-xs text-critical tabular"}>Total {Math.round(total * 100) / 100}%</span>
            </div>
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_110px_84px_32px] items-center gap-2">
                <NativeSelect aria-label="Split user" value={r.userId} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, userId: e.target.value } : x)))}>
                  {!pickable.some((u) => u.id === r.userId) ? <option value={r.userId}>{nameOf(r.userId)}</option> : null}
                  {pickable.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </NativeSelect>
                <NativeSelect aria-label="Split role" value={r.role} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}>
                  <option value="owner">Owner</option>
                  <option value="sourcer">Sourcer</option>
                  <option value="closer">Closer</option>
                  <option value="collaborator">Collaborator</option>
                </NativeSelect>
                <Input aria-label="Split percent" inputMode="decimal" value={r.pct} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} className="tabular" />
                <Button variant="ghost" size="icon-sm" aria-label="Remove split" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              disabled={!pickable.length}
              onClick={() => {
                const next = pickable.find((u) => !rows.some((r) => r.userId === u.id));
                if (next) setRows([...rows, { userId: next.id, pct: "0", role: "collaborator" }]);
              }}
            >
              <Plus /> Add person
            </Button>
            {error ? <p className="text-xs text-critical">{error}</p> : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={pending || (rows.length > 0 && !!error)}>
            {pending ? <Loader2 className="animate-spin" /> : null} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
