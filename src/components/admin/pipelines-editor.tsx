"use client";
import * as React from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, ColorTick } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/misc";
import { AdminSection, AdminTable, ConfirmButton, Td, Th, useAction } from "@/components/admin/form";
import { CATEGORY_LABELS, PipelineForm, PresetForm, StageForm } from "@/components/admin/pipelines-editor-dialogs";
import { fmtNumber, fmtPct, fmtUsd } from "@/lib/format";
import { PRESET_LABELS } from "@/lib/admin/presets";
import { deleteStage, moveStage } from "@/lib/admin/pipelines-actions";
import type { AdminPipeline, AdminStage } from "@/lib/admin/config-queries";

type CustomField = { key: string; label: string; pipelineKey: string | null };
type DialogState =
  | { kind: "pipeline"; pipeline: AdminPipeline }
  | { kind: "stage"; pipeline: AdminPipeline; stage: AdminStage | null }
  | { kind: "preset"; pipeline: AdminPipeline }
  | null;

const UNIT_LABEL = { muu: "MUU", usd: "USD", activation: "Activations" } as const;

export function PipelinesEditor({ pipelines, customFields }: { pipelines: AdminPipeline[]; customFields: CustomField[] }) {
  const [dialog, setDialog] = React.useState<DialogState>(null);
  const close = () => setDialog(null);

  if (!pipelines.length) return <EmptyState title="No pipelines" description="Run the seed script to create the default pipelines." />;

  return (
    <>
      {pipelines.map((p) => (
        <AdminSection
          key={p.id}
          title={p.name}
          description={
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              <ColorTick color={p.color} />
              <span>{p.key}</span>
              <span aria-hidden>·</span>
              <span>{UNIT_LABEL[p.unit]}</span>
              {p.unit === "muu" ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="tabular">{fmtUsd(p.usdPerMuu)}/MUU</span>
                  <span aria-hidden>·</span>
                  <span className="tabular">rev share {fmtPct(p.defaultRevSharePct)}</span>
                </>
              ) : null}
              {!p.active ? <Badge>Inactive</Badge> : null}
            </span>
          }
          actions={
            <>
              {p.unit === "muu" ? (
                <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "preset", pipeline: p })}>
                  Preset: {p.preset ? PRESET_LABELS[p.preset].split(" (")[0] : "Custom"}
                </Button>
              ) : null}
              <Button size="sm" onClick={() => setDialog({ kind: "pipeline", pipeline: p })}>
                <Pencil aria-hidden /> Edit
              </Button>
              <Button size="sm" onClick={() => setDialog({ kind: "stage", pipeline: p, stage: null })}>
                <Plus aria-hidden /> Add stage
              </Button>
            </>
          }
        >
          {p.description ? <p className="mb-3 text-sm text-muted">{p.description}</p> : null}
          <StagesTable pipeline={p} onEdit={(stage) => setDialog({ kind: "stage", pipeline: p, stage })} />
        </AdminSection>
      ))}

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent className={dialog?.kind === "stage" && dialog.stage ? "max-w-2xl" : undefined}>
          {dialog?.kind === "pipeline" ? <PipelineForm pipeline={dialog.pipeline} onDone={close} /> : null}
          {dialog?.kind === "stage" ? (
            <StageForm
              pipeline={dialog.pipeline}
              stage={dialog.stage}
              customFields={customFields.filter((f) => !f.pipelineKey || f.pipelineKey === dialog.pipeline.key)}
              onDone={close}
            />
          ) : null}
          {dialog?.kind === "preset" ? <PresetForm pipeline={dialog.pipeline} onDone={close} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function StagesTable({ pipeline, onEdit }: { pipeline: AdminPipeline; onEdit: (s: AdminStage) => void }) {
  const move = useAction(moveStage);
  const del = useAction(deleteStage, { success: "Stage deleted" });
  if (!pipeline.stages.length) return <EmptyState title="No stages yet" description="Add the first stage to this pipeline." />;
  const last = pipeline.stages.length - 1;
  return (
    <AdminTable>
      <thead>
        <tr>
          <Th className="w-16">Order</Th>
          <Th>Stage</Th>
          <Th>Category</Th>
          <Th className="text-right">Probability</Th>
          <Th className="text-right">SLA</Th>
          <Th>Gates</Th>
          <Th className="text-right">Deals</Th>
          <Th className="w-24 text-right">
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {pipeline.stages.map((st, i) => (
          <tr key={st.id}>
            <Td>
              <div className="flex gap-0.5">
                <Button size="icon-sm" variant="ghost" aria-label={`Move ${st.name} up`} disabled={i === 0 || move.pending} onClick={() => void move.run({ id: st.id, direction: "up" })}>
                  <ArrowUp aria-hidden />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Move ${st.name} down`} disabled={i === last || move.pending} onClick={() => void move.run({ id: st.id, direction: "down" })}>
                  <ArrowDown aria-hidden />
                </Button>
              </div>
            </Td>
            <Td>
              <div className="font-medium text-fg">{st.name}</div>
              <div className="text-xs text-muted">{st.key}</div>
            </Td>
            <Td>{CATEGORY_LABELS[st.category]}</Td>
            <Td className="text-right tabular">{fmtPct(st.probability)}</Td>
            <Td className="text-right tabular">{st.slaDays != null ? `${st.slaDays}d` : "—"}</Td>
            <Td>
              <div className="flex flex-wrap gap-1">
                {st.requiredFields.map((f) => (
                  <Badge key={f}>{f}</Badge>
                ))}
                {st.requiresApproval ? <Badge>Approval</Badge> : null}
                {!st.requiredFields.length && !st.requiresApproval ? <span className="text-muted">—</span> : null}
              </div>
            </Td>
            <Td className="text-right tabular">{fmtNumber(st.dealCount)}</Td>
            <Td>
              <div className="flex justify-end gap-0.5">
                <Button size="icon-sm" variant="ghost" aria-label={`Edit ${st.name}`} onClick={() => onEdit(st)}>
                  <Pencil aria-hidden />
                </Button>
                <ConfirmButton
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Delete ${st.name}`}
                  title={`Delete stage "${st.name}"?`}
                  description={
                    st.dealCount > 0
                      ? `${fmtNumber(st.dealCount)} deals are in this stage — move them first; deletion will be refused.`
                      : "This can't be undone. The change is audit-logged."
                  }
                  confirmLabel="Delete stage"
                  onConfirm={() => del.run({ id: st.id })}
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
