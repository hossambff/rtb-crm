"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { checkAccountDuplicates, createAccount, type DuplicateMatch } from "@/lib/accounts/actions";
import { ACCOUNT_TYPES, LIFECYCLES, PRIORITIES } from "@/lib/accounts/constants";
import { STATUS_COLORS } from "@/lib/palette";

type Errors = Record<string, string[] | undefined>;

export function CreateAccountDialog({ categories, owners, currentUserId }: { categories: string[]; owners: { id: string; name: string }[]; currentUserId: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Errors>({});
  const [dups, setDups] = React.useState<DuplicateMatch[]>([]);
  const [form, setForm] = React.useState({ name: "", domain: "", type: "publisher", category: "", lifecycle: "target", priority: "", ownerId: currentUserId });
  const upd = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const seq = React.useRef(0);
  const check = async () => {
    if (form.name.trim().length < 2 && !form.domain.trim()) return;
    const mine = ++seq.current; // ignore stale responses (name blur then domain blur race)
    const res = await checkAccountDuplicates({ name: form.name || form.domain, domain: form.domain || null });
    if (res.ok && mine === seq.current) setDups(res.data);
  };

  const submit = async (force: boolean) => {
    setBusy(true);
    setErrors({});
    const res = await createAccount({
      name: form.name,
      domain: form.domain || null,
      type: form.type as never,
      category: form.category || null,
      lifecycle: form.lifecycle as never,
      priority: (form.priority || null) as never,
      ownerId: form.ownerId || null,
      force,
    });
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    if (!res.data.created) {
      setDups(res.data.duplicates);
      return;
    }
    toast.success("Account created");
    setOpen(false);
    router.push(`/accounts/${res.data.id}`);
  };

  const domainDup = dups.find((d) => d.reason === "domain");

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setDups([]);
          setErrors({});
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Plus /> New account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>New account</DialogTitle>
            <DialogDescription>Domains are normalized and must be unique. We check for duplicates as you type.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" error={errors.name?.[0]} className="sm:col-span-2">
                <Input id="acc-name" value={form.name} onChange={upd("name")} onBlur={check} required autoFocus />
              </Field>
              <Field label="Domain" error={errors.domain?.[0]} className="sm:col-span-2">
                <Input id="acc-domain" value={form.domain} onChange={upd("domain")} onBlur={check} placeholder="example.com" />
              </Field>
              <Field label="Type">
                <NativeSelect id="acc-type" value={form.type} onChange={upd("type")}>
                  {ACCOUNT_TYPES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Category">
                <Input id="acc-category" list="acc-categories" value={form.category} onChange={upd("category")} />
                <datalist id="acc-categories">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </Field>
              <Field label="Lifecycle">
                <NativeSelect id="acc-lifecycle" value={form.lifecycle} onChange={upd("lifecycle")}>
                  {LIFECYCLES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Priority">
                <NativeSelect id="acc-priority" value={form.priority} onChange={upd("priority")}>
                  <option value="">—</option>
                  {PRIORITIES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Owner" className="sm:col-span-2">
                <NativeSelect id="acc-owner" value={form.ownerId} onChange={upd("ownerId")}>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            {dups.length ? (
              <div className="rounded-md border border-border-strong bg-surface-1 p-3" role="status">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-fg">
                  <AlertTriangle className="size-3.5" style={{ color: STATUS_COLORS.warning }} aria-hidden />
                  {domainDup ? "This domain already belongs to an account" : "Possible duplicates"}
                </p>
                <ul className="space-y-1.5">
                  {dups.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate">
                        <span className="text-fg">{d.name}</span> <span className="text-xs text-muted">{d.hidden ? "" : (d.domain ?? "no domain")}</span>
                      </span>
                      {d.hidden ? null : (
                        <Button asChild size="sm" variant="secondary">
                          <Link href={`/accounts/${d.id}`}>Open existing</Link>
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            {dups.length && !domainDup ? (
              <Button type="button" variant="secondary" disabled={busy} onClick={() => void submit(true)}>
                Create anyway
              </Button>
            ) : null}
            <Button type="submit" variant="primary" disabled={busy || !!domainDup}>
              {busy ? "Creating…" : "Create account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Label + control + field error. The label targets the first child element's id. */
export function Field({ label, error, className, children }: { label: string; error?: string; className?: string; children: React.ReactNode }) {
  const first = React.Children.toArray(children).find((c): c is React.ReactElement<{ id?: string }> => React.isValidElement(c));
  const id = first?.props.id;
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-critical">{error}</p> : null}
    </div>
  );
}
