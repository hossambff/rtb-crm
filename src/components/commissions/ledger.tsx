"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Play } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Field } from "@/components/r100/field";
import { fmtUsd } from "@/lib/format";
import { disputeAccrual, resolveDispute, runAccruals, setAccrualStatus } from "@/lib/commissions/actions";
import { TRIGGER_LABELS, type Trigger } from "@/lib/commissions/calc";
import type { AccrualRow } from "@/lib/commissions/queries";

type Perms = { canApprove: boolean; canMarkPaid: boolean; canRun: boolean };

export function AccrualStatusBadge({ status }: { status: string }) {
  if (status === "paid") return <StatusBadge status="good" label="Paid" />;
  if (status === "approved") return <Badge className="text-fg">Approved</Badge>;
  if (status === "disputed") return <StatusBadge status="serious" label="Disputed" />;
  if (status === "clawed_back") return <StatusBadge status="critical" label="Clawback" />;
  return <Badge>Accrued</Badge>;
}

export function RunAccrualsButton() {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <Button
      variant="primary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          let res: Awaited<ReturnType<typeof runAccruals>>;
          try {
            res = await runAccruals({});
          } catch {
            return void toast.error("Couldn't run accruals — the request failed. Try again.");
          }
          if (!res.ok) return void toast.error(res.error);
          const r = res.data;
          // QA-24: say why nothing happened instead of a silent "0 new".
          if (!r.assignments) {
            return void toast.warning("No commission plans are assigned yet, so there is nothing to accrue.", {
              description: "Assign a plan to each rep in the Assignments tab, then run accruals again.",
              action: { label: "Assignments", onClick: () => router.push("/commissions?tab=assignments") },
            });
          }
          if (!r.created && !r.clawbacks && !r.expiredRegistrations) {
            return void toast.info(`Accruals are up to date — ${r.assignments} assignment${r.assignments === 1 ? "" : "s"} checked, nothing new to accrue.`);
          }
          toast.success(
            `Accruals run: ${r.created} new (${fmtUsd(r.createdCents, { cents: true })})${r.clawbacks ? `, ${r.clawbacks} clawbacks` : ""}${r.expiredRegistrations ? `, ${r.expiredRegistrations} registrations expired` : ""}.`,
          );
        })
      }
    >
      <Play /> {pending ? "Running…" : "Run accruals"}
    </Button>
  );
}

