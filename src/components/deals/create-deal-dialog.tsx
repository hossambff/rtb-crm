"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, Check, Loader2, Plus, Search } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { createDeal, searchAccounts } from "@/lib/deals/actions";
import { fmtNumber } from "@/lib/format";
import { PRIORITY_LABELS, type PipelineDTO, type StageDTO, type UserLite } from "@/lib/deals/types";
import { cn } from "@/lib/utils";

export type CreatablePipelineLite = PipelineDTO & { stages: StageDTO[] };
type AccountHit = { id: string; name: string; domain: string | null; muu: number | null; category: string | null };

export function CreateDealButton(props: {
  pipelines: CreatablePipelineLite[];
  assignable: Record<string, UserLite[]>;
  currentUserId: string;
  defaultPipelineKey?: string;
  size?: "sm" | "md";
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  if (!props.pipelines.length) return null;
  return (
    <>
      <Button variant="primary" size={props.size ?? "md"} onClick={() => setOpen(true)}>
        <Plus /> {props.label ?? "New deal"}
      </Button>
      {open ? <CreateDealDialog {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function defaultDue() {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return d.toISOString().slice(0, 10);
}

function CreateDealDialog({
  pipelines,
  assignable,
  currentUserId,
  defaultPipelineKey,
  onClose,
}: {
  pipelines: CreatablePipelineLite[];
  assignable: Record<string, UserLite[]>;
  currentUserId: string;
  defaultPipelineKey?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const initial = pipelines.find((p) => p.key === defaultPipelineKey) ?? pipelines[0]!;
  const [pipelineId, setPipelineId] = React.useState(initial.id);
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? initial;
  const [stageId, setStageId] = React.useState(initial.stages[0]?.id ?? "");
  const [ownerId, setOwnerId] = React.useState(currentUserId);
  const [account, setAccount] = React.useState<AccountHit | null>(null);
  const [newAccount, setNewAccount] = React.useState<{ name: string; domain: string } | null>(null);
  const [name, setName] = React.useState("");
  const [muu, setMuu] = React.useState("");
  const [contractValue, setContractValue] = React.useState("");
  const [nextStep, setNextStep] = React.useState("");
  const [due, setDue] = React.useState(defaultDue);
  const [priority, setPriority] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});

  const owners = assignable[pipeline.key] ?? [];
  const stage = pipeline.stages.find((s) => s.id === stageId);

  const submit = () => {
    setErrors({});
    startTransition(async () => {
      const res = await createDeal({
        name: name.trim() || undefined,
        pipelineId: pipeline.id,
        stageId,
        accountId: account?.id,
        newAccount: newAccount ? { name: newAccount.name, domain: newAccount.domain || undefined } : undefined,
        ownerId,
        muu: pipeline.unit === "muu" && muu ? Number(muu.replace(/[,\s]/g, "")) : undefined,
        contractValue: pipeline.unit === "usd" && contractValue ? Number(contractValue.replace(/[$,\s]/g, "")) : undefined,
        nextStep,
        nextStepDueAt: due,
        priority: (priority || undefined) as never,
      });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success(res.data.linkedExisting ? `Deal created — linked to existing account ${res.data.accountName}` : "Deal created");
      onClose();
      router.push(`/deals/${res.data.id}`);
    });
  };

  return (
    <Dialog open onOpenChange={(o) => (!o && !pending ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New deal</DialogTitle>
            <DialogDescription>Every open deal needs a next step with a due date.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <AccountPicker
              account={account}
              newAccount={newAccount}
              onPick={(a) => {
                setAccount(a);
                setNewAccount(null);
                if (a?.muu && !muu) setMuu(String(a.muu));
              }}
              onNew={(n) => {
                setNewAccount(n);
                setAccount(null);
              }}
              error={errors.accountId?.[0]}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="cd-pipeline">Pipeline</Label>
                <NativeSelect
                  id="cd-pipeline"
                  value={pipelineId}
                  onChange={(e) => {
                    const p = pipelines.find((x) => x.id === e.target.value)!;
                    setPipelineId(p.id);
                    setStageId(p.stages[0]?.id ?? "");
                    if (!(assignable[p.key] ?? []).some((u) => u.id === ownerId)) setOwnerId(currentUserId);
                  }}
                >
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="cd-stage">Stage</Label>
                <NativeSelect id="cd-stage" value={stageId} onChange={(e) => setStageId(e.target.value)}>
                  {pipeline.stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {Math.round(s.probability * 100)}%
                    </option>
                  ))}
                </NativeSelect>
                {stage?.requiredFields.length ? <p className="text-[11px] text-muted">Requires: {stage.requiredFields.join(", ")}</p> : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor="cd-owner">Owner</Label>
                <NativeSelect id="cd-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} disabled={owners.length <= 1}>
                  {owners.length ? (
                    owners.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                        {u.id === currentUserId ? " (me)" : ""}
                      </option>
                    ))
                  ) : (
                    <option value={currentUserId}>Me</option>
                  )}
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="cd-priority">Priority</Label>
                <NativeSelect id="cd-priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="">None</option>
                  {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {pipeline.unit === "muu" ? (
                <div className="space-y-1">
                  <Label htmlFor="cd-muu">MUU</Label>
                  <Input id="cd-muu" inputMode="numeric" placeholder="e.g. 2,500,000" value={muu} onChange={(e) => setMuu(e.target.value)} />
                  <p className="text-[11px] text-muted">
                    Gross ≈ MUU × ${pipeline.usdPerMuu.toFixed(2)}/yr{muu && Number(muu.replace(/[,\s]/g, "")) ? ` = $${fmtNumber(Number(muu.replace(/[,\s]/g, "")) * pipeline.usdPerMuu, { compact: true })}` : ""}
                  </p>
                </div>
              ) : pipeline.unit === "usd" ? (
                <div className="space-y-1">
                  <Label htmlFor="cd-cv">Contract value ($)</Label>
                  <Input id="cd-cv" inputMode="decimal" placeholder="e.g. 25000" value={contractValue} onChange={(e) => setContractValue(e.target.value)} />
                </div>
              ) : null}
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="cd-name">Deal name (optional)</Label>
                <Input id="cd-name" placeholder={account?.name ?? newAccount?.name ?? "Defaults to the account name"} value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[1fr_160px]">
              <div className="space-y-1">
                <Label htmlFor="cd-next">Next step *</Label>
                <Input id="cd-next" value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="e.g. Intro call with publisher" required minLength={3} aria-invalid={!!errors.nextStep} />
                {errors.nextStep ? <p className="text-[11px] text-critical">{errors.nextStep[0]}</p> : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor="cd-due">Due *</Label>
                <Input id="cd-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} required />
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || (!account && !newAccount?.name) || nextStep.trim().length < 3 || !due}>
              {pending ? <Loader2 className="animate-spin" /> : null} Create deal
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AccountPicker({
  account,
  newAccount,
  onPick,
  onNew,
  error,
}: {
  account: AccountHit | null;
  newAccount: { name: string; domain: string } | null;
  onPick: (a: AccountHit | null) => void;
  onNew: (n: { name: string; domain: string } | null) => void;
  error?: string;
}) {
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<AccountHit[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (account || newAccount) return;
    const term = q.trim();
    if (term.length < 2) return;
    let alive = true;
    const t = setTimeout(async () => {
      setLoading(true);
      const r = await searchAccounts({ q: term });
      if (!alive) return;
      setLoading(false);
      setHits(r.ok ? r.data : []);
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, account, newAccount]);

  if (account) {
    return (
      <div className="space-y-1">
        <Label>Account</Label>
        <div className="flex items-center gap-2 rounded-md border border-border-strong bg-surface-1 px-3 py-2">
          <Check className="size-4 text-good" aria-hidden />
          <span className="text-sm text-fg">{account.name}</span>
          {account.domain ? <span className="text-xs text-muted">{account.domain}</span> : null}
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => onPick(null)}>
            Change
          </Button>
        </div>
      </div>
    );
  }
  if (newAccount) {
    return (
      <div className="space-y-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted">New account</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => onNew(null)}>
            Search instead
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="na-name">Name</Label>
            <Input id="na-name" value={newAccount.name} onChange={(e) => onNew({ ...newAccount, name: e.target.value })} required minLength={2} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="na-domain">Domain</Label>
            <Input id="na-domain" placeholder="example.com" value={newAccount.domain} onChange={(e) => onNew({ ...newAccount, domain: e.target.value })} />
          </div>
        </div>
        <p className="text-[11px] text-muted">If an account already exists for this domain, the deal links to it instead of creating a duplicate.</p>
      </div>
    );
  }
  const term = q.trim();
  const showHits = term.length >= 2;
  return (
    <div className="space-y-1">
      <Label htmlFor="acct-search">Account *</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input id="acct-search" className="pl-9" placeholder="Search by name or domain…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus autoComplete="off" />
        {loading ? <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted" aria-hidden /> : null}
      </div>
      {error ? <p className="text-[11px] text-critical">{error}</p> : null}
      {showHits ? (
        <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-surface-1" role="listbox" aria-label="Matching accounts">
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" role="option" aria-selected={false} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => onPick(h)}>
                <Building2 className="size-4 text-muted" aria-hidden />
                <span className="text-fg">{h.name}</span>
                <span className="text-xs text-muted">{h.domain}</span>
                {h.muu ? <span className="ml-auto text-xs text-muted tabular">{fmtNumber(h.muu, { compact: true })} MUU</span> : null}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-secondary hover:bg-surface-2", hits.length ? "border-t border-border" : "")}
              onClick={() => {
                const looksDomain = /\.[a-z]{2,}$/i.test(term);
                onNew({ name: looksDomain ? "" : term, domain: looksDomain ? term : "" });
              }}
            >
              <Plus className="size-4" aria-hidden /> Create account “{term}”
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

