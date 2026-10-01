"use client";
import * as React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, ColorTick } from "@/components/ui/badge";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/misc";
import { AdminSection, AdminTable, ConfirmButton, Field, Td, Th, useAction } from "@/components/admin/form";
import { ChipMultiSelect } from "@/components/admin/fields-editor-controls";
import { FIELD_ENTITIES, FIELD_TYPE_LABELS, FIELD_TYPES, parseList, slugify } from "@/lib/admin/config-schemas";
import { deleteFieldDef, saveFieldDef } from "@/lib/admin/fields-actions";
import type { AdminFieldDef } from "@/lib/admin/config-queries";

type PipelineOpt = { key: string; name: string; color: string; stages: { key: string; name: string }[] };
type Entity = (typeof FIELD_ENTITIES)[number];
const ENTITY_LABELS: Record<Entity, string> = { account: "Accounts", contact: "Contacts", deal: "Deals" };

export function FieldsEditor({ fields, pipelines }: { fields: AdminFieldDef[]; pipelines: PipelineOpt[] }) {
  const [editing, setEditing] = React.useState<{ field: AdminFieldDef | null; entity: Entity } | null>(null);
  const [tab, setTab] = React.useState<Entity>("deal");
  const del = useAction(deleteFieldDef, { success: "Field deleted" });
  const pipeBy = new Map(pipelines.map((p) => [p.key, p]));

  return (
    <AdminSection
      title="Custom fields"
      description="Extra fields on accounts, contacts and deals. Values are stored per record; the key can't change once created."
      actions={
        <Button size="sm" onClick={() => setEditing({ field: null, entity: tab })}>
          <Plus aria-hidden /> New field
        </Button>
      }
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Entity)}>
        <TabsList>
          {FIELD_ENTITIES.map((e) => (
            <TabsTrigger key={e} value={e}>
              {ENTITY_LABELS[e]} <span className="ml-1 text-muted tabular">{fields.filter((f) => f.entity === e).length}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        {FIELD_ENTITIES.map((e) => {
          const rows = fields.filter((f) => f.entity === e);
          return (
            <TabsContent key={e} value={e}>
              {rows.length === 0 ? (
                <EmptyState title={`No custom ${e} fields`} description="Add a field to capture data the standard layout doesn't cover." />
              ) : (
                <AdminTable cards>
                  <thead>
                    <tr>
                      <Th>Label</Th>
                      <Th>Type</Th>
                      {e === "deal" ? <Th>Pipeline</Th> : null}
                      {e === "deal" ? <Th>Required at</Th> : null}
                      <Th className="text-right">Order</Th>
                      <Th className="w-20 text-right">
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((f) => {
                      const pipe = f.pipelineKey ? pipeBy.get(f.pipelineKey) : undefined;
                      return (
                        <tr key={f.id}>
                          <Td label="Label" primary>
                            <div className="min-w-0">
                              <div className="font-medium text-fg">{f.label}</div>
                              <div className="text-xs text-muted">{f.key}</div>
                            </div>
                          </Td>
                          <Td label="Type">
                            {FIELD_TYPE_LABELS[f.fieldType as keyof typeof FIELD_TYPE_LABELS] ?? f.fieldType}
                            {f.options.length ? <span className="ml-1 text-xs text-muted tabular">({f.options.length})</span> : null}
                          </Td>
                          {e === "deal" ? (
                            <Td label="Pipeline">
                              {pipe ? (
                                <span className="inline-flex items-center gap-1.5">
                                  <ColorTick color={pipe.color} />
                                  {pipe.key}
                                </span>
                              ) : (
                                <span className="text-muted">All</span>
                              )}
                            </Td>
                          ) : null}
                          {e === "deal" ? (
                            <Td label="Required at">
                              <div className="flex flex-wrap justify-end gap-1 md:justify-start">
                                {f.requiredAtStages.length ? f.requiredAtStages.map((s) => <Badge key={s}>{s}</Badge>) : <span className="text-muted">—</span>}
                              </div>
                            </Td>
                          ) : null}
                          <Td label="Order" className="text-right tabular">{f.sortOrder}</Td>
                          <Td actions>
                            <div className="flex justify-end gap-0.5">
                              <Button size="icon-sm" variant="ghost" aria-label={`Edit ${f.label}`} onClick={() => setEditing({ field: f, entity: e })}>
                                <Pencil aria-hidden />
                              </Button>
                              <ConfirmButton
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`Delete ${f.label}`}
                                title={`Delete field "${f.label}"?`}
                                description="Existing values stay in records but are no longer shown or validated. This is audit-logged."
                                confirmLabel="Delete field"
                                onConfirm={() => del.run({ id: f.id })}
                              >
                                <Trash2 aria-hidden />
                              </ConfirmButton>
                            </div>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </AdminTable>
              )}
            </TabsContent>
          );
        })}
      </Tabs>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          {editing ? <FieldForm field={editing.field} defaultEntity={editing.entity} pipelines={pipelines} onDone={() => setEditing(null)} /> : null}
        </DialogContent>
      </Dialog>
    </AdminSection>
  );
}

function FieldForm({ field, defaultEntity, pipelines, onDone }: { field: AdminFieldDef | null; defaultEntity: Entity; pipelines: PipelineOpt[]; onDone: () => void }) {
  const id = React.useId();
  const [entity, setEntity] = React.useState<Entity>((field?.entity as Entity) ?? defaultEntity);
  const [label, setLabel] = React.useState(field?.label ?? "");
  const [key, setKey] = React.useState(field?.key ?? "");
  const [keyTouched, setKeyTouched] = React.useState(Boolean(field));
  const [fieldType, setFieldType] = React.useState<(typeof FIELD_TYPES)[number]>((field?.fieldType as (typeof FIELD_TYPES)[number]) ?? "text");
  const [pipelineKey, setPipelineKey] = React.useState(field?.pipelineKey ?? "");
  const [options, setOptions] = React.useState((field?.options ?? []).join("\n"));
  const [stagesReq, setStagesReq] = React.useState<string[]>(field?.requiredAtStages ?? []);
  const [helpText, setHelpText] = React.useState(field?.helpText ?? "");
  const [sortOrder, setSortOrder] = React.useState(String(field?.sortOrder ?? 0));
  const { run, pending, errors } = useAction(saveFieldDef, { success: field ? "Field saved" : "Field created", onSuccess: onDone });
  const isPick = fieldType === "select" || fieldType === "multiselect";
  const stageOpts = pipelines.find((p) => p.key === pipelineKey)?.stages.map((s) => ({ value: s.key, label: s.name })) ?? [];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run({
          id: field?.id,
          entity,
          pipelineKey: entity === "deal" ? pipelineKey || null : null,
          key: keyTouched ? key : slugify(label),
          label,
          fieldType,
          options: isPick ? parseList(options) : [],
          requiredAtStages: entity === "deal" && pipelineKey ? stagesReq : [],
          helpText,
          sortOrder: Number(sortOrder),
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>{field ? `Edit field · ${field.label}` : "New custom field"}</DialogTitle>
        <DialogDescription>Every change is audit-logged.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Object" htmlFor={`${id}-entity`} error={errors.entity}>
            <NativeSelect id={`${id}-entity`} value={entity} disabled={Boolean(field)} onChange={(e) => setEntity(e.target.value as Entity)}>
              {FIELD_ENTITIES.map((en) => (
                <option key={en} value={en}>
                  {ENTITY_LABELS[en]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Type" htmlFor={`${id}-type`} error={errors.fieldType}>
            <NativeSelect id={`${id}-type`} value={fieldType} onChange={(e) => setFieldType(e.target.value as typeof fieldType)}>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FIELD_TYPE_LABELS[t]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Label" htmlFor={`${id}-label`} error={errors.label}>
            <Input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} required autoFocus />
          </Field>
          <Field label="Key" htmlFor={`${id}-key`} error={errors.key} hint={field ? "Keys can't change after creation." : "Generated from the label; lowercase and underscores."}>
            <Input
              id={`${id}-key`}
              value={keyTouched ? key : slugify(label)}
              disabled={Boolean(field)}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value);
              }}
            />
          </Field>
        </div>
        {entity === "deal" ? (
          <Field label="Pipeline" htmlFor={`${id}-pipe`} error={errors.pipelineKey} hint="Limit the field to one pipeline, or leave as All.">
            <NativeSelect
              id={`${id}-pipe`}
              value={pipelineKey}
              onChange={(e) => {
                setPipelineKey(e.target.value);
                setStagesReq([]);
              }}
            >
              <option value="">All pipelines</option>
              {pipelines.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.key} · {p.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
        {isPick ? (
          <Field label="Options" htmlFor={`${id}-opts`} error={errors.options} hint="One per line (or comma-separated).">
            <Textarea id={`${id}-opts`} rows={4} value={options} onChange={(e) => setOptions(e.target.value)} />
          </Field>
        ) : null}
        {entity === "deal" ? (
          <div className="space-y-1.5">
            <p id={`${id}-stages`} className="text-xs font-medium text-secondary">
              Required at stages
            </p>
            <ChipMultiSelect
              labelId={`${id}-stages`}
              options={stageOpts}
              value={stagesReq}
              onChange={setStagesReq}
              emptyText="Choose a pipeline to require this field at its stages."
            />
            {errors.requiredAtStages ? <p className="text-xs text-secondary" role="alert">{errors.requiredAtStages[0]}</p> : null}
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
          <Field label="Help text" htmlFor={`${id}-help`} error={errors.helpText}>
            <Input id={`${id}-help`} value={helpText} onChange={(e) => setHelpText(e.target.value)} />
          </Field>
          <Field label="Sort order" htmlFor={`${id}-sort`} error={errors.sortOrder}>
            <Input id={`${id}-sort`} className="tabular" type="number" min="0" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          </Field>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {field ? "Save field" : "Create field"}
        </Button>
      </DialogFooter>
    </form>
  );
}
