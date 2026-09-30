"use client";
import * as React from "react";
import { toast } from "sonner";
import { MoreHorizontal, Plus } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState } from "@/components/ui/misc";
import { Field } from "@/components/r100/field";
import { fmtDate, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { createInvoice, deleteInvoice, setInvoiceStatus, updateInvoice } from "@/lib/revenue/actions";
import { INVOICE_STATUS_LABELS, INVOICE_STATUSES, type InvoiceStatus } from "@/lib/revenue/calc";
import type { InvoiceRow } from "@/lib/revenue/queries";

type Perms = { canCreate: boolean; canEdit: boolean; canDelete: boolean };

export function InvoiceStatusBadge({ status, days }: { status: InvoiceStatus; days?: number }) {
  if (status === "paid") return <StatusBadge status="good" label="Paid" />;
  if (status === "overdue") return <StatusBadge status={days != null && days > 14 ? "critical" : "serious"} label={days ? `Overdue ${days}d` : "Overdue"} />;
  if (status === "written_off") return <StatusBadge status="critical" label="Written off" />;
  return <Badge>{INVOICE_STATUS_LABELS[status]}</Badge>;
}

export function NewInvoiceButton({ deals }: { deals: { id: string; name: string }[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} disabled={!deals.length} title={deals.length ? undefined : "No deals available to invoice"}>
        <Plus /> New invoice
      </Button>
      {open ? <InvoiceDialog deals={deals} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function InvoiceDialog({ deals, invoice, onClose }: { deals: { id: string; name: string }[]; invoice?: InvoiceRow; onClose: () => void }) {
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const [pending, start] = React.useTransition();
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const payload = {
      amountCents: Math.round(Number(f.get("amount") || 0) * 100),
      dueAt: String(f.get("dueAt") || ""),
      paidInKind: String(f.get("paidInKind") || "") || null,
      notes: String(f.get("notes") || "") || null,
    };
    start(async () => {
      const res = invoice ? await updateInvoice({ id: invoice.id, ...payload }) : await createInvoice({ dealId: String(f.get("dealId") || ""), ...payload });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success(invoice ? "Invoice updated" : "Invoice scheduled");
      onClose();
    });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{invoice ? "Edit invoice" : "New invoice"}</DialogTitle>
            <DialogDescription>{invoice ? invoice.dealName : "Schedule a billing milestone on a sponsorship deal."}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {!invoice ? (
              <Field label="Deal" error={errors.dealId?.[0]}>
                <NativeSelect name="dealId" required defaultValue="">
                  <option value="" disabled>
                    Select a deal…
                  </option>
                  {deals.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount (USD)" error={errors.amountCents?.[0]}>
                <Input name="amount" type="number" min={0.01} step={0.01} required defaultValue={invoice ? invoice.amountCents / 100 : undefined} className="tabular" />
              </Field>
              <Field label="Due date" error={errors.dueAt?.[0]}>
                <Input name="dueAt" type="date" required defaultValue={invoice?.dueAt.slice(0, 10)} />
              </Field>
            </div>
            <Field label="Payment in kind" hint="Token or equity consideration, e.g. “250,000 HIVE at $0.12, valued by finance”." error={errors.paidInKind?.[0]}>
              <Input name="paidInKind" defaultValue={invoice?.paidInKind ?? ""} />
            </Field>
            <Field label="Notes" error={errors.notes?.[0]}>
              <Textarea name="notes" defaultValue={invoice?.notes ?? ""} rows={3} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {invoice ? "Save" : "Schedule invoice"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function useInvoiceActions() {
  const [pending, start] = React.useTransition();
  const setStatus = (inv: InvoiceRow, status: "scheduled" | "sent" | "paid" | "written_off") =>
    start(async () => {
      const res = await setInvoiceStatus({ id: inv.id, status });
      if (!res.ok) toast.error(res.error);
      else toast.success(`Marked ${INVOICE_STATUS_LABELS[status].toLowerCase()}`);
    });
  const remove = (inv: InvoiceRow) =>
    start(async () => {
      if (!window.confirm(`Delete the ${fmtUsd(inv.amountCents, { cents: true })} invoice for ${inv.dealName}?`)) return;
      const res = await deleteInvoice({ id: inv.id });
      if (!res.ok) toast.error(res.error);
      else toast.success("Invoice deleted");
    });
  return { pending, setStatus, remove };
}

function RowMenu({ inv, perms, onEdit }: { inv: InvoiceRow; perms: Perms; onEdit: () => void }) {
  const { pending, setStatus, remove } = useInvoiceActions();
  if (!perms.canEdit && !perms.canDelete) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Actions for invoice ${inv.dealName}`} disabled={pending}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {perms.canEdit ? (
          <>
            <DropdownMenuItem onSelect={onEdit}>Edit…</DropdownMenuItem>
            {inv.status !== "paid" ? <DropdownMenuItem onSelect={() => setStatus(inv, "paid")}>Mark paid</DropdownMenuItem> : null}
            {inv.status === "scheduled" ? <DropdownMenuItem onSelect={() => setStatus(inv, "sent")}>Mark sent</DropdownMenuItem> : null}
            {inv.status !== "written_off" && inv.status !== "paid" ? <DropdownMenuItem onSelect={() => setStatus(inv, "written_off")}>Write off</DropdownMenuItem> : null}
            {inv.status === "paid" || inv.status === "written_off" ? <DropdownMenuItem onSelect={() => setStatus(inv, "sent")}>Reopen as sent</DropdownMenuItem> : null}
          </>
        ) : null}
        {perms.canDelete && inv.status !== "paid" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => remove(inv)} className="[&_svg]:text-critical">
              Delete…
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function InvoicesTable({ invoices, perms, deals, highlightId }: { invoices: InvoiceRow[]; perms: Perms; deals: { id: string; name: string }[]; highlightId?: string | null }) {
  const [status, setStatus] = React.useState<"all" | InvoiceStatus>("all");
  // deep link from alerts (/revenue?invoice=<id>): scroll the row into view
  React.useEffect(() => {
    if (highlightId) document.getElementById(`invoice-${highlightId}`)?.scrollIntoView({ block: "center" });
  }, [highlightId]);
  const [editing, setEditing] = React.useState<InvoiceRow | null>(null);
  const rows = invoices.filter((i) => status === "all" || i.status === status);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <NativeSelect aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="w-auto min-w-40">
          <option value="all">All statuses</option>
          {INVOICE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {INVOICE_STATUS_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
        <span className="ml-auto text-xs text-muted tabular">{rows.length} invoices</span>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No invoices" description={invoices.length ? "Nothing matches this filter." : "Schedule the first billing milestone with “New invoice”."} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-surface-1 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Deal</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Due</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Paid</th>
                <th className="px-3 py-2 font-medium">Payment in kind</th>
                <th className="w-10 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => (
                <tr key={inv.id} id={`invoice-${inv.id}`} className={cn("border-t border-border hover:bg-surface-1", inv.id === highlightId && "bg-surface-2")} aria-current={inv.id === highlightId ? "true" : undefined}>
                  <td className="px-3 py-2">
                    <p className="font-medium text-fg">{inv.dealName}</p>
                    {inv.accountName ? <p className="text-[11px] text-muted">{inv.accountName}</p> : null}
                  </td>
                  <td className="px-3 py-2 text-secondary">{inv.ownerName ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-medium text-fg tabular">{fmtUsd(inv.amountCents, { cents: true })}</td>
                  <td className="px-3 py-2 tabular">{fmtDate(inv.dueAt)}</td>
                  <td className="px-3 py-2">
                    <InvoiceStatusBadge status={inv.status} days={inv.daysOverdue} />
                  </td>
                  <td className="px-3 py-2 tabular text-secondary">{fmtDate(inv.paidAt)}</td>
                  <td className="max-w-48 truncate px-3 py-2 text-xs text-secondary" title={inv.paidInKind ?? undefined}>
                    {inv.paidInKind ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <RowMenu inv={inv} perms={perms} onEdit={() => setEditing(inv)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? <InvoiceDialog deals={deals} invoice={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

const BOARD: { status: InvoiceStatus; title: string }[] = [
  { status: "scheduled", title: "Scheduled" },
  { status: "sent", title: "Sent" },
  { status: "overdue", title: "Overdue" },
  { status: "paid", title: "Paid (last 90 days)" },
  { status: "written_off", title: "Written off" },
];

/** Collections board by effective status (ADS-2). */
export function CollectionsBoard({ invoices, perms }: { invoices: InvoiceRow[]; perms: Perms }) {
  const [now] = React.useState(() => Date.now());
  const recentPaid = (i: InvoiceRow) => i.status !== "paid" || (i.paidAt != null && now - new Date(i.paidAt).getTime() < 90 * 86_400_000);
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {BOARD.map((col) => {
        const items = invoices.filter((i) => i.status === col.status && recentPaid(i)).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
        const total = items.reduce((a, i) => a + i.amountCents, 0);
        return (
          <section key={col.status} aria-label={col.title} className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-surface-1">
            <header className="flex items-baseline justify-between border-b border-border px-3 py-2">
              <h3 className="font-sans text-sm font-medium text-fg">{col.title}</h3>
              <span className="text-xs text-muted tabular">
                {items.length} · {fmtUsd(total, { cents: true, compact: true })}
              </span>
            </header>
            <div className="flex max-h-[520px] flex-col gap-2 overflow-y-auto p-2">
              {items.length === 0 ? <p className="px-1 py-6 text-center text-xs text-muted">Nothing here</p> : null}
              {items.map((inv) => (
                <CollectionCard key={inv.id} inv={inv} perms={perms} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function CollectionCard({ inv, perms }: { inv: InvoiceRow; perms: Perms }) {
  const { pending, setStatus } = useInvoiceActions();
  return (
    <article className={cn("rounded-md border border-border bg-surface-2 p-3", pending && "opacity-60")}>
      <p className="truncate text-sm font-semibold text-fg">{inv.dealName}</p>
      <p className="mt-0.5 flex items-center justify-between text-xs text-muted">
        <span className="tabular">Due {fmtDate(inv.dueAt)}</span>
        <span className="font-medium text-fg tabular">{fmtUsd(inv.amountCents, { cents: true })}</span>
      </p>
      {inv.status === "overdue" ? (
        <div className="mt-2">
          <InvoiceStatusBadge status="overdue" days={inv.daysOverdue} />
        </div>
      ) : null}
      {perms.canEdit && inv.status !== "paid" && inv.status !== "written_off" ? (
        <div className="mt-2 flex gap-1.5">
          {inv.status === "scheduled" ? (
            <Button size="sm" onClick={() => setStatus(inv, "sent")} disabled={pending}>
              Mark sent
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setStatus(inv, "paid")} disabled={pending}>
            Mark paid
          </Button>
        </div>
      ) : null}
    </article>
  );
}
