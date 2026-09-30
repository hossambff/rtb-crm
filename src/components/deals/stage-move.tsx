"use client";
import * as React from "react";
import { toast } from "sonner";
import { ArrowRight, Loader2 } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { getDealContacts, moveDealStage } from "@/lib/deals/actions";
import { gateFieldMeta, missingFields, needsReason, reasonPicklist } from "@/lib/deals/gates";
import type { ContactLite, Picklist, StageDTO } from "@/lib/deals/types";

export type MovableDeal = { id: string; name: string; filled: string[]; stageId: string };
export type MovePayload = { fields: Record<string, string>; newContact?: { fullName: string; email?: string; title?: string }; reasonCode?: string; reasonText?: string };

type Ctx = {
  picklists: { lost_reason: Picklist; hold_reason: Picklist };
  hiddenFields: string[];
  canCreateContact: boolean;
  /** Called inside the transition before the server call (use with useOptimistic). */
  onOptimistic?: (dealId: string, stageId: string) => void;
  onMoved?: (dealId: string, stageId: string) => void;
};

/**
 * Stage transitions with gates (KAN-1 / DEAL-2/3/7): moves directly when nothing is missing, otherwise opens the gate
 * dialog (missing required fields, next step, won/lost/hold reason). Server re-validates everything.
 */
export function useStageMove(ctx: Ctx) {
  const [target, setTarget] = React.useState<{ deal: MovableDeal; stage: StageDTO } | null>(null);
  const [pending, startTransition] = React.useTransition();
  const ctxRef = React.useRef(ctx);
  React.useEffect(() => {
    ctxRef.current = ctx;
  });

  const commit = React.useCallback((deal: MovableDeal, stage: StageDTO, payload: MovePayload, onDone?: () => void) => {
    startTransition(async () => {
      ctxRef.current.onOptimistic?.(deal.id, stage.id);
      const res = await moveDealStage({ dealId: deal.id, toStageId: stage.id, ...payload });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const extra = res.data.created.includes("migration_project")
        ? " · Onboarding project created"
        : res.data.created.includes("invoice")
          ? " · Invoice scheduled"
          : "";
      toast.success(`${deal.name} → ${stage.name}${extra}`);
      ctxRef.current.onMoved?.(deal.id, stage.id);
      onDone?.();
    });
  }, []);

  const request = React.useCallback(
    (deal: MovableDeal, stage: StageDTO) => {
      if (deal.stageId === stage.id) return;
      const missing = missingFields(stage, deal.filled);
      if (missing.length === 0 && !needsReason(stage.category)) commit(deal, stage, { fields: {} });
      else setTarget({ deal, stage });
    },
    [commit],
  );

  const dialog = target ? (
    <StageGateDialog
      key={`${target.deal.id}:${target.stage.id}`}
      deal={target.deal}
      stage={target.stage}
      picklists={ctx.picklists}
      hiddenFields={ctx.hiddenFields}
      canCreateContact={ctx.canCreateContact}
      pending={pending}
      onCancel={() => setTarget(null)}
      onConfirm={(payload) => commit(target.deal, target.stage, payload, () => setTarget(null))}
    />
  ) : null;

  return { request, dialog, pending };
}

