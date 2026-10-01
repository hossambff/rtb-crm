"use client";
import * as React from "react";
import { onRadioGroupKeyDown } from "./radio-keys";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, Check, ChevronDown, Loader2, Plus, Search } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { createDeal, searchAccounts } from "@/lib/deals/actions";
import { gateFieldMeta } from "@/lib/deals/gates";
import { fmtNumber } from "@/lib/format";
import { PRIORITY_LABELS, type PipelineDTO, type StageDTO, type UserLite } from "@/lib/deals/types";
import { cn } from "@/lib/utils";
import { ColorTick } from "@/components/ui/badge";
import { defaultNextStepDue } from "@/lib/deals/create-core";

export type CreatablePipelineLite = PipelineDTO & { stages: StageDTO[] };
type AccountHit = { id: string; name: string; domain: string | null; muu: number | null; category: string | null };

export function CreateDealButton(props: {
  pipelines: CreatablePipelineLite[];
  assignable: Record<string, UserLite[]>;
  currentUserId: string;
  defaultPipelineKey?: string;
  size?: "sm" | "md";
  label?: string;
  sources?: string[];
  /** Open the dialog on mount — and again whenever it flips to true (e.g. ⌘K "Create deal" → /deals?create=1). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(Boolean(props.defaultOpen));
  // render-time state adjustment (no effect): a rising defaultOpen opens the dialog
  const [prevDefaultOpen, setPrevDefaultOpen] = React.useState(Boolean(props.defaultOpen));
  if (Boolean(props.defaultOpen) !== prevDefaultOpen) {
    setPrevDefaultOpen(Boolean(props.defaultOpen));
    if (props.defaultOpen) setOpen(true);
  }
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

function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "America/New_York";
  }
}

const num = (v: string) => Number(v.replace(/[$,_\s]/g, ""));

/**
 * Four-field deal creation (V2 §B4): account, motion, value, next step (+ due, default +3 business days).
 * Everything else lives under "More details"; after create the server auto-fills priority, expected close, primary
 * contact and source (marked "auto" on the deal, each undoable).
 */
function CreateDealDialog({
  pipelines,
  assignable,
  currentUserId,
  defaultPipelineKey,
  sources,
  onClose,
}: {
  pipelines: CreatablePipelineLite[];
  assignable: Record<string, UserLite[]>;
  currentUserId: string;
  defaultPipelineKey?: string;
  sources?: string[];
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
  const [due, setDue] = React.useState(() => defaultNextStepDue(new Date(), browserTz()));
  const [priority, setPriority] = React.useState("");
  const [source, setSource] = React.useState("");
  const [closeDate, setCloseDate] = React.useState("");
  const [more, setMore] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});

  const owners = assignable[pipeline.key] ?? [];
  const stage = pipeline.stages.find((s) => s.id === stageId);
  // QA-07: evaluate the stage gate before submitting (the server re-checks before writing anything).
  const createFilled = new Set<string>(["nextStep", "nextStepDueAt"]);
  if (pipeline.unit === "muu" && (muu.trim() || account?.muu)) createFilled.add("muu");
  if (pipeline.unit === "usd" && contractValue.trim()) createFilled.add("contractValueCents");
  if (closeDate) createFilled.add("expectedCloseDate");
  const fillable = new Set<string>(pipeline.unit === "muu" ? ["muu"] : pipeline.unit === "usd" ? ["contractValueCents"] : []);
  const gateMissing = stage ? stage.requiredFields.filter((k) => !createFilled.has(k)) : [];
  const gateBlocked = gateMissing.some((k) => !fillable.has(k));
  const valueNum = pipeline.unit === "muu" ? num(muu) : pipeline.unit === "usd" ? num(contractValue) : 0;
  const valueInvalid = (pipeline.unit === "muu" ? muu : pipeline.unit === "usd" ? contractValue : "").trim() !== "" && !(Number.isFinite(valueNum) && valueNum >= 0);
  const hasAccount = !!account || !!newAccount?.name.trim() || !!newAccount?.domain.trim();
  const canSubmit = !pending && hasAccount && !gateMissing.length && !valueInvalid && nextStep.trim().length >= 3 && !!due;
  // QA MIN-11: say why "Create deal" is disabled instead of leaving the user guessing.
  const blockers = [
    !hasAccount ? "pick or add an account" : null,
    nextStep.trim().length < 3 ? "add a next step" : null,
    !due ? "set when it's due" : null,
    valueInvalid ? "fix the value" : null,
  ].filter(Boolean) as string[];

  const submit = () => {
    setErrors({});
    startTransition(async () => {
      const acctName = newAccount ? newAccount.name.trim() || newAccount.domain.trim().replace(/^www\./, "").split(".")[0] || "" : "";
      const res = await createDeal({
        name: name.trim() || undefined,
        pipelineId: pipeline.id,
        stageId: stageId || undefined,
        accountId: account?.id,
        newAccount: newAccount ? { name: acctName.length >= 2 ? acctName.charAt(0).toUpperCase() + acctName.slice(1) : acctName, domain: newAccount.domain.trim() || undefined } : undefined,
        ownerId,
        muu: pipeline.unit === "muu" && muu.trim() ? Math.round(valueNum) : undefined,
        contractValue: pipeline.unit === "usd" && contractValue.trim() ? valueNum : undefined,
        nextStep: nextStep.trim(),
        nextStepDueAt: due,
        priority: (priority || undefined) as never,
        source: source || undefined,
        expectedCloseDate: closeDate || undefined,
      });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        if (res.fieldErrors && Object.keys(res.fieldErrors).some((k) => ["priority", "source", "expectedCloseDate", "name", "stageId", "ownerId"].includes(k))) setMore(true);
        toast.error(res.error);
        return;
      }
      const auto = res.data.autofilled.length ? ` · auto-filled ${res.data.autofilled.join(" · ")}` : "";
      toast.success(res.data.linkedExisting ? `Deal created — linked to existing account ${res.data.accountName}${auto}` : `Deal created${auto}`);
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
            if (canSubmit) submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New deal</DialogTitle>
            <DialogDescription>Four things. We fill in the rest — priority, close date, primary contact and source — and mark it “auto”.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Step n={1} label="Account">
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
            </Step>

            <Step n={2} label="Motion">
              <div role="radiogroup" aria-label="Motion" onKeyDown={onRadioGroupKeyDown} className="flex flex-wrap gap-1.5">
                {pipelines.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={p.id === pipelineId}
                    tabIndex={p.id === pipelineId ? 0 : -1}
                    onClick={() => {
                      setPipelineId(p.id);
                      setStageId(p.stages[0]?.id ?? "");
                      if (!(assignable[p.key] ?? []).some((u) => u.id === ownerId)) setOwnerId(currentUserId);
                    }}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] transition-colors duration-150",
                      p.id === pipelineId ? "border-white bg-surface-3 text-fg" : "border-border text-secondary hover:border-border-strong hover:text-fg",
                    )}
                  >
                    <ColorTick color={p.color} /> {p.name}
                  </button>
                ))}
              </div>
            </Step>

            <Step n={3} label={pipeline.unit === "muu" ? "Value · MUU" : pipeline.unit === "usd" ? "Value · contract $" : "Value"}>
              {pipeline.unit === "muu" ? (
                <div className="space-y-1">
                  <Input id="cd-muu" aria-label="Monthly unique users (MUU)" inputMode="numeric" placeholder="e.g. 2,500,000" value={muu} onChange={(e) => setMuu(e.target.value)} aria-invalid={valueInvalid} />
                  <p className="text-[11px] text-muted tabular">
                    {valueNum > 0 && !valueInvalid ? `≈ $${fmtNumber(valueNum * pipeline.usdPerMuu, { compact: true })} gross / yr at $${pipeline.usdPerMuu.toFixed(2)} per MUU` : "Monthly unique users. Leave empty if unknown — the account's MUU is used when there is one."}
                  </p>
                </div>
              ) : pipeline.unit === "usd" ? (
                <Input id="cd-cv" aria-label="Contract value in dollars" inputMode="decimal" placeholder="e.g. 25,000" value={contractValue} onChange={(e) => setContractValue(e.target.value)} aria-invalid={valueInvalid} />
              ) : (
                <p className="text-[12px] text-muted">{pipeline.name} counts activations — no value to enter.</p>
              )}
              {valueInvalid ? <p className="text-[11px] text-critical">Enter a number.</p> : null}
            </Step>

            <Step n={4} label="Next step">
              <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
                <Input id="cd-next" aria-label="Next step" value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="e.g. Intro call with the publisher" required minLength={3} maxLength={500} aria-invalid={!!errors.nextStep} />
                <Input id="cd-due" aria-label="Next step due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} required className="[color-scheme:dark]" />
              </div>
              {errors.nextStep ? <p className="text-[11px] text-critical">{errors.nextStep[0]}</p> : null}
            </Step>

            <div className="border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setMore((v) => !v)}
                aria-expanded={more}
                aria-controls="cd-more"
                className="inline-flex items-center gap-1 text-[12px] text-secondary transition-colors duration-150 hover:text-fg"
              >
                <ChevronDown className={cn("size-3.5 transition-transform duration-150", more ? "rotate-180" : "")} aria-hidden /> More details
                <span className="text-muted">— stage, owner, priority, source, close date, name</span>
              </button>
              {more ? (
                <div id="cd-more" className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="cd-stage">Stage</Label>
                    <NativeSelect id="cd-stage" value={stageId} onChange={(e) => setStageId(e.target.value)}>
                      {pipeline.stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {Math.round(s.probability * 100)}%
                        </option>
                      ))}
                    </NativeSelect>
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
                      <option value="">Auto</option>
                      {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cd-source">Source</Label>
                    <NativeSelect id="cd-source" value={source} onChange={(e) => setSource(e.target.value)}>
                      <option value="">Auto</option>
                      {(sources ?? []).map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cd-close">Expected close</Label>
                    <Input id="cd-close" type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} className="[color-scheme:dark]" placeholder="Auto" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cd-name">Deal name</Label>
                    <Input id="cd-name" placeholder={account?.name ?? (newAccount?.name || "Account name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
                  </div>
                </div>
              ) : null}
              {gateBlocked ? (
                <p role="alert" className="mt-2 text-[11px] text-secondary">
                  {stage?.name} needs {gateMissing.filter((k) => !fillable.has(k)).map((k) => gateFieldMeta(k).label).join(", ")}, which can&apos;t be set here — start in an earlier stage and move the deal once it&apos;s filled.
                </p>
              ) : gateMissing.length ? (
                <p role="alert" className="mt-2 text-[11px] text-secondary">
                  Fill {gateMissing.map((k) => gateFieldMeta(k).label).join(", ")} to start in {stage?.name}.
                </p>
              ) : null}
            </div>
          </DialogBody>
          <DialogFooter>
            {!canSubmit && !pending && blockers.length ? (
              <p className="mr-auto self-center text-[11px] text-muted" aria-live="polite">
                To create: {blockers.join(", ")}.
              </p>
            ) : null}
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!canSubmit}>
              {pending ? <Loader2 className="animate-spin" /> : null} Create deal
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
      <span aria-hidden className="mt-0.5 flex size-5 items-center justify-center rounded-full border border-border-strong text-[10px] text-secondary tabular">
        {n}
      </span>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</p>
      <div className="col-start-2 min-w-0 space-y-1">{children}</div>
    </div>
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
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-border-strong bg-surface-1 px-3 py-2">
          <Check className="size-4 shrink-0 text-good" aria-hidden />
          <span className="truncate text-sm text-fg">{account.name}</span>
          {account.domain ? <span className="hidden truncate text-xs text-muted sm:inline">{account.domain}</span> : null}
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
            <Label htmlFor="na-domain">Domain</Label>
            <Input id="na-domain" placeholder="example.com" value={newAccount.domain} onChange={(e) => onNew({ ...newAccount, domain: e.target.value })} autoFocus={!newAccount.name} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="na-name">Name</Label>
            <Input id="na-name" placeholder={newAccount.domain ? "From the domain" : "Company name"} value={newAccount.name} onChange={(e) => onNew({ ...newAccount, name: e.target.value })} />
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
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input id="acct-search" aria-label="Search accounts by name or domain" className="pl-9" placeholder="Search by name or domain…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus autoComplete="off" />
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

