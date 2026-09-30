"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Switch, useAction, Th, Td } from "@/components/admin/form";
import { ChipMultiSelect, numOrNull, pctOrNull, toPctStr } from "@/components/admin/fields-editor-controls";
import { VIZ } from "@/lib/palette";
import { fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DEAL_FIELDS, parseList, slugify, STAGE_CATEGORIES } from "@/lib/admin/config-schemas";
import { PRESET_LABELS, previewPreset, type ProbabilityPreset } from "@/lib/admin/presets";
import { applyProbabilityPreset, createStage, updatePipeline, updateStage } from "@/lib/admin/pipelines-actions";
import type { AdminPipeline, AdminStage } from "@/lib/admin/config-queries";

const SWATCH_NAMES = ["Blue", "Orange", "Green", "Purple", "Ochre", "Indigo", "Rose", "Teal"];
export const CATEGORY_LABELS: Record<(typeof STAGE_CATEGORIES)[number], string> = { open: "Open", won: "Won", lost: "Lost", hold: "Hold" };

function Swatches({ value, onChange, labelId }: { value: string; onChange: (c: string) => void; labelId: string }) {
  return (
    <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2">
      {VIZ.map((c, i) => {
        const on = value.toUpperCase() === c;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`${SWATCH_NAMES[i]} ${c}`}
            onClick={() => onChange(c)}
            className={cn(
              "size-7 rounded-full border-2 transition-[border-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
              on ? "border-white" : "border-transparent",
            )}
            style={{ background: c }}
          />
        );
      })}
    </div>
  );
}

