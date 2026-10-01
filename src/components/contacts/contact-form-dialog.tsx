"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Field } from "@/components/accounts/create-account-dialog";
import { AccountPicker } from "@/components/accounts/merge-account-dialog";
import { createContact, updateContact } from "@/lib/contacts/actions";
import { SENIORITIES, inferSeniority } from "@/lib/contacts/seniority";

export type ContactFormValue = {
  id?: string;
  fullName: string;
  account: { id: string; name: string } | null;
  title: string | null;
  seniority: string | null;
  email: string | null;
  altEmails: string[];
  phone: string | null;
  linkedinUrl: string | null;
  relationshipOwnerId: string | null;
  status: string;
  doNotContact: boolean;
  notes: string | null;
};

const EMPTY: ContactFormValue = { fullName: "", account: null, title: null, seniority: null, email: null, altEmails: [], phone: null, linkedinUrl: null, relationshipOwnerId: null, status: "active", doNotContact: false, notes: null };

export function ContactFormDialog({
  initial,
  owners,
  trigger = "create",
  onSaved,
}: {
  initial?: Partial<ContactFormValue>;
  owners: { id: string; name: string }[];
  trigger?: "create" | "edit" | "create-small";
  onSaved?: (id: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});
  const start = React.useMemo(() => ({ ...EMPTY, ...initial }), [initial]);
  const [f, setF] = React.useState<ContactFormValue>(start);
  const [alt, setAlt] = React.useState("");
  const editing = !!start.id;
  const upd = (k: keyof ContactFormValue) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((x) => ({ ...x, [k]: e.target.value }));

  const addAlt = () => {
    const v = alt.trim().toLowerCase();
    if (v && !f.altEmails.includes(v)) setF((x) => ({ ...x, altEmails: [...x.altEmails, v] }));
    setAlt("");
  };

  const submit = async () => {
    setBusy(true);
    setErrors({});
    const payload = {
      fullName: f.fullName,
      accountId: f.account?.id ?? null,
      title: f.title || null,
      seniority: (f.seniority || null) as never,
      email: f.email || null,
      altEmails: f.altEmails,
      phone: f.phone || null,
      linkedinUrl: f.linkedinUrl || null,
      relationshipOwnerId: f.relationshipOwnerId || null,
      status: f.status as "active" | "left_company",
      doNotContact: f.doNotContact,
      notes: f.notes || null,
    };
    const res = editing ? await updateContact({ id: start.id!, ...payload }) : await createContact(payload);
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    toast.success(editing ? "Contact saved" : "Contact created");
    setOpen(false);
    if (onSaved) onSaved(res.data.id);
    else if (!editing) router.push(`/contacts/${res.data.id}`);
    router.refresh();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setF(start);
          setErrors({});
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger === "edit" ? (
          <Button variant="secondary" size="sm">
            <Pencil /> Edit
          </Button>
        ) : trigger === "create-small" ? (
          <Button variant="secondary" size="sm">
            <Plus /> Add contact
          </Button>
        ) : (
          <Button variant="primary" size="sm">
            <Plus /> New contact
          </Button>
        )}
      </DialogTrigger>
      <DialogContent side="right">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? "Edit contact" : "New contact"}</DialogTitle>
            <DialogDescription>Relationship owner is who holds the relationship (e.g. “Will POC”), separate from any deal owner.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Full name" error={errors.fullName?.[0]} className="sm:col-span-2">
                <Input id="c-name" value={f.fullName} onChange={upd("fullName")} required autoFocus={!editing} />
              </Field>
              <Field label="Account" className="sm:col-span-2">
                <AccountPicker id="c-account" value={f.account} onChange={(a) => setF((x) => ({ ...x, account: a }))} />
              </Field>
              <Field label="Title">
                <Input
                  id="c-title"
                  value={f.title ?? ""}
                  onChange={(e) => setF((x) => ({ ...x, title: e.target.value, seniority: x.seniority || inferSeniority(e.target.value) }))}
                />
              </Field>
              <Field label="Seniority">
                <NativeSelect id="c-seniority" value={f.seniority ?? ""} onChange={upd("seniority")}>
                  <option value="">—</option>
                  {SENIORITIES.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Email" error={errors.email?.[0]} className="sm:col-span-2">
                <Input id="c-email" type="email" value={f.email ?? ""} onChange={upd("email")} />
              </Field>
              <Field label="Other emails" error={errors.altEmails?.[0]} className="sm:col-span-2">
                <div id="c-alt" className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface-3/40 p-1.5">
                  {f.altEmails.map((e) => (
                    <span key={e} className="inline-flex items-center gap-1 rounded border border-border-strong px-1.5 py-0.5 text-xs text-secondary">
                      {e}
                      <button type="button" aria-label={`Remove ${e}`} className="relative after:absolute after:-inset-2 after:content-[''] text-muted hover:text-fg" onClick={() => setF((x) => ({ ...x, altEmails: x.altEmails.filter((y) => y !== e) }))}>
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    aria-label="Add another email"
                    type="email"
                    value={alt}
                    onChange={(e) => setAlt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        addAlt();
                      }
                    }}
                    onBlur={addAlt}
                    placeholder="add email…"
                    className="min-w-32 flex-1 bg-transparent px-1 text-sm text-body placeholder:text-muted focus:outline-none"
                  />
                </div>
              </Field>
              <Field label="Phone">
                <Input id="c-phone" type="tel" value={f.phone ?? ""} onChange={upd("phone")} />
              </Field>
              <Field label="LinkedIn" error={errors.linkedinUrl?.[0]}>
                <Input id="c-li" value={f.linkedinUrl ?? ""} onChange={upd("linkedinUrl")} placeholder="https://linkedin.com/in/…" />
              </Field>
              <Field label="Relationship owner">
                <NativeSelect id="c-rel" value={f.relationshipOwnerId ?? ""} onChange={upd("relationshipOwnerId")}>
                  <option value="">—</option>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Status">
                <NativeSelect id="c-status" value={f.status} onChange={upd("status")}>
                  <option value="active">Active</option>
                  <option value="left_company">Left company</option>
                </NativeSelect>
              </Field>
              <label className="flex items-center gap-2 text-sm text-body sm:col-span-2">
                <input type="checkbox" checked={f.doNotContact} onChange={(e) => setF((x) => ({ ...x, doNotContact: e.target.checked }))} className="size-4 accent-white" />
                Do not contact — sequences and the Copilot will skip this person
              </label>
              <Field label="Notes" className="sm:col-span-2">
                <Textarea id="c-notes" value={f.notes ?? ""} onChange={upd("notes")} rows={3} />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter className="sticky bottom-0 bg-surface-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create contact"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
