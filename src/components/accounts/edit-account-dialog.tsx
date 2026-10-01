"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { updateAccount } from "@/lib/accounts/actions";
import { ACCOUNT_TYPES, LIFECYCLES, PRIORITIES, R100_TYPES } from "@/lib/accounts/constants";
import { Field } from "./create-account-dialog";
import { AccountPicker } from "./merge-account-dialog";

export type EditableAccount = {
  id: string;
  name: string;
  domain: string | null;
  type: string;
  category: string | null;
  subcategory: string | null;
  lifecycle: string;
  priority: string | null;
  ownerId: string | null;
  parentId: string | null;
  parentName: string | null;
  country: string | null;
  region: string | null;
  language: string | null;
  ownership: string | null;
  league: string | null;
  team: string | null;
  ticker: string | null;
  tokenName: string | null;
  isB2c: boolean | null;
  marketCapUsd: number | null;
  pressPage: string | null;
  prEmail: string | null;
  linkedinUrl: string | null;
  techStack: string[];
  notes: string | null;
  doNotContact: boolean;
};

export function EditAccountDialog({ account, owners, categories, canAssign }: { account: EditableAccount; owners: { id: string; name: string }[]; categories: string[]; canAssign: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});
  const [f, setF] = React.useState(account);
  const [tech, setTech] = React.useState("");
  const [parent, setParent] = React.useState<{ id: string; name: string } | null>(account.parentId ? { id: account.parentId, name: account.parentName ?? "Parent" } : null);
  const upd = (k: keyof EditableAccount) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const isCompany = R100_TYPES.includes(f.type);

  const addTech = () => {
    const t = tech.trim();
    if (t && !f.techStack.includes(t)) setF((x) => ({ ...x, techStack: [...x.techStack, t] }));
    setTech("");
  };

  const submit = async () => {
    setBusy(true);
    setErrors({});
    const mc = String(f.marketCapUsd ?? "").replace(/[$,\s]/g, "");
    const res = await updateAccount({
      id: f.id,
      name: f.name,
      domain: f.domain || null,
      type: f.type as never,
      category: f.category || null,
      subcategory: f.subcategory || null,
      lifecycle: f.lifecycle as never,
      priority: (f.priority || null) as never,
      ownerId: f.ownerId || null,
      parentId: parent?.id ?? null,
      country: f.country || null,
      region: f.region || null,
      language: f.language || null,
      ownership: f.ownership || null,
      league: f.league || null,
      team: f.team || null,
      ticker: f.ticker || null,
      tokenName: f.tokenName || null,
      isB2c: f.isB2c,
      marketCapUsd: mc ? Math.round(Number(mc)) || null : null,
      pressPage: f.pressPage || null,
      prEmail: f.prEmail || null,
      linkedinUrl: f.linkedinUrl || null,
      techStack: f.techStack,
      notes: f.notes || null,
      doNotContact: f.doNotContact,
    });
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    toast.success("Account saved");
    setOpen(false);
    router.refresh();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setF(account);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          <Pencil /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent side="right">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit account</DialogTitle>
            <DialogDescription>Changes are audit-logged. Domains must be unique — merge duplicates instead of re-using a domain.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Section title="Identity">
              <Field label="Name" error={errors.name?.[0]} className="sm:col-span-2">
                <Input id="e-name" value={f.name} onChange={upd("name")} required />
              </Field>
              <Field label="Domain" error={errors.domain?.[0]}>
                <Input id="e-domain" value={f.domain ?? ""} onChange={upd("domain")} placeholder="example.com" />
              </Field>
              <Field label="Type">
                <NativeSelect id="e-type" value={f.type} onChange={upd("type")}>
                  {ACCOUNT_TYPES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Category">
                <Input id="e-category" list="e-categories" value={f.category ?? ""} onChange={upd("category")} />
                <datalist id="e-categories">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </Field>
              <Field label="Subcategory">
                <Input id="e-sub" value={f.subcategory ?? ""} onChange={upd("subcategory")} />
              </Field>
              <Field label="Parent group" className="sm:col-span-2">
                <AccountPicker id="e-parent" excludeId={f.id} value={parent} onChange={setParent} placeholder="Search parent group…" />
              </Field>
            </Section>
            <Section title="Pipeline">
              <Field label="Lifecycle">
                <NativeSelect id="e-life" value={f.lifecycle} onChange={upd("lifecycle")}>
                  {LIFECYCLES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Priority">
                <NativeSelect id="e-prio" value={f.priority ?? ""} onChange={upd("priority")}>
                  <option value="">—</option>
                  {PRIORITIES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Owner" className="sm:col-span-2">
                <NativeSelect id="e-owner" value={f.ownerId ?? ""} onChange={upd("ownerId")} disabled={!canAssign}>
                  <option value="">Unassigned</option>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </Section>
            <Section title="Market">
              <Field label="Country">
                <Input id="e-country" value={f.country ?? ""} onChange={upd("country")} />
              </Field>
              <Field label="Region">
                <Input id="e-region" value={f.region ?? ""} onChange={upd("region")} />
              </Field>
              <Field label="Language">
                <Input id="e-lang" value={f.language ?? ""} onChange={upd("language")} placeholder="en, es…" />
              </Field>
              <Field label="Ownership">
                <Input id="e-ownership" value={f.ownership ?? ""} onChange={upd("ownership")} placeholder="Independent / group name" />
              </Field>
              <Field label="League">
                <Input id="e-league" value={f.league ?? ""} onChange={upd("league")} />
              </Field>
              <Field label="Team">
                <Input id="e-team" value={f.team ?? ""} onChange={upd("team")} />
              </Field>
            </Section>
            {isCompany ? (
              <Section title="Roundtable 100 company">
                <Field label="Ticker" error={errors.ticker?.[0]}>
                  <Input id="e-ticker" value={f.ticker ?? ""} onChange={upd("ticker")} />
                </Field>
                <Field label="Token name">
                  <Input id="e-token" value={f.tokenName ?? ""} onChange={upd("tokenName")} placeholder="HIVE100" />
                </Field>
                <Field label="B2C">
                  <NativeSelect
                    id="e-b2c"
                    value={f.isB2c == null ? "" : f.isB2c ? "yes" : "no"}
                    onChange={(e) => setF((x) => ({ ...x, isB2c: e.target.value === "" ? null : e.target.value === "yes" }))}
                  >
                    <option value="">—</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </NativeSelect>
                </Field>
                <Field label="Market cap (USD)">
                  <Input id="e-mcap" inputMode="numeric" value={f.marketCapUsd ?? ""} onChange={upd("marketCapUsd")} />
                </Field>
                <Field label="Press page" className="sm:col-span-2">
                  <Input id="e-press" value={f.pressPage ?? ""} onChange={upd("pressPage")} />
                </Field>
                <Field label="PR email" error={errors.prEmail?.[0]} className="sm:col-span-2">
                  <Input id="e-pr" type="email" value={f.prEmail ?? ""} onChange={upd("prEmail")} />
                </Field>
              </Section>
            ) : null}
            <Section title="Other">
              <Field label="LinkedIn" className="sm:col-span-2">
                <Input id="e-li" value={f.linkedinUrl ?? ""} onChange={upd("linkedinUrl")} />
              </Field>
              <Field label="Tech stack" className="sm:col-span-2">
                <div id="e-tech" className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface-3/40 p-1.5">
                  {f.techStack.map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 rounded border border-border-strong px-1.5 py-0.5 text-xs text-secondary">
                      {t}
                      <button type="button" aria-label={`Remove ${t}`} className="relative after:absolute after:-inset-2 after:content-[''] text-muted hover:text-fg" onClick={() => setF((x) => ({ ...x, techStack: x.techStack.filter((y) => y !== t) }))}>
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    aria-label="Add technology"
                    value={tech}
                    onChange={(e) => setTech(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        addTech();
                      }
                    }}
                    onBlur={addTech}
                    placeholder="WordPress, GAM…"
                    className="min-w-24 flex-1 bg-transparent px-1 text-sm text-body placeholder:text-muted focus:outline-none"
                  />
                </div>
              </Field>
              <label className="flex items-center gap-2 text-sm text-body sm:col-span-2">
                <input type="checkbox" checked={f.doNotContact} onChange={(e) => setF((x) => ({ ...x, doNotContact: e.target.checked }))} className="size-4 accent-white" />
                Do not contact (honored by sequences and the agent)
              </label>
              <Field label="Notes" className="sm:col-span-2">
                <Textarea id="e-notes" value={f.notes ?? ""} onChange={upd("notes")} rows={4} />
              </Field>
            </Section>
          </DialogBody>
          <DialogFooter className="sticky bottom-0 bg-surface-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}