export function PipelineForm({ pipeline, onDone }: { pipeline: AdminPipeline; onDone: () => void }) {
  const id = React.useId();
  const [name, setName] = React.useState(pipeline.name);
  const [description, setDescription] = React.useState(pipeline.description ?? "");
  const [color, setColor] = React.useState(pipeline.color.toUpperCase());
  const [usdPerMuu, setUsdPerMuu] = React.useState(String(pipeline.usdPerMuu));
  const [rev, setRev] = React.useState(toPctStr(pipeline.defaultRevSharePct));
  const [active, setActive] = React.useState(pipeline.active);
  const { run, pending, errors } = useAction(updatePipeline, { success: "Pipeline saved", onSuccess: onDone });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run({
          id: pipeline.id,
          name,
          description,
          color,
          usdPerMuu: Number(usdPerMuu),
          defaultRevSharePct: pctOrNull(rev),
          active,
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>Edit {pipeline.key} pipeline</DialogTitle>
        <DialogDescription>Value formula defaults apply to new deals in this pipeline.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Field label="Name" htmlFor={`${id}-name`} error={errors.name}>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Description" htmlFor={`${id}-desc`} error={errors.description}>
          <Textarea id={`${id}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>
        <div className="space-y-1.5">
          <p id={`${id}-color`} className="text-xs font-medium text-secondary">
            Color
          </p>
          <Swatches value={color} onChange={setColor} labelId={`${id}-color`} />
          {errors.color ? <p className="text-xs text-secondary" role="alert">{errors.color[0]}</p> : null}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="$ per MUU / year" htmlFor={`${id}-usd`} error={errors.usdPerMuu} hint="Default value per monthly unique user.">
            <Input id={`${id}-usd`} className="tabular" type="number" step="0.01" min="0" value={usdPerMuu} onChange={(e) => setUsdPerMuu(e.target.value)} />
          </Field>
          <Field label="Default revenue share (%)" htmlFor={`${id}-rev`} error={errors.defaultRevSharePct} hint="Leave empty if not applicable.">
            <Input id={`${id}-rev`} className="tabular" type="number" step="0.1" min="0" max="100" value={rev} onChange={(e) => setRev(e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center justify-between">
          <label htmlFor={`${id}-active`} className="text-sm text-body">
            Active
          </label>
          <Switch id={`${id}-active`} label="Pipeline active" checked={active} onCheckedChange={setActive} />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          Save pipeline
        </Button>
      </DialogFooter>
    </form>
  );
}

export function StageForm({
  pipeline,
  stage,
  customFields,
  onDone,
}: {
  pipeline: AdminPipeline;
  stage: AdminStage | null;
  customFields: { key: string; label: string }[];
  onDone: () => void;
}) {
  const id = React.useId();
  const [name, setName] = React.useState(stage?.name ?? "");
  const [prob, setProb] = React.useState(stage ? toPctStr(stage.probability) : "10");
  const [category, setCategory] = React.useState<(typeof STAGE_CATEGORIES)[number]>(stage?.category ?? "open");
  const [sla, setSla] = React.useState(stage?.slaDays != null ? String(stage.slaDays) : "");
  const [required, setRequired] = React.useState<string[]>(stage?.requiredFields ?? []);
  const [approval, setApproval] = React.useState(stage?.requiresApproval ?? false);
  const [aliases, setAliases] = React.useState((stage?.importAliases ?? []).join(", "));
  const create = useAction(createStage, { success: "Stage added", onSuccess: onDone });
  const update = useAction(updateStage, { success: "Stage saved", onSuccess: onDone });
  const { pending, errors } = stage ? update : create;
  const fieldOptions = [...DEAL_FIELDS.map((f) => ({ value: f.key, label: f.label })), ...customFields.map((f) => ({ value: f.key, label: `${f.label} (custom)` }))];
  // Keep unknown (legacy) required fields visible so they can be removed.
  for (const r of required) if (!fieldOptions.some((o) => o.value === r)) fieldOptions.push({ value: r, label: r });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const base = { name, probability: pctOrNull(prob) ?? Number.NaN, category, slaDays: numOrNull(sla) };
        if (stage)
          void update.run({ ...base, id: stage.id, requiredFields: required, requiresApproval: approval, importAliases: parseList(aliases, { lowercase: true }) });
        else void create.run({ ...base, pipelineId: pipeline.id });
      }}
    >
      <DialogHeader>
        <DialogTitle>{stage ? `Edit stage · ${stage.name}` : `Add stage to ${pipeline.name}`}</DialogTitle>
        <DialogDescription>{stage ? `Key: ${stage.key}` : `Key: ${slugify(name) || "—"} (generated from the name)`}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Field label="Name" htmlFor={`${id}-name`} error={errors.name}>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Probability (%)" htmlFor={`${id}-prob`} error={errors.probability}>
            <Input id={`${id}-prob`} className="tabular" type="number" min="0" max="100" step="1" value={prob} onChange={(e) => setProb(e.target.value)} required />
          </Field>
          <Field label="Category" htmlFor={`${id}-cat`} error={errors.category}>
            <NativeSelect id={`${id}-cat`} value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
              {STAGE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="SLA (days)" htmlFor={`${id}-sla`} error={errors.slaDays} hint="Empty = no SLA">
            <Input id={`${id}-sla`} className="tabular" type="number" min="1" max="365" value={sla} onChange={(e) => setSla(e.target.value)} />
          </Field>
        </div>
        {stage ? (
          <>
            <div className="space-y-1.5">
              <p id={`${id}-req`} className="text-xs font-medium text-secondary">
                Required fields to enter this stage
              </p>
              <ChipMultiSelect labelId={`${id}-req`} options={fieldOptions} value={required} onChange={setRequired} />
              {errors.requiredFields ? <p className="text-xs text-secondary" role="alert">{errors.requiredFields[0]}</p> : null}
            </div>
            <div className="flex items-center justify-between gap-4">
              <label htmlFor={`${id}-appr`} className="text-sm text-body">
                Requires approval to enter
              </label>
              <Switch id={`${id}-appr`} label="Requires approval" checked={approval} onCheckedChange={setApproval} />
            </div>
            <Field label="Import aliases" htmlFor={`${id}-alias`} error={errors.importAliases} hint="Comma-separated spreadsheet statuses that map to this stage (stored lowercase).">
              <Textarea id={`${id}-alias`} rows={2} value={aliases} onChange={(e) => setAliases(e.target.value)} />
            </Field>
          </>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {stage ? "Save stage" : "Add stage"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function PresetForm({ pipeline, onDone }: { pipeline: AdminPipeline; onDone: () => void }) {
  const id = React.useId();
  const [preset, setPreset] = React.useState<ProbabilityPreset>(pipeline.preset === "granular" ? "tiered" : "granular");
  const preview = previewPreset(preset, pipeline.stages);
  const changed = preview.filter((c) => c.changed).length;
  const { run, pending } = useAction(applyProbabilityPreset, {
    success: (d) => `Preset applied — ${d.changed} stage${d.changed === 1 ? "" : "s"} updated`,
    onSuccess: onDone,
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Probability preset · {pipeline.name}</DialogTitle>
        <DialogDescription>
          Current: {pipeline.preset ? PRESET_LABELS[pipeline.preset] : "custom / not set"}. Applying a preset overwrites stage probabilities.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Field label="Preset" htmlFor={`${id}-preset`}>
          <NativeSelect id={`${id}-preset`} value={preset} onChange={(e) => setPreset(e.target.value as ProbabilityPreset)}>
            {(Object.keys(PRESET_LABELS) as ProbabilityPreset[]).map((p) => (
              <option key={p} value={p}>
                {PRESET_LABELS[p]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <Th>Stage</Th>
              <Th className="text-right">Before</Th>
              <Th className="text-right">After</Th>
            </tr>
          </thead>
          <tbody>
            {preview.map((c) => (
              <tr key={c.id}>
                <Td>{c.name}</Td>
                <Td className="text-right tabular text-muted">{fmtPct(c.before)}</Td>
                <Td className={cn("text-right tabular", c.changed ? "font-medium text-fg" : "text-muted")}>{fmtPct(c.after)}</Td>
              </tr>
            ))}
          </tbody>
          </table>
        </div>
        <p className="text-xs text-muted">
          {changed} of {preview.length} stages change. Won stages stay at 100%; stages the preset doesn&apos;t know keep their value.
        </p>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="button" variant="primary" disabled={pending} onClick={() => void run({ pipelineId: pipeline.id, preset })}>
          Apply preset
        </Button>
      </DialogFooter>
    </>
  );
}