function StageGateDialog({
  deal,
  stage,
  picklists,
  hiddenFields,
  canCreateContact,
  pending,
  onCancel,
  onConfirm,
}: {
  deal: MovableDeal;
  stage: StageDTO;
  picklists: Ctx["picklists"];
  hiddenFields: string[];
  canCreateContact: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (p: MovePayload) => void;
}) {
  const missing = missingFields(stage, deal.filled);
  const blocked = missing.filter((k) => hiddenFields.includes(k));
  const editable = missing.filter((k) => !hiddenFields.includes(k));
  const list = reasonPicklist(stage.category);
  const reasonOptions = list ? picklists[list] : [];
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [reasonCode, setReasonCode] = React.useState("");
  const [reasonText, setReasonText] = React.useState("");
  const [contacts, setContacts] = React.useState<ContactLite[] | null>(null);
  const [newContact, setNewContact] = React.useState({ fullName: "", email: "", title: "" });
  const needsContact = editable.some((k) => gateFieldMeta(k).kind === "contact");
  const creatingContact = values.primaryContactId === "__new__";

  React.useEffect(() => {
    if (!needsContact) return;
    let alive = true;
    getDealContacts({ dealId: deal.id }).then((r) => {
      if (alive) setContacts(r.ok ? r.data : []);
    });
    return () => {
      alive = false;
    };
  }, [deal.id, needsContact]);

  const set = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));
  const reasonOk = !needsReason(stage.category) || (list ? !!reasonCode : reasonText.trim().length >= 3);
  const fieldsOk = editable.every((k) => (k === "primaryContactId" && creatingContact ? newContact.fullName.trim().length >= 2 : !!values[k]?.trim()));
  const canSubmit = !pending && blocked.length === 0 && reasonOk && fieldsOk;

  const title =
    stage.category === "won" ? `Mark as won — ${stage.name}` : stage.category === "lost" ? `Mark as lost` : stage.category === "hold" ? `Put on hold` : `Move to ${stage.name}`;

  return (
    <Dialog open onOpenChange={(o) => (!o && !pending ? onCancel() : undefined)}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            const fields = { ...values };
            let nc: MovePayload["newContact"];
            if (creatingContact) {
              delete fields.primaryContactId;
              nc = { fullName: newContact.fullName.trim(), email: newContact.email.trim() || undefined, title: newContact.title.trim() || undefined };
            }
            onConfirm({ fields, newContact: nc, reasonCode: reasonCode || undefined, reasonText: reasonText.trim() || undefined });
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="flex items-center gap-1.5">
              <span className="truncate">{deal.name}</span>
              <ArrowRight className="size-3 shrink-0" aria-hidden />
              <span className="text-secondary">{stage.name}</span>
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {blocked.length ? (
              <p className="rounded-md border border-border-strong bg-surface-1 px-3 py-2 text-xs text-secondary">
                {stage.name} requires {blocked.map((k) => gateFieldMeta(k).label).join(", ")}, which your role can&apos;t edit. Ask your manager to complete
                {blocked.length > 1 ? " them" : " it"}.
              </p>
            ) : null}
            {editable.length ? (
              <div className="space-y-3">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Required to enter this stage</p>
                {editable.map((k) => (
                  <GateField
                    key={k}
                    field={k}
                    value={values[k] ?? ""}
                    onChange={(v) => set(k, v)}
                    contacts={contacts}
                    canCreateContact={canCreateContact}
                  />
                ))}
                {creatingContact ? (
                  <div className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-2">
                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor="nc-name">Full name</Label>
                      <Input id="nc-name" value={newContact.fullName} onChange={(e) => setNewContact({ ...newContact, fullName: e.target.value })} required />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="nc-email">Email</Label>
                      <Input id="nc-email" type="email" value={newContact.email} onChange={(e) => setNewContact({ ...newContact, email: e.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="nc-title">Title</Label>
                      <Input id="nc-title" value={newContact.title} onChange={(e) => setNewContact({ ...newContact, title: e.target.value })} />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {needsReason(stage.category) ? (
              <div className="space-y-3">
                {list ? (
                  <div className="space-y-1">
                    <Label htmlFor="reason-code">{stage.category === "lost" ? "Lost reason" : "Hold reason"}</Label>
                    <NativeSelect id="reason-code" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} required>
                      <option value="">Select a reason…</option>
                      {reasonOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                ) : null}
                <div className="space-y-1">
                  <Label htmlFor="reason-text">{stage.category === "won" ? "Win note (required)" : "Details"}</Label>
                  <Textarea
                    id="reason-text"
                    value={reasonText}
                    onChange={(e) => setReasonText(e.target.value)}
                    placeholder={stage.category === "won" ? "What closed it? Terms, champion, timing…" : stage.category === "hold" ? "Waiting on… until…" : "Context for the team"}
                    required={stage.category === "won"}
                  />
                </div>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!canSubmit}>
              {pending ? <Loader2 className="animate-spin" /> : null}
              {stage.category === "open" ? "Move deal" : title.split(" —")[0]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GateField({
  field,
  value,
  onChange,
  contacts,
  canCreateContact,
}: {
  field: string;
  value: string;
  onChange: (v: string) => void;
  contacts: ContactLite[] | null;
  canCreateContact: boolean;
}) {
  const meta = gateFieldMeta(field);
  const id = `gate-${field}`;
  if (meta.kind === "contact") {
    return (
      <div className="space-y-1">
        <Label htmlFor={id}>{meta.label}</Label>
        <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={contacts == null}>
          <option value="">{contacts == null ? "Loading contacts…" : contacts.length ? "Select a contact…" : "No contacts on this account"}</option>
          {(contacts ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.title ? ` — ${c.title}` : ""}
            </option>
          ))}
          {canCreateContact ? <option value="__new__">+ New contact…</option> : null}
        </NativeSelect>
      </div>
    );
  }
  const type = meta.kind === "date" ? "date" : meta.kind === "text" ? "text" : "text";
  const inputMode = meta.kind === "number" || meta.kind === "usd" || meta.kind === "percent" ? "decimal" : undefined;
  const placeholder = meta.kind === "usd" ? "$ amount" : meta.kind === "percent" ? "0–100" : meta.kind === "number" ? "e.g. 2,500,000" : undefined;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{meta.label}</Label>
      <Input id={id} type={type} inputMode={inputMode} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} required />
    </div>
  );
}