export function Ledger({ rows, perms, currentUserId }: { rows: AccrualRow[]; perms: Perms; currentUserId: string }) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [status, setStatus] = React.useState("all");
  const [disputing, setDisputing] = React.useState<AccrualRow | null>(null);
  const [resolving, setResolving] = React.useState<AccrualRow | null>(null);
  const [pending, start] = React.useTransition();
  const filtered = rows.filter((r) => status === "all" || r.status === status);
  const bulk = perms.canApprove || perms.canMarkPaid;

  const apply = (next: "approved" | "paid") =>
    start(async () => {
      const res = await setAccrualStatus({ ids: [...selected], status: next });
      if (!res.ok) return void toast.error(res.error);
      toast.success(`${res.data.updated} marked ${next}${res.data.skipped ? ` · ${res.data.skipped} skipped` : ""}`);
      setSelected(new Set());
    });

  const toggleAll = (on: boolean) => setSelected(on ? new Set(filtered.map((r) => r.id)) : new Set());

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <NativeSelect aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto min-w-40">
          <option value="all">All statuses</option>
          <option value="accrued">Accrued</option>
          <option value="approved">Approved</option>
          <option value="paid">Paid</option>
          <option value="disputed">Disputed</option>
          <option value="clawed_back">Clawbacks</option>
        </NativeSelect>
        {bulk && selected.size ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">{selected.size} selected</span>
            {perms.canApprove ? (
              <Button size="sm" disabled={pending} onClick={() => apply("approved")}>
                Approve
              </Button>
            ) : null}
            {perms.canMarkPaid ? (
              <Button size="sm" disabled={pending} onClick={() => apply("paid")}>
                Mark paid
              </Button>
            ) : null}
          </div>
        ) : null}
        <span className="ml-auto text-xs text-muted tabular">{filtered.length} rows</span>
      </div>
      {filtered.length === 0 ? (
        <EmptyState title="No accruals" description={rows.length ? "Nothing matches this filter." : "Accruals appear after finance runs the accrual engine on assigned plans."} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="table-cards w-full min-w-[960px] text-sm">
            <thead className="bg-surface-1 text-left text-xs text-muted">
              <tr>
                {bulk ? (
                  <th className="w-8 px-3 py-2">
                    <input type="checkbox" aria-label="Select all" className="size-3.5 accent-white" checked={selected.size > 0 && selected.size === filtered.length} onChange={(e) => toggleAll(e.target.checked)} />
                  </th>
                ) : null}
                <th className="px-3 py-2 font-medium">Period</th>
                <th className="px-3 py-2 font-medium">Rep</th>
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-3 py-2 font-medium">Deal</th>
                <th className="px-3 py-2 font-medium">Detail</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-t border-border align-top hover:bg-surface-1">
                  {bulk ? (
                    <td data-label="Select" className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select accrual ${r.dealName ?? r.trigger}`}
                        className="size-3.5 accent-white"
                        checked={selected.has(r.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                  ) : null}
                  <td data-label="Period" className="px-3 py-2 tabular">{r.period}</td>
                  <td data-label="Rep" className="px-3 py-2 text-secondary">{r.userName}</td>
                  <td data-label="Trigger" className="px-3 py-2 text-secondary">{TRIGGER_LABELS[r.trigger as Trigger] ?? r.trigger}</td>
                  <td data-label="Deal" className="px-3 py-2 text-body">{r.dealName ?? "—"}</td>
                  <td data-label="Detail" className="max-w-72 whitespace-pre-line px-3 py-2 text-xs text-muted">{r.note}</td>
                  <td data-label="Amount" className="px-3 py-2 text-right font-medium text-fg tabular">{fmtUsd(r.amountCents, { cents: true })}</td>
                  <td data-label="Status" className="px-3 py-2">
                    <AccrualStatusBadge status={r.status} />
                  </td>
                  <td data-actions className="px-3 py-2 text-right">
                    {r.status === "disputed" && perms.canMarkPaid ? (
                      <Button size="sm" variant="ghost" onClick={() => setResolving(r)}>
                        Resolve
                      </Button>
                    ) : r.userId === currentUserId && (r.status === "accrued" || r.status === "approved") ? (
                      <Button size="sm" variant="ghost" onClick={() => setDisputing(r)}>
                        Dispute
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {disputing ? <DisputeDialog row={disputing} onClose={() => setDisputing(null)} /> : null}
      {resolving ? <ResolveDialog row={resolving} onClose={() => setResolving(null)} /> : null}
    </div>
  );
}

function DisputeDialog({ row, onClose }: { row: AccrualRow; onClose: () => void }) {
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string>();
  const [pending, start] = React.useTransition();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dispute accrual</DialogTitle>
          <DialogDescription>
            {row.dealName ?? row.trigger} · {fmtUsd(row.amountCents, { cents: true })} · {row.period}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="What's wrong?" error={error}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} placeholder="e.g. I sourced this deal; the split should be 30/70 not 0/100." />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await disputeAccrual({ id: row.id, note });
                if (!res.ok) return setError(res.fieldErrors?.note?.[0] ?? res.error);
                toast.success("Dispute sent to finance");
                onClose();
              })
            }
          >
            Submit dispute
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResolveDialog({ row, onClose }: { row: AccrualRow; onClose: () => void }) {
  const [pending, start] = React.useTransition();
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const amount = String(f.get("amount") ?? "");
    start(async () => {
      const res = await resolveDispute({
        id: row.id,
        status: f.get("status") === "approved" ? "approved" : "accrued",
        amountCents: amount === "" ? undefined : Math.round(Number(amount) * 100),
        note: String(f.get("note") ?? "") || undefined,
      });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Dispute resolved");
      onClose();
    });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Resolve dispute</DialogTitle>
            <DialogDescription>
              {row.userName} · {row.dealName ?? row.trigger} · {row.period}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="whitespace-pre-line rounded-md border border-border bg-surface-1 p-3 text-xs text-secondary">{row.note}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Amount (USD)" hint="Leave as is to keep the amount">
                <Input name="amount" type="number" step={0.01} defaultValue={row.amountCents / 100} className="tabular" />
              </Field>
              <Field label="New status">
                <NativeSelect name="status" defaultValue="accrued">
                  <option value="accrued">Accrued</option>
                  <option value="approved">Approved</option>
                </NativeSelect>
              </Field>
            </div>
            <Field label="Resolution note">
              <Textarea name="note" rows={3} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              Resolve
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
