"use client";
import * as React from "react";
import { Check, ExternalLink, Loader2, Plus, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { addDocument, addStakeholder, setTaskStatus, updateDocumentStatus, updateStakeholder } from "@/lib/deals/actions";
import { ROLE_LABELS, STAKEHOLDER_ROLES } from "@/lib/deals/rules";
import { fmtDate } from "@/lib/format";
import type { ContactLite, UserLite } from "@/lib/deals/types";
import { cn } from "@/lib/utils";
import { AddTaskDialog } from "./quick-actions";
import { useRun } from "./use-run";
import { RelativeTime } from "../deal-bits";

export function Panel({ title, count, action, children, id }: { title: string; count?: number; action?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} aria-label={title} className="rounded-lg border border-border bg-surface-1">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="font-display text-base text-fg">{title}</h2>
        {count != null ? <span className="text-xs text-muted tabular">{count}</span> : null}
        <div className="ml-auto">{action}</div>
      </div>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/* ───────────── Stakeholders (CARD-4) ───────────── */

type Stakeholder = { contactId: string; name: string; title: string | null; email: string | null; status: string; role: string | null; lastContactedAt: string | null; isPrimary: boolean };

export function StakeholdersPanel({
  dealId,
  stakeholders,
  gaps,
  accountContacts,
  canEdit,
  canCreateContact,
}: {
  dealId: string;
  stakeholders: Stakeholder[];
  gaps: string[];
  accountContacts: ContactLite[];
  canEdit: boolean;
  canCreateContact: boolean;
}) {
  const [adding, setAdding] = React.useState(false);
  const [run, pending] = useRun();
  const available = accountContacts.filter((c) => !stakeholders.some((s) => s.contactId === c.id));
  return (
    <Panel
      title="Stakeholders"
      count={stakeholders.length}
      action={
        canEdit ? (
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add
          </Button>
        ) : null
      }
    >
      {gaps.length ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {gaps.map((g) => (
            <StatusBadge key={g} status={g === "No decision maker" ? "serious" : "warning"} label={g} />
          ))}
        </div>
      ) : null}
      {stakeholders.length === 0 ? (
        <p className="text-sm text-muted">No stakeholders yet. Link the decision maker and champion to improve health.</p>
      ) : (
        <ul className="divide-y divide-border">
          {stakeholders.map((s) => (
            <li key={s.contactId} className="flex items-start gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                  <span className="truncate">{s.name}</span>
                  {s.isPrimary ? <Star className="size-3 fill-white text-white" aria-label="Primary contact" /> : null}
                  {s.status === "left_company" ? <StatusBadge status="warning" label="Left" /> : null}
                </p>
                <p className="truncate text-[11px] text-muted">
                  {s.title ?? "—"} · last touch {s.lastContactedAt ? <RelativeTime iso={s.lastContactedAt} /> : "never"}
                </p>
              </div>
              {canEdit ? (
                <div className="flex items-center gap-1">
                  <NativeSelect
                    aria-label={`Role of ${s.name}`}
                    className="h-7 w-32 text-[11px]"
                    value={s.role ?? ""}
                    disabled={pending}
                    onChange={(e) => run(() => updateStakeholder({ dealId, contactId: s.contactId, role: (e.target.value || null) as never }))}
                  >
                    <option value="">Role…</option>
                    {STAKEHOLDER_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </NativeSelect>
                  {!s.isPrimary ? (
                    <Button variant="ghost" size="icon-sm" aria-label={`Make ${s.name} primary`} onClick={() => run(() => updateStakeholder({ dealId, contactId: s.contactId, makePrimary: true }), { success: "Primary contact set" })}>
                      <Star />
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${s.name}`} onClick={() => run(() => updateStakeholder({ dealId, contactId: s.contactId, remove: true }))}>
                    <Trash2 />
                  </Button>
                </div>
              ) : s.role ? (
                <Badge>{ROLE_LABELS[s.role] ?? s.role}</Badge>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {adding ? <AddStakeholderDialog dealId={dealId} available={available} canCreateContact={canCreateContact} onClose={() => setAdding(false)} /> : null}
    </Panel>
  );
}

function AddStakeholderDialog({ dealId, available, canCreateContact, onClose }: { dealId: string; available: ContactLite[]; canCreateContact: boolean; onClose: () => void }) {
  const [contactId, setContactId] = React.useState(available[0]?.id ?? (canCreateContact ? "__new__" : ""));
  const [role, setRole] = React.useState("");
  const [nc, setNc] = React.useState({ fullName: "", email: "", title: "" });
  const [run, pending] = useRun();
  const isNew = contactId === "__new__";
  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () =>
                addStakeholder({
                  dealId,
                  contactId: isNew ? undefined : contactId,
                  newContact: isNew ? { fullName: nc.fullName, email: nc.email || undefined, title: nc.title || undefined } : undefined,
                  role: (role || null) as never,
                }),
              { success: "Stakeholder added", onOk: onClose },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Add stakeholder</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-1">
              <Label htmlFor="sh-contact">Contact</Label>
              <NativeSelect id="sh-contact" value={contactId} onChange={(e) => setContactId(e.target.value)}>
                {!available.length && !canCreateContact ? <option value="">No more contacts on this account</option> : null}
                {available.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.title ? ` — ${c.title}` : ""}
                  </option>
                ))}
                {canCreateContact ? <option value="__new__">+ New contact…</option> : null}
              </NativeSelect>
            </div>
            {isNew ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="sh-name">Full name</Label>
                  <Input id="sh-name" value={nc.fullName} onChange={(e) => setNc({ ...nc, fullName: e.target.value })} required minLength={2} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sh-email">Email</Label>
                  <Input id="sh-email" type="email" value={nc.email} onChange={(e) => setNc({ ...nc, email: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sh-title">Title</Label>
                  <Input id="sh-title" value={nc.title} onChange={(e) => setNc({ ...nc, title: e.target.value })} />
                </div>
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="sh-role">Role in deal</Label>
              <NativeSelect id="sh-role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">—</option>
                {STAKEHOLDER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !contactId || (isNew && nc.fullName.trim().length < 2)}>
              {pending ? <Loader2 className="animate-spin" /> : null} Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────── Tasks (CARD-5) ───────────── */

type TaskRow = {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  origin: string;
  owedBy: string | null;
  evidence: string | null;
  evidenceSource: string | null;
  assigneeName: string | null;
  overdue: boolean;
  completedAt: string | null;
};

const ORIGIN_LABEL: Record<string, string> = { manual: "Manual", email_ai: "From email", call_ai: "From call", rule: "Rule", sequence: "Sequence", agent: "Copilot", import: "Import" };

export function TasksPanel({ dealId, tasks, users, defaultAssignee, canCreate }: { dealId: string; tasks: TaskRow[]; users: UserLite[]; defaultAssignee: string; canCreate: boolean }) {
  const [adding, setAdding] = React.useState(false);
  const [showDone, setShowDone] = React.useState(false);
  const open = tasks.filter((t) => t.status === "open");
  const done = tasks.filter((t) => t.status === "done");
  const weOwe = open.filter((t) => t.owedBy !== "them");
  const theyOwe = open.filter((t) => t.owedBy === "them");
  return (
    <Panel
      title="Tasks & promises"
      count={open.length}
      action={
        canCreate ? (
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add
          </Button>
        ) : null
      }
    >
      {open.length === 0 ? <p className="text-sm text-muted">No open tasks.</p> : null}
      <TaskGroup title="We owe" tasks={weOwe} />
      <TaskGroup title="They owe" tasks={theyOwe} />
      {done.length ? (
        <button type="button" className="mt-2 text-xs text-muted hover:text-fg pointer-coarse:py-2" onClick={() => setShowDone((v) => !v)}>
          {showDone ? "Hide" : "Show"} {done.length} completed
        </button>
      ) : null}
      {showDone ? <TaskGroup title="" tasks={done} /> : null}
      {adding ? <AddTaskDialog dealId={dealId} users={users} defaultAssignee={defaultAssignee} onClose={() => setAdding(false)} /> : null}
    </Panel>
  );
}

function TaskGroup({ title, tasks }: { title: string; tasks: TaskRow[] }) {
  const [run, pending] = useRun();
  if (!tasks.length) return null;
  return (
    <div className="mb-2">
      {title ? <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">{title}</p> : null}
      <ul className="space-y-1.5">
        {tasks.map((t) => (
          <li key={t.id} id={`task-${t.id}`} className="flex gap-2 rounded-md transition-shadow">
            <button
              type="button"
              disabled={pending}
              aria-label={t.status === "done" ? `Reopen ${t.title}` : `Complete ${t.title}`}
              onClick={() => run(() => setTaskStatus({ taskId: t.id, status: t.status === "done" ? "open" : "done" }))}
              className={cn(
                "relative mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border after:absolute after:-inset-2.5 after:content-['']",
                t.status === "done" ? "border-white bg-white text-black" : "border-border-strong hover:border-white",
              )}
            >
              {t.status === "done" ? <Check className="size-3" /> : null}
            </button>
            <div className="min-w-0 flex-1">
              <p className={cn("break-words text-[13px]", t.status === "done" ? "text-muted line-through" : "text-body")}>{t.title}</p>
              <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
                {t.dueAt ? <span className="tabular">{fmtDate(t.dueAt, "d MMM")}</span> : null}
                {t.overdue ? <StatusBadge status="critical" label="Overdue" /> : null}
                {t.assigneeName ? <span>{t.assigneeName}</span> : null}
                <span>{ORIGIN_LABEL[t.origin] ?? t.origin}</span>
              </p>
              {t.evidence ? (
                <blockquote className="mt-1 border-l border-border-strong pl-2 text-[11px] italic text-secondary" title={t.evidenceSource ?? undefined}>
                  “{t.evidence}”
                </blockquote>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ───────────── Documents (CARD-6) ───────────── */

type Doc = { id: string; type: string; name: string; url: string | null; status: string; version: number; signedAt: string | null; expiresAt: string | null; expiringSoon: boolean };
const DOC_TYPES = [
  ["nda", "NDA"],
  ["contract", "Contract"],
  ["proposal", "Proposal"],
  ["pro_forma", "Pro forma"],
  ["deck", "Deck"],
  ["io", "IO"],
  ["invoice", "Invoice"],
  ["other", "Other"],
] as const;
const DOC_STATUS = ["draft", "sent", "signed", "expired"] as const;

export function DocumentsPanel({ dealId, documents, canEdit }: { dealId: string; documents: Doc[]; canEdit: boolean }) {
  const [adding, setAdding] = React.useState(false);
  const [run, pending] = useRun();
  return (
    <Panel
      title="Documents"
      count={documents.length}
      action={
        canEdit ? (
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <Plus /> Link
          </Button>
        ) : null
      }
    >
      {documents.length === 0 ? (
        <p className="text-sm text-muted">No NDA, contract or proposal linked yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {documents.map((d) => (
            <li key={d.id} className="flex items-center gap-2 py-2">
              <Badge className="w-16 justify-center uppercase">{DOC_TYPES.find((t) => t[0] === d.type)?.[1] ?? d.type}</Badge>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1 truncate text-[13px] text-fg">
                  {d.url ? (
                    <a href={d.url} target="_blank" rel="noopener noreferrer" className="truncate hover:underline">
                      {d.name}
                    </a>
                  ) : (
                    <span className="truncate">{d.name}</span>
                  )}
                  {d.url ? <ExternalLink className="size-3 shrink-0 text-muted" aria-hidden /> : null}
                  <span className="text-[11px] text-muted">v{d.version}</span>
                </p>
                <p className="flex items-center gap-2 text-[11px] text-muted">
                  {d.signedAt ? <span>Signed {fmtDate(d.signedAt)}</span> : null}
                  {d.expiresAt ? <span>Expires {fmtDate(d.expiresAt)}</span> : null}
                  {d.expiringSoon ? <StatusBadge status="warning" label="Expiring" /> : null}
                </p>
              </div>
              {canEdit ? (
                <NativeSelect
                  aria-label={`Status of ${d.name}`}
                  className="h-7 w-24 text-[11px] capitalize"
                  value={d.status}
                  disabled={pending}
                  onChange={(e) => run(() => updateDocumentStatus({ documentId: d.id, status: e.target.value as (typeof DOC_STATUS)[number] }))}
                >
                  {DOC_STATUS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                <Badge className="capitalize">{d.status}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding ? <AddDocumentDialog dealId={dealId} onClose={() => setAdding(false)} /> : null}
    </Panel>
  );
}

function AddDocumentDialog({ dealId, onClose }: { dealId: string; onClose: () => void }) {
  const [type, setType] = React.useState<(typeof DOC_TYPES)[number][0]>("nda");
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [status, setStatus] = React.useState<(typeof DOC_STATUS)[number]>("draft");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [run, pending] = useRun();
  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => addDocument({ dealId, type, name, url: url || undefined, status, expiresAt: expiresAt || undefined }), { success: "Document linked", onOk: onClose });
          }}
        >
          <DialogHeader>
            <DialogTitle>Link document</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="doc-type">Type</Label>
                <NativeSelect id="doc-type" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                  {DOC_TYPES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="doc-status">Status</Label>
                <NativeSelect id="doc-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="capitalize">
                  {DOC_STATUS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="doc-name">Name</Label>
              <Input id="doc-name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} placeholder="e.g. Mutual NDA — signed" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="doc-url">Link (Google Drive, DocuSign…)</Label>
              <Input id="doc-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="doc-exp">Expires</Label>
              <Input id="doc-exp" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="[color-scheme:dark]" />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || name.trim().length < 2}>
              {pending ? <Loader2 className="animate-spin" /> : null} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
