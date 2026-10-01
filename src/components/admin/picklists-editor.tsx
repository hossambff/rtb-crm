"use client";
import * as React from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/misc";
import { AdminSection, AdminTable, ConfirmButton, Field, Switch, Td, Th, useAction } from "@/components/admin/form";
import { DEFAULT_PICKLISTS, slugify } from "@/lib/admin/config-schemas";
import { addPicklistValue, deletePicklistValue, movePicklistValue, setPicklistActive, updatePicklistLabel } from "@/lib/admin/fields-actions";
import type { AdminPicklistValue } from "@/lib/admin/config-queries";

const listLabel = (l: string) => l.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function PicklistsEditor({ values }: { values: AdminPicklistValue[] }) {
  const lists = Array.from(new Set([...DEFAULT_PICKLISTS, ...values.map((v) => v.list)]));
  const [list, setList] = React.useState<string>(lists[0] ?? "category");
  const [dialog, setDialog] = React.useState<{ kind: "new-list" } | { kind: "label"; value: AdminPicklistValue } | null>(null);
  const rows = values.filter((v) => v.list === list);
  const id = React.useId();

  return (
    <AdminSection
      title="Picklists"
      description="Values offered in dropdowns (categories, leagues, sources, reasons, roles). Prefer deactivating over deleting — existing records keep their value."
      actions={
        <Button size="sm" onClick={() => setDialog({ kind: "new-list" })}>
          <Plus aria-hidden /> New list
        </Button>
      }
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-[220px_1fr] sm:items-end">
        <Field label="List" htmlFor={`${id}-list`}>
          <NativeSelect id={`${id}-list`} value={list} onChange={(e) => setList(e.target.value)}>
            {lists.map((l) => (
              <option key={l} value={l}>
                {listLabel(l)} ({values.filter((v) => v.list === l).length})
              </option>
            ))}
          </NativeSelect>
        </Field>
        <AddValueForm list={list} />
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No values in this list" description="Add the first value above." />
      ) : (
        <ValuesTable rows={rows} onEditLabel={(v) => setDialog({ kind: "label", value: v })} />
      )}

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          {dialog?.kind === "new-list" ? (
            <NewListForm
              onDone={(created) => {
                setDialog(null);
                if (created) setList(created);
              }}
            />
          ) : null}
          {dialog?.kind === "label" ? <LabelForm value={dialog.value} onDone={() => setDialog(null)} /> : null}
        </DialogContent>
      </Dialog>
    </AdminSection>
  );
}

function AddValueForm({ list }: { list: string }) {
  const id = React.useId();
  const [value, setValue] = React.useState("");
  const [label, setLabel] = React.useState("");
  const { run, pending, errors } = useAction(addPicklistValue, {
    success: "Value added",
    onSuccess: () => {
      setValue("");
      setLabel("");
    },
  });
  return (
    <form
      className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        void run({ list, value, label: label || undefined });
      }}
    >
      <Field label="New value" htmlFor={`${id}-value`} error={errors.value}>
        <Input id={`${id}-value`} value={value} onChange={(e) => setValue(e.target.value)} required />
      </Field>
      <Field label="Label (optional)" htmlFor={`${id}-label`} error={errors.label}>
        <Input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Same as value" />
      </Field>
      <Button type="submit" disabled={pending || !value.trim()}>
        <Plus aria-hidden /> Add
      </Button>
    </form>
  );
}

function ValuesTable({ rows, onEditLabel }: { rows: AdminPicklistValue[]; onEditLabel: (v: AdminPicklistValue) => void }) {
  const move = useAction(movePicklistValue);
  const active = useAction(setPicklistActive, { success: "Saved" });
  const del = useAction(deletePicklistValue, { success: "Value deleted" });
  const last = rows.length - 1;
  return (
    <AdminTable cards>
      <thead>
        <tr>
          <Th className="w-16">Order</Th>
          <Th>Value</Th>
          <Th>Label</Th>
          <Th className="w-24">Active</Th>
          <Th className="w-20 text-right">
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((v, i) => (
          <tr key={v.id} className={v.active ? undefined : "opacity-60"}>
            <Td label="Order">
              <div className="flex gap-0.5">
                <Button size="icon-sm" variant="ghost" aria-label={`Move ${v.label} up`} disabled={i === 0 || move.pending} onClick={() => void move.run({ id: v.id, direction: "up" })}>
                  <ArrowUp aria-hidden />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Move ${v.label} down`} disabled={i === last || move.pending} onClick={() => void move.run({ id: v.id, direction: "down" })}>
                  <ArrowDown aria-hidden />
                </Button>
              </div>
            </Td>
            <Td label="Value" className="text-xs text-muted">{v.value}</Td>
            <Td label="Label" primary>
              <span className="text-fg">{v.label}</span>
              {!v.active ? <Badge className="ml-2">Inactive</Badge> : null}
            </Td>
            <Td label="Active">
              <Switch label={`${v.label} active`} checked={v.active} disabled={active.pending} onCheckedChange={(on) => void active.run({ id: v.id, active: on })} />
            </Td>
            <Td actions>
              <div className="flex justify-end gap-0.5">
                <Button size="icon-sm" variant="ghost" aria-label={`Edit label of ${v.label}`} onClick={() => onEditLabel(v)}>
                  <Pencil aria-hidden />
                </Button>
                <ConfirmButton
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Delete ${v.label}`}
                  title={`Delete "${v.label}"?`}
                  description="Records that already use this value keep it. Consider deactivating instead so it can be restored."
                  confirmLabel="Delete value"
                  onConfirm={() => del.run({ id: v.id })}
                >
                  <Trash2 aria-hidden />
                </ConfirmButton>
              </div>
            </Td>
          </tr>
        ))}
      </tbody>
    </AdminTable>
  );
}

function LabelForm({ value, onDone }: { value: AdminPicklistValue; onDone: () => void }) {
  const id = React.useId();
  const [label, setLabel] = React.useState(value.label);
  const { run, pending, errors } = useAction(updatePicklistLabel, { success: "Label saved", onSuccess: onDone });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run({ id: value.id, label });
      }}
    >
      <DialogHeader>
        <DialogTitle>Edit label</DialogTitle>
        <DialogDescription>Stored value “{value.value}” stays the same.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Field label="Label" htmlFor={`${id}-label`} error={errors.label}>
          <Input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} required autoFocus />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

function NewListForm({ onDone }: { onDone: (created?: string) => void }) {
  const id = React.useId();
  const [name, setName] = React.useState("");
  const [value, setValue] = React.useState("");
  const list = slugify(name);
  const { run, pending, errors } = useAction(addPicklistValue, { success: "List created", onSuccess: () => onDone(list) });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run({ list, value });
      }}
    >
      <DialogHeader>
        <DialogTitle>New picklist</DialogTitle>
        <DialogDescription>A list exists once it has at least one value.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Field label="List name" htmlFor={`${id}-name`} error={errors.list} hint={`Key: ${list || "—"}`}>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="First value" htmlFor={`${id}-value`} error={errors.value}>
          <Input id={`${id}-value`} value={value} onChange={(e) => setValue(e.target.value)} required />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          Create list
        </Button>
      </DialogFooter>
    </form>
  );
}
