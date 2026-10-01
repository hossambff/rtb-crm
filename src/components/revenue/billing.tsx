"use client";
import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Field } from "@/components/r100/field";
import { fmtDate, fmtUsd } from "@/lib/format";
import { updateBilling } from "@/lib/revenue/actions";
import { ADS_CATEGORY } from "@/lib/revenue/calc";
import type { AdsDealRow } from "@/lib/revenue/queries";

const CATEGORY_LABEL = { warm: "Warm deal", active: "Active deal", current: "Current client", renewal: "Renewal due", churned: "Churned" } as const;

/** Sponsorship deals with their billing schedule (ADS-1/2). */
export function BillingTable({ deals }: { deals: AdsDealRow[] }) {
  const [editing, setEditing] = React.useState<AdsDealRow | null>(null);
  if (!deals.length) return <EmptyState title="No sponsorship deals" description="TheStreet sponsorship deals you can see appear here." />;
  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="table-cards w-full min-w-[900px] text-sm">
          <thead className="bg-surface-1 text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Deal</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium">Stage</th>
              <th className="px-3 py-2 text-right font-medium">Contract</th>
              <th className="px-3 py-2 text-right font-medium">Annualized</th>
              <th className="px-3 py-2 font-medium">Next payment</th>
              <th className="px-3 py-2 font-medium">Renewal</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {deals.map((d) => {
              const cat = ADS_CATEGORY[d.stageKey];
              return (
                <tr key={d.id} className="border-t border-border hover:bg-surface-1">
                  <td data-primary className="px-3 py-2">
                    <div className="min-w-0">
                      <p className="font-medium text-fg">{d.name}</p>
                      <p className="text-[11px] text-muted">{d.ownerName ?? "Unassigned"}</p>
                    </div>
                  </td>
                  <td data-label="Category" className="px-3 py-2">{cat ? <Badge>{CATEGORY_LABEL[cat]}</Badge> : "—"}</td>
                  <td data-label="Stage" className="px-3 py-2 text-secondary">{d.stageName}</td>
                  <td data-label="Contract" className="px-3 py-2 text-right tabular">{fmtUsd(d.contractValueCents, { cents: true })}</td>
                  <td data-label="Annualized" className="px-3 py-2 text-right tabular">{fmtUsd(d.annualizedValueCents, { cents: true })}</td>
                  <td data-label="Next payment" className="px-3 py-2 tabular text-secondary">
                    {d.nextPaymentCents != null ? `${fmtUsd(d.nextPaymentCents, { cents: true })} · ${fmtDate(d.nextPaymentAt)}` : "—"}
                  </td>
                  <td data-label="Renewal" className="px-3 py-2 tabular text-secondary">{fmtDate(d.renewalAt)}</td>
                  <td data-actions className="px-3 py-2 text-right">
                    {d.canEdit ? (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(d)}>
                        Billing…
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing ? <BillingDialog deal={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function BillingDialog({ deal, onClose }: { deal: AdsDealRow; onClose: () => void }) {
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, start] = React.useTransition();
  const cents = (v: FormDataEntryValue | null) => (v === null || v === "" ? null : Math.round(Number(v) * 100));
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    start(async () => {
      const res = await updateBilling({
        dealId: deal.id,
        annualizedValueCents: cents(f.get("annualized")),
        nextPaymentCents: cents(f.get("nextPayment")),
        nextPaymentAt: String(f.get("nextPaymentAt") || "") || null,
        renewalAt: String(f.get("renewalAt") || "") || null,
      });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success("Billing schedule saved");
      onClose();
    });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Billing schedule</DialogTitle>
            <DialogDescription>{deal.name}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Annualized value (USD)" error={errors.annualizedValueCents?.[0]}>
                <Input name="annualized" type="number" min={0} step={0.01} defaultValue={deal.annualizedValueCents != null ? deal.annualizedValueCents / 100 : ""} />
              </Field>
              <Field label="Renewal / end date" error={errors.renewalAt?.[0]}>
                <Input name="renewalAt" type="date" defaultValue={deal.renewalAt?.slice(0, 10) ?? ""} />
              </Field>
              <Field label="Next payment (USD)" error={errors.nextPaymentCents?.[0]}>
                <Input name="nextPayment" type="number" min={0} step={0.01} defaultValue={deal.nextPaymentCents != null ? deal.nextPaymentCents / 100 : ""} />
              </Field>
              <Field label="Next payment date" error={errors.nextPaymentAt?.[0]}>
                <Input name="nextPaymentAt" type="date" defaultValue={deal.nextPaymentAt?.slice(0, 10) ?? ""} />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
