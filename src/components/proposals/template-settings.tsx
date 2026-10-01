"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Power, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { INPUT_LABELS, type InputKey } from "@/lib/proposals/docx/detect";
import { saveTemplateApproval, setTemplateActive } from "@/lib/proposals/template-actions";

/** Which rep changes need executive approval before a term sheet can be sent (PRO-3 for term sheets). */
export function TemplateApprovalRules(p: { templateId: string; tierChange: boolean; fields: InputKey[]; mapped: InputKey[]; readOnly?: boolean }) {
  const router = useRouter();
  const [tierChange, setTierChange] = React.useState(p.tierChange);
  const [fields, setFields] = React.useState<InputKey[]>(p.fields);
  const [pending, start] = React.useTransition();
  const dirty = tierChange !== p.tierChange || fields.length !== p.fields.length || fields.some((f) => !p.fields.includes(f));
  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2 text-sm text-body">
        <input type="checkbox" className="mt-0.5 size-4 accent-white" checked={tierChange} disabled={p.readOnly} onChange={(e) => setTierChange(e.target.checked)} />
        <span>
          A rep picks a revenue-share tier other than the one the deal&apos;s MUU falls in
          <span className="block text-xs text-muted">Recommended. The tier is otherwise chosen from the deal&apos;s audience.</span>
        </span>
      </label>
      {p.mapped.length ? (
        <fieldset>
          <legend className="mb-1.5 text-xs text-secondary">A rep changes one of these from the value prefilled from the deal:</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {p.mapped.map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm text-body">
                <input
                  type="checkbox"
                  className="size-4 accent-white"
                  disabled={p.readOnly}
                  checked={fields.includes(k)}
                  onChange={(e) => setFields(e.target.checked ? [...fields, k] : fields.filter((f) => f !== k))}
                />
                {INPUT_LABELS[k]}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <p className="text-xs text-muted">Map placeholders first to flag fields.</p>
      )}
      {!p.readOnly ? (
        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={pending || !dirty}
            onClick={() =>
              start(async () => {
                const res = await saveTemplateApproval({ id: p.templateId, tierChange, fields });
                if (!res.ok) return void toast.error(res.error);
                toast.success("Approval rules saved");
                router.refresh();
              })
            }
          >
            <Save /> Save rules
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Explicit activation after review (QA MAJ-19): disabled with the reason while the template is still a draft. */
export function TemplateActiveToggle({ templateId, active, disabledReason }: { templateId: string; active: boolean; disabledReason?: string | null }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <Button
      variant={active ? "secondary" : "primary"}
      disabled={pending || (!active && Boolean(disabledReason))}
      title={!active && disabledReason ? disabledReason : undefined}
      onClick={() => {
        if (active && !window.confirm("Deactivate this template? Reps can't create new term sheets until another version is active. Existing versions keep working.")) return;
        start(async () => {
          const res = await setTemplateActive({ id: templateId, active: !active });
          if (!res.ok) return void toast.error(res.error);
          toast.success(res.data.active ? "Active: new term sheets use this version" : "Deactivated");
          router.refresh();
        });
      }}
    >
      <Power /> {active ? "Deactivate" : "Activate for reps"}
    </Button>
  );
}
