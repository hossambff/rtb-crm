"use client";
import * as React from "react";
import { toast } from "sonner";
import { Search } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Field } from "@/components/r100/field";
import { fmtDate } from "@/lib/format";
import { checkRegistration, decideRegistration, registerLead, searchRegistrableAccounts } from "@/lib/commissions/actions";
import type { RegistrationConflict } from "@/lib/commissions/registration";
import type { RegistrationRow } from "@/lib/commissions/queries";

type Hit = { id: string; name: string; domain: string | null; owned: boolean; ownedByMe: boolean };
type Target = { accountId?: string; domain?: string; label: string; exists: boolean };

function StateBadge({ r }: { r: RegistrationRow }) {
  if (r.state === "pending") return <Badge>Pending review</Badge>;
  if (r.state === "rejected") return <StatusBadge status="critical" label="Rejected" />;
  if (r.state === "expired") return <Badge className="text-muted">Expired</Badge>;
  if (r.daysLeft != null && r.daysLeft <= 7) return <StatusBadge status="warning" label={`Protected · ${r.daysLeft}d left`} />;
  return <StatusBadge status="good" label={`Protected · ${r.daysLeft ?? "—"}d left`} />;
}

export function RegisterLead({ protectDays }: { protectDays: number }) {
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<Hit[]>([]);
  const [target, setTarget] = React.useState<Target | null>(null);
  const [name, setName] = React.useState("");
  const [note, setNote] = React.useState("");
  const [conflicts, setConflicts] = React.useState<RegistrationConflict[] | null>(null);
  const [pending, start] = React.useTransition();

  const search = () =>
    start(async () => {
      setTarget(null);
      setConflicts(null);
      const looksLikeDomain = /\.[a-z]{2,}/i.test(q) && !/\s/.test(q.trim());
      const res = await searchRegistrableAccounts({ q });
      if (!res.ok) return void toast.error(res.error);
      setHits(res.data);
      if (!res.data.length && looksLikeDomain) await pick({ domain: q.trim(), label: q.trim(), exists: false });
    });

  const pick = async (t: Target) => {
    setTarget(t);
    const res = await checkRegistration(t.accountId ? { accountId: t.accountId } : { domain: t.domain });
    if (!res.ok) {
      setConflicts(null);
      return void toast.error(res.error);
    }
    setConflicts(res.data.conflicts);
    if (!res.data.exists) setTarget({ ...t, domain: res.data.domain, exists: false });
  };

  const submit = () =>
    start(async () => {
      if (!target) return;
      const res = await registerLead({ accountId: target.accountId, domain: target.accountId ? undefined : target.domain, name: name || undefined, note: note || undefined });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Registration submitted for approval");
      setTarget(null);
      setConflicts(null);
      setHits([]);
      setQ("");
      setName("");
      setNote("");
    });

  const blocked = conflicts?.some((c) => c.severity === "block");

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Register a lead</CardTitle>
          <CardDescription>Search an existing account or enter a new domain. Approved registrations protect your ownership for {protectDays} days.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim().length >= 2) search();
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" aria-hidden />
            <Input aria-label="Account name or domain" placeholder="Account name or domain (example.com)" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <Button type="submit" disabled={pending || q.trim().length < 2}>
            Search
          </Button>
        </form>
        {hits.length ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {hits.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => start(() => pick({ accountId: h.id, label: h.name, exists: true }))}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2"
                >
                  <span className="text-fg">{h.name}</span>
                  <span className="text-xs text-muted">{h.domain ?? ""}</span>
                  <span className="ml-auto">{h.ownedByMe ? <Badge>Yours</Badge> : h.owned ? <Badge>Owned</Badge> : null}</span>
                </button>
              </li>
            ))}
            {/\.[a-z]{2,}/i.test(q) ? (
              <li>
                <button type="button" onClick={() => start(() => pick({ domain: q.trim(), label: q.trim(), exists: false }))} className="w-full px-3 py-2 text-left text-xs text-secondary hover:bg-surface-2">
                  Register “{q.trim()}” as a new domain instead
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
        {target ? (
          <div className="space-y-3 rounded-md border border-border bg-surface-1 p-3">
            <p className="text-sm text-body">
              {target.exists ? "Registering" : "New account"} <span className="font-medium text-fg">{target.label}</span>
              {!target.exists && target.domain ? <span className="text-muted"> · {target.domain}</span> : null}
            </p>
            {conflicts === null ? (
              <p className="text-xs text-muted">Checking conflicts…</p>
            ) : conflicts.length === 0 ? (
              <StatusBadge status="good" label="No conflicts" />
            ) : (
              <ul className="space-y-1" aria-label="Conflicts">
                {conflicts.map((c, i) => (
                  <li key={i}>
                    <StatusBadge status={c.severity === "block" ? "critical" : "warning"} label={c.message} />
                  </li>
                ))}
              </ul>
            )}
            {!target.exists ? (
              <Field label="Account name" hint="Defaults to the domain">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            ) : null}
            <Field label="Note for the approver">
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="How you know them, who you're talking to…" />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setTarget(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={pending || conflicts === null || blocked} onClick={submit}>
                Submit registration
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function RegistrationList({ rows, empty }: { rows: RegistrationRow[]; empty: string }) {
  if (!rows.length) return <EmptyState title="No registrations" description={empty} />;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-surface-1 text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Account</th>
            <th className="px-3 py-2 font-medium">Rep</th>
            <th className="px-3 py-2 font-medium">Submitted</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Protected until</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border">
              <td className="px-3 py-2">
                <p className="text-fg">{r.accountName}</p>
                <p className="text-[11px] text-muted">{r.domain ?? ""}</p>
              </td>
              <td className="px-3 py-2 text-secondary">{r.userName}</td>
              <td className="px-3 py-2 tabular">{fmtDate(r.createdAt)}</td>
              <td className="px-3 py-2">
                <StateBadge r={r} />
              </td>
              <td className="px-3 py-2 tabular">{fmtDate(r.protectedUntil)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ApprovalQueue({ rows }: { rows: RegistrationRow[] }) {
  const [pending, start] = React.useTransition();
  const decide = (r: RegistrationRow, decision: "approved" | "rejected") =>
    start(async () => {
      const note = decision === "rejected" ? (window.prompt(`Reason for rejecting ${r.accountName}?`) ?? undefined) : undefined;
      const res = await decideRegistration({ id: r.id, decision, note });
      if (!res.ok) return void toast.error(res.error);
      toast.success(decision === "approved" ? `${r.accountName} protected for ${r.userName}` : "Registration rejected");
    });
  if (!rows.length) return <p className="text-sm text-muted">No registrations waiting for review.</p>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-fg">
              {r.accountName} <span className="text-xs text-muted">{r.domain ?? ""}</span>
            </p>
            <p className="text-xs text-muted">
              {r.userName} · {fmtDate(r.createdAt)}
              {r.note ? ` · ${r.note}` : ""}
            </p>
          </div>
          <Button size="sm" disabled={pending} onClick={() => decide(r, "rejected")}>
            Reject
          </Button>
          <Button size="sm" variant="primary" disabled={pending} onClick={() => decide(r, "approved")}>
            Approve
          </Button>
        </li>
      ))}
    </ul>
  );
}
