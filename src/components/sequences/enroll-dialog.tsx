"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Search, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { enrollInSequence, getEnrollOptions, searchContactsForEnroll } from "@/lib/sequences/actions";
import { cn } from "@/lib/utils";

export type EnrollTarget = { contactIds?: string[]; dealIds?: string[]; accountIds?: string[] };
type Options = { sequences: { id: string; name: string; stepCount: number; hasEmail: boolean }[]; gmailReady: boolean; connectHref: string; senders: { id: string; name: string }[]; me: string };
type Skip = { id: string; name: string; reason: string };
type PickedContact = { id: string; fullName: string; email: string | null; accountName: string | null; dnc: boolean };

/**
 * Enroll dialog used everywhere (contact, deal, account, lists, ⌘K, sequence page).
 * - `target` given → pick a sequence. `sequenceId` given without target → search & pick contacts (≤ 100).
 * - `choices` → checkbox list of candidate contacts (e.g. a deal's contacts), `defaultChoiceIds` preselected.
 */
export function EnrollDialog({
  target,
  dealId,
  sequenceId,
  sequenceName,
  choices,
  defaultChoiceIds,
  label,
  trigger,
  open: openProp,
  onOpenChange,
  onDone,
  source = "list",
}: {
  target?: EnrollTarget;
  /** Link the enrolled contacts to this deal (deal page). */
  dealId?: string;
  sequenceId?: string;
  sequenceName?: string;
  choices?: { id: string; name: string; detail?: string | null; disabledReason?: string | null }[];
  defaultChoiceIds?: string[];
  label?: string;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  onDone?: () => void;
  source?: "contact" | "deal" | "account" | "list" | "scout" | "sequence_page" | "command";
}) {
  const router = useRouter();
  const [openState, setOpenState] = React.useState(false);
  const open = openProp ?? openState;
  const setOpen = (o: boolean) => (onOpenChange ? onOpenChange(o) : setOpenState(o));
  const [opts, setOpts] = React.useState<Options | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [seqId, setSeqId] = React.useState(sequenceId ?? "");
  const [sender, setSender] = React.useState("");
  const [picked, setPicked] = React.useState<PickedContact[]>([]);
  const [chosen, setChosen] = React.useState<Set<string>>(() => new Set(defaultChoiceIds ?? []));
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ enrolled: number; skipped: Skip[]; sequenceName: string } | null>(null);
  const pickMode = !target && !choices;

  // reset per opening (render-time state adjustment, no effect)
  const [prevOpen, setPrevOpen] = React.useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setResult(null);
      setErr(null);
    }
  }

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    getEnrollOptions({}).then((r) => {
      if (!live) return;
      if (!r.ok) return setErr(r.error);
      setOpts(r.data);
      setSender(r.data.me);
      if (!sequenceId && r.data.sequences.length === 1) setSeqId(r.data.sequences[0]!.id);
    });
    return () => {
      live = false;
    };
  }, [open, sequenceId]);

  const selectedSeq = opts?.sequences.find((q) => q.id === seqId) ?? null;
  const needsGmail = Boolean(opts && !opts.gmailReady && sender === opts.me && (selectedSeq?.hasEmail ?? true));
  const contactIds = pickMode ? picked.map((p) => p.id) : choices ? [...chosen] : (target?.contactIds ?? []);
  const count = pickMode || choices ? contactIds.length : null;
  const canSubmit = Boolean(seqId) && !busy && !needsGmail && (count === null ? true : count > 0);

  async function submit() {
    setBusy(true);
    const r = await enrollInSequence({
      sequenceId: seqId,
      contactIds: pickMode || choices ? contactIds : target?.contactIds,
      dealIds: choices ? undefined : target?.dealIds,
      accountIds: choices ? undefined : target?.accountIds,
      senderId: sender && opts && sender !== opts.me ? sender : null,
      dealId: dealId ?? null,
      source,
    });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    setResult(r.data);
    if (r.data.enrolled) toast.success(`Enrolled ${r.data.enrolled} in “${r.data.sequenceName}”`);
    else toast.message("Nobody was enrolled", { description: r.data.skipped[0]?.reason });
    router.refresh();
    onDone?.();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger !== undefined ? (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      ) : openProp === undefined ? (
        <DialogTrigger asChild>
          <Button size="sm">
            <Send aria-hidden /> {label ?? "Enroll in sequence"}
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{sequenceName ? `Enroll in “${sequenceName}”` : "Enroll in a sequence"}</DialogTitle>
          <DialogDescription>Emails go from the sender’s own Gmail, inside their working hours. Anyone who replies, books a meeting or opts out leaves the sequence automatically.</DialogDescription>
        </DialogHeader>
        {result ? (
          <ResultView result={result} />
        ) : (
          <DialogBody>
            {err ? <p className="text-sm text-secondary">{err}</p> : null}
            {!opts && !err ? <Skeleton className="h-24 w-full" /> : null}
            {opts ? (
              <>
                {!sequenceId ? (
                  opts.sequences.length ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="enroll-seq">Sequence</Label>
                      <NativeSelect id="enroll-seq" value={seqId} onChange={(e) => setSeqId(e.target.value)}>
                        <option value="">Choose a sequence…</option>
                        {opts.sequences.map((q) => (
                          <option key={q.id} value={q.id}>
                            {q.name} · {q.stepCount} step{q.stepCount === 1 ? "" : "s"}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                  ) : (
                    <p className="text-sm text-secondary">
                      No active sequences yet.{" "}
                      <Link href="/sequences" className="text-fg underline underline-offset-2">
                        Create one
                      </Link>{" "}
                      first.
                    </p>
                  )
                ) : null}
                {opts.senders.length > 1 ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="enroll-sender">Send from</Label>
                    <NativeSelect id="enroll-sender" value={sender} onChange={(e) => setSender(e.target.value)}>
                      {opts.senders.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.id === opts.me ? `${u.name} (me)` : u.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                ) : null}
                {needsGmail ? (
                  <div className="rounded-md border border-border-strong bg-surface-3/40 px-3 py-2.5 text-sm text-body">
                    Sequences send from your own Gmail. <Link href={opts.connectHref} className="text-fg underline underline-offset-2">Connect your inbox</Link> (read + send) to enroll people.
                  </div>
                ) : null}
                {choices ? <ChoiceList choices={choices} chosen={chosen} setChosen={setChosen} /> : null}
                {pickMode ? <ContactPicker picked={picked} setPicked={setPicked} /> : null}
              </>
            ) : null}
          </DialogBody>
        )}
        <DialogFooter>
          {result ? (
            <Button variant="primary" onClick={() => setOpen(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!canSubmit} onClick={submit}>
                {busy ? "Enrolling…" : count != null ? `Enroll ${count}` : "Enroll"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResultView({ result }: { result: { enrolled: number; skipped: Skip[]; sequenceName: string } }) {
  return (
    <DialogBody>
      <div className="flex items-center gap-3">
        <span className={cn("inline-flex size-9 items-center justify-center rounded-full border", result.enrolled ? "border-good/60 text-good" : "border-border-strong text-muted")}>
          <Check className="size-4" aria-hidden />
        </span>
        <div>
          <p className="font-display text-lg text-fg">
            {result.enrolled} enrolled{result.skipped.length ? ` · ${result.skipped.length} skipped` : ""}
          </p>
          <p className="text-xs text-muted">The first step goes out at the next slot inside the sender’s working hours.</p>
        </div>
      </div>
      {result.skipped.length ? (
        <ul className="max-h-52 divide-y divide-border overflow-y-auto rounded-md border border-border text-sm">
          {result.skipped.map((s, i) => (
            <li key={`${s.id}-${i}`} className="flex items-baseline justify-between gap-3 px-3 py-2">
              <span className="truncate text-body">{s.name}</span>
              <span className="shrink-0 text-xs text-muted">{s.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </DialogBody>
  );
}

function ChoiceList({ choices, chosen, setChosen }: { choices: { id: string; name: string; detail?: string | null; disabledReason?: string | null }[]; chosen: Set<string>; setChosen: (s: Set<string>) => void }) {
  if (!choices.length) return <p className="text-sm text-muted">No contacts to enroll yet. Add a contact to the deal first.</p>;
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1.5 text-xs font-medium text-secondary">Who</legend>
      {choices.map((c) => {
        const disabled = Boolean(c.disabledReason);
        return (
          <label key={c.id} className={cn("flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-3/50", disabled && "opacity-50")}>
            <input
              type="checkbox"
              className="size-4 accent-white"
              disabled={disabled}
              checked={chosen.has(c.id)}
              onChange={(e) => {
                const n = new Set(chosen);
                if (e.target.checked) n.add(c.id);
                else n.delete(c.id);
                setChosen(n);
              }}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-body">{c.name}</span>
              <span className="block truncate text-xs text-muted">{c.disabledReason ?? c.detail ?? ""}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function ContactPicker({ picked, setPicked }: { picked: PickedContact[]; setPicked: (p: PickedContact[]) => void }) {
  const [q, setQ] = React.useState("");
  const [rows, setRows] = React.useState<PickedContact[] | null>(null);
  React.useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      searchContactsForEnroll({ q }).then((r) => live && setRows(r.ok ? r.data : []));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  const ids = new Set(picked.map((p) => p.id));
  return (
    <div className="space-y-2">
      <Label htmlFor="enroll-search">Contacts ({picked.length}/100)</Label>
      {picked.length ? (
        <div className="flex flex-wrap gap-1.5">
          {picked.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 rounded border border-border-strong px-1.5 py-0.5 text-xs text-body">
              {p.fullName}
              <button type="button" aria-label={`Remove ${p.fullName}`} className="text-muted hover:text-fg" onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" aria-hidden />
        <Input id="enroll-search" className="pl-8" placeholder="Search name, email or company" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
        {rows === null ? (
          <li className="p-2">
            <Skeleton className="h-6 w-full" />
          </li>
        ) : rows.length ? (
          rows.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                aria-pressed={ids.has(c.id)}
                disabled={c.dnc || !c.email || (picked.length >= 100 && !ids.has(c.id))}
                onClick={() => setPicked(ids.has(c.id) ? picked.filter((p) => p.id !== c.id) : [...picked, c])}
                className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-150 hover:bg-surface-3/50 disabled:opacity-40"
              >
                <span className={cn("inline-flex size-4 items-center justify-center rounded border", ids.has(c.id) ? "border-fg bg-fg text-accent-inverse" : "border-border-strong")}>{ids.has(c.id) ? <Check className="size-3" aria-hidden /> : null}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-body">{c.fullName}</span>
                  <span className="block truncate text-xs text-muted">{c.dnc ? "Do not contact" : !c.email ? "No email" : [c.email, c.accountName].filter(Boolean).join(" · ")}</span>
                </span>
              </button>
            </li>
          ))
        ) : (
          <li className="px-3 py-3 text-sm text-muted">No matching contacts.</li>
        )}
      </ul>
    </div>
  );
}
