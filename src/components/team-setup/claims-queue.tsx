"use client";
import { useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { RelativeTime } from "@/components/ui/relative-time";
import { useAction } from "@/components/admin/form";
import { decideApproval } from "@/lib/approvals/actions";
import { claimPlaceholder } from "@/lib/admin/users-actions";
import type { ClaimRow } from "@/lib/team-setup/queries";

const plural = (n: number, w: string) => `${new Intl.NumberFormat("en-US").format(n)} ${w}${n === 1 ? "" : "s"}`;

function ClaimItem({ c }: { c: ClaimRow }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const { run, pending } = useAction(decideApproval, { success: (d) => (d.status === "approved" ? "Approved — records moved." : "Rejected.") });
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-fg">
            {c.requesterName} <span className="text-muted">says they are</span> {c.placeholderName}
          </p>
          <p className="text-xs text-muted">
            {plural(c.deals, "deal")} · asked <RelativeTime value={c.createdAt} />
            {c.note ? ` · “${c.note}”` : ""}
          </p>
        </div>
        {c.overdue ? <StatusBadge status="warning" label="Overdue" /> : null}
        {c.canDecide && !rejecting ? (
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={pending} onClick={() => run({ id: c.id, decision: "approved" })}>
              <Check /> Approve
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => setRejecting(true)}>
              <X /> Reject
            </Button>
          </div>
        ) : !c.canDecide ? (
          <StatusBadge status="progress" label="With an admin" />
        ) : null}
      </div>
      {rejecting ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ id: c.id, decision: "rejected", note: reason });
          }}
        >
          <Input aria-label="Reason for rejecting" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (sent to them)" className="min-w-56 flex-1" />
          <Button type="submit" size="sm" variant="destructive" disabled={pending || !reason.trim()}>
            Reject
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRejecting(false)}>
            Cancel
          </Button>
        </form>
      ) : null}
    </li>
  );
}

function AssignRow({ p, people }: { p: { id: string; name: string; deals: number; accounts: number; tasks: number }; people: { id: string; name: string }[] }) {
  const [to, setTo] = useState("");
  const { run, pending } = useAction(claimPlaceholder, { success: (d) => `Moved ${d.summary}.` });
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-fg">{p.name}</p>
        <p className="text-xs text-muted tabular">
          {[plural(p.deals, "deal"), p.accounts ? plural(p.accounts, "account") : null, p.tasks ? plural(p.tasks, "open task") : null].filter(Boolean).join(" · ")}
        </p>
      </div>
      <NativeSelect aria-label={`Assign ${p.name} to`} className="w-48" value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="">Assign to…</option>
        {people.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </NativeSelect>
      <Button
        size="sm"
        variant="secondary"
        disabled={!to || pending}
        onClick={() => {
          const who = people.find((u) => u.id === to)?.name ?? "them";
          if (window.confirm(`Move everything ${p.name} owns to ${who}? This can't be undone from here.`)) void run({ placeholderId: p.id, targetUserId: to });
        }}
      >
        Assign
      </Button>
    </li>
  );
}

/** Pending "these are mine" requests (approve / reject via the approvals service) + admins' direct assignment. */
export function ClaimsQueue({
  claims,
  assign,
}: {
  claims: ClaimRow[];
  assign: { placeholders: { id: string; name: string; deals: number; accounts: number; tasks: number }[]; people: { id: string; name: string }[] } | null;
}) {
  return (
    <div className="space-y-6">
      <section aria-labelledby="claims-pending">
        <h3 id="claims-pending" className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
          Requests · {claims.length}
        </h3>
        {claims.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {claims.map((c) => (
              <ClaimItem key={c.id} c={c} />
            ))}
          </ul>
        ) : (
          <EmptyState title="No pending claims" description="When someone says an imported placeholder is them, it shows up here." />
        )}
      </section>
      {assign ? (
        <section aria-labelledby="claims-assign">
          <h3 id="claims-assign" className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
            Assign a placeholder directly
          </h3>
          <p className="mb-2 text-xs text-muted">Admins only. Moves deals, accounts, tasks, splits and history in one step; the placeholder is retired.</p>
          {assign.placeholders.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {assign.placeholders.map((p) => (
                <AssignRow key={p.id} p={p} people={assign.people} />
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted">Every placeholder has been claimed.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
