"use client";
import * as React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/misc";
import { AdminSection, AdminTable, ConfirmButton, Field, Td, Th, useAction } from "@/components/admin/form";
import { findClaimHits } from "@/lib/claims-core";
import { fmtDate } from "@/lib/format";
import { CLAIM_STATUSES, regexError } from "@/lib/admin/config-schemas";
import { deleteClaim, saveClaim } from "@/lib/admin/claims-actions";
import type { AdminClaim } from "@/lib/admin/config-queries";

type Status = (typeof CLAIM_STATUSES)[number];
type ProductOpt = { id: string; name: string; family: string };
const STATUS_META: Record<Status, { status: "good" | "warning" | "critical"; label: string }> = {
  approved: { status: "good", label: "Approved" },
  restricted: { status: "warning", label: "Restricted" },
  banned: { status: "critical", label: "Banned" },
};

export function ClaimStatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status as Status];
  return meta ? <StatusBadge status={meta.status} label={meta.label} /> : <Badge>{status}</Badge>;
}

export function ClaimsEditor({ claims, products }: { claims: AdminClaim[]; products: ProductOpt[] }) {
  const [editing, setEditing] = React.useState<AdminClaim | "new" | null>(null);
  const del = useAction(deleteClaim, { success: "Claim deleted" });
  const productName = new Map(products.map((p) => [p.id, p.name]));
  return (
    <>
      <AdminSection
        title="Claims library"
        description="Approved, restricted and banned statements. Drafts are checked against patterns (case-insensitive regex) before sending."
        actions={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus aria-hidden /> New claim
          </Button>
        }
      >
        {claims.length === 0 ? (
          <EmptyState title="No claims yet" description="Add banned or restricted claims so drafts get flagged with an approved alternative." />
        ) : (
          <AdminTable cards className="[&_table]:min-w-[900px]">
            <thead>
              <tr>
                <Th>Status</Th>
                <Th>Claim</Th>
                <Th>Pattern</Th>
                <Th>Approved alternative</Th>
                <Th>Product</Th>
                <Th>Expires</Th>
                <Th>Approver</Th>
                <Th className="w-20">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {claims.map((c) => {
                const err = c.pattern ? regexError(c.pattern) : null;
                return (
                  <tr key={c.id}>
                    <Td label="Status">
                      <ClaimStatusBadge status={c.status} />
                    </Td>
                    <Td label="Claim" primary className="text-fg md:max-w-64">{c.text}</Td>
                    <Td label="Pattern" className="md:max-w-56">
                      {c.pattern ? <code className="break-all font-mono text-xs text-secondary">{c.pattern}</code> : <span className="text-xs text-muted">Text match</span>}
                      {err ? (
                        <p className="mt-1 text-xs text-secondary" role="alert">
                          <span aria-hidden className="mr-1 text-critical">✕</span>Invalid regex: {err}
                        </p>
                      ) : null}
                    </Td>
                    <Td label="Approved alternative" className="text-xs md:max-w-64 text-secondary">{c.approvedAlternative ?? "—"}</Td>
                    <Td label="Product" className="text-xs">{c.productId ? (productName.get(c.productId) ?? "Unknown") : "—"}</Td>
                    <Td label="Expires" className="whitespace-nowrap text-xs tabular">
                      {fmtDate(c.expiresAt)}
                      {c.expired ? <Badge className="ml-1">Expired</Badge> : null}
                    </Td>
                    <Td label="Approver" className="text-xs text-muted">{c.approverName ?? "—"}</Td>
                    <Td actions>
                      <div className="flex justify-end gap-0.5">
                        <Button size="icon-sm" variant="ghost" aria-label={`Edit claim ${c.text}`} onClick={() => setEditing(c)}>
                          <Pencil aria-hidden />
                        </Button>
                        <ConfirmButton
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Delete claim ${c.text}`}
                          title="Delete this claim?"
                          description={`"${c.text}" will no longer be checked in drafts. This is audit-logged.`}
                          confirmLabel="Delete claim"
                          onConfirm={() => del.run({ id: c.id })}
                        >
                          <Trash2 aria-hidden />
                        </ConfirmButton>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </AdminTable>
        )}
        <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent className="max-w-2xl">
            {editing ? <ClaimForm claim={editing === "new" ? null : editing} products={products} onDone={() => setEditing(null)} /> : null}
          </DialogContent>
        </Dialog>
      </AdminSection>
      <ClaimTester claims={claims} />
    </>
  );
}

function ClaimTester({ claims }: { claims: AdminClaim[] }) {
  const id = React.useId();
  const [text, setText] = React.useState("");
  const hits = React.useMemo(() => (text.trim() ? findClaimHits(text, claims) : []), [text, claims]);
  return (
    <AdminSection title="Tester" description="Paste a draft to see which claims would be flagged. Runs locally in your browser.">
      <Field label="Draft text" htmlFor={`${id}-draft`}>
        <Textarea id={`${id}-draft`} rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Publishers get paid in 8 seconds…" />
      </Field>
      <div className="mt-4" aria-live="polite">
        {!text.trim() ? (
          <p className="text-sm text-muted">Results appear as you type.</p>
        ) : hits.length === 0 ? (
          <p className="text-sm text-secondary">
            <StatusBadge status="good" label="No banned or restricted claims found" />
          </p>
        ) : (
          <ul className="space-y-2">
            {hits.map((h) => (
              <li key={h.claimId} className="rounded-md border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <ClaimStatusBadge status={h.status} />
                  <span className="text-fg">{h.claim}</span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  Matched: <mark className="rounded bg-surface-3 px-1 text-fg">{h.match}</mark>
                </p>
                {h.alternative ? <p className="mt-1 text-xs text-secondary">Use instead: {h.alternative}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminSection>
  );
}

function ClaimForm({ claim, products, onDone }: { claim: AdminClaim | null; products: ProductOpt[]; onDone: () => void }) {
  const id = React.useId();
  const [text, setText] = React.useState(claim?.text ?? "");
  const [pattern, setPattern] = React.useState(claim?.pattern ?? "");
  const [status, setStatus] = React.useState<Status>((claim?.status as Status) ?? "restricted");
  const [alt, setAlt] = React.useState(claim?.approvedAlternative ?? "");
  const [evidence, setEvidence] = React.useState(claim?.evidence ?? "");
  const [productId, setProductId] = React.useState(claim?.productId ?? "");
  const [expiresAt, setExpiresAt] = React.useState(claim?.expiresAt ? new Date(claim.expiresAt).toISOString().slice(0, 10) : "");
  const { run, pending, errors } = useAction(saveClaim, { success: claim ? "Claim saved" : "Claim added", onSuccess: onDone });
  const localRegexErr = pattern.trim() ? regexError(pattern.trim()) : null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run({ id: claim?.id, text, pattern, status, approvedAlternative: alt, evidence, productId: productId || null, expiresAt: expiresAt || null });
      }}
    >
      <DialogHeader>
        <DialogTitle>{claim ? "Edit claim" : "New claim"}</DialogTitle>
        <DialogDescription>Changing the status records you as the approver.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Field label="Claim" htmlFor={`${id}-text`} error={errors.text}>
          <Input id={`${id}-text`} value={text} onChange={(e) => setText(e.target.value)} required autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Status" htmlFor={`${id}-status`} error={errors.status}>
            <NativeSelect id={`${id}-status`} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
              {CLAIM_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Product" htmlFor={`${id}-product`} error={errors.productId}>
            <NativeSelect id={`${id}-product`} value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">None</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.family} · {p.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Field
          label="Detection pattern (regex)"
          htmlFor={`${id}-pattern`}
          error={localRegexErr ? `Invalid regex: ${localRegexErr}` : errors.pattern}
          hint="Case-insensitive. Leave empty to match the claim text literally."
        >
          <Input id={`${id}-pattern`} className="font-mono text-xs" spellCheck={false} value={pattern} onChange={(e) => setPattern(e.target.value)} aria-invalid={Boolean(localRegexErr)} />
        </Field>
        <Field label="Approved alternative" htmlFor={`${id}-alt`} error={errors.approvedAlternative}>
          <Textarea id={`${id}-alt`} rows={2} value={alt} onChange={(e) => setAlt(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <Field label="Evidence" htmlFor={`${id}-evidence`} error={errors.evidence}>
            <Textarea id={`${id}-evidence`} rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          </Field>
          <Field label="Expires" htmlFor={`${id}-exp`} error={errors.expiresAt}>
            <Input id={`${id}-exp`} type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </Field>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending || Boolean(localRegexErr)}>
          {claim ? "Save claim" : "Add claim"}
        </Button>
      </DialogFooter>
    </form>
  );
}
