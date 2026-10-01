"use client";
import * as React from "react";
import { onRadioGroupKeyDown } from "@/components/deals/radio-keys";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRightLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/misc";
import { prepareHandoff, requestHandoff } from "@/lib/handoffs/actions";
import { HANDOFF_KIND_LABEL, MIN_CONTEXT, type HandoffKind } from "@/lib/handoffs/core";
import { cn } from "@/lib/utils";

type Receiver = { id: string; name: string; image: string | null; role: string };
type Prepared = { brief: { context: string; stakeholders?: string; commitments?: string; risks?: string; nextStep?: string; engine: string }; receivers: Record<HandoffKind, Receiver[]> };

const ROLE_HINT: Record<string, string> = { ae: "AE", sales_leader: "SVP", executive: "Exec", sdr: "SDR", intern: "Intern", commission_rep: "Commission rep", onboarding: "Onboarding", admin: "Admin", super_admin: "Admin", editorial: "Editorial" };

/** "Hand off" (V2 §C3): pick the kind and receiver, review the prefilled brief, send. Ownership moves on accept. */
export function HandoffButton({ dealId, dealStatus, className }: { dealId: string; dealStatus: string; className?: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" className={className} onClick={() => setOpen(true)}>
        <ArrowRightLeft /> Hand off
      </Button>
      {open ? <HandoffDialog dealId={dealId} dealStatus={dealStatus} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function HandoffDialog({ dealId, dealStatus, onClose }: { dealId: string; dealStatus: string; onClose: () => void }) {
  const router = useRouter();
  const [data, setData] = React.useState<Prepared | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const kinds: HandoffKind[] = dealStatus === "won" ? ["ae_to_onboarding"] : ["sdr_to_ae", "reassign"];
  const [kind, setKind] = React.useState<HandoffKind>(kinds[0]!);
  const [toUserId, setToUserId] = React.useState("");
  const [brief, setBrief] = React.useState({ context: "", stakeholders: "", commitments: "", risks: "", nextStep: "" });
  const [pending, start] = React.useTransition();

  React.useEffect(() => {
    let alive = true;
    prepareHandoff({ dealId }).then((r) => {
      if (!alive) return;
      if (!r.ok) return setLoadError(r.error);
      setData(r.data);
      const b = r.data.brief;
      setBrief({ context: b.context ?? "", stakeholders: b.stakeholders ?? "", commitments: b.commitments ?? "", risks: b.risks ?? "", nextStep: b.nextStep ?? "" });
    });
    return () => {
      alive = false;
    };
  }, [dealId]);

  const receivers = data?.receivers[kind] ?? [];
  const ctxLen = brief.context.trim().length;
  const canSend = !!data && !!toUserId && receivers.some((r) => r.id === toUserId) && ctxLen >= MIN_CONTEXT && !pending;

  const submit = () =>
    start(async () => {
      const r = await requestHandoff({
        dealId,
        toUserId,
        kind,
        brief: {
          context: brief.context.trim(),
          stakeholders: brief.stakeholders.trim() || undefined,
          commitments: brief.commitments.trim() || undefined,
          risks: brief.risks.trim() || undefined,
          nextStep: brief.nextStep.trim() || undefined,
        },
      });
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Sent to ${r.data.receiverName} — the deal moves when they accept`);
      onClose();
      router.refresh();
    });

  return (
    <Dialog open onOpenChange={(o) => (!o && !pending ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Hand off this deal</DialogTitle>
            <DialogDescription>The receiver gets the brief in Today. Ownership moves only when they accept; a decline returns it with a note.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {loadError ? (
              <p role="alert" className="text-sm text-secondary">
                {loadError}
              </p>
            ) : !data ? (
              <div className="space-y-3" aria-busy="true" aria-label="Preparing the brief">
                <Skeleton className="h-9" />
                <Skeleton className="h-28" />
                <Skeleton className="h-16" />
              </div>
            ) : (
              <>
                {kinds.length > 1 ? (
                  <div role="radiogroup" aria-label="Handoff type" onKeyDown={onRadioGroupKeyDown} className="grid grid-cols-2 gap-1 rounded-md border border-border p-1">
                    {kinds.map((k) => (
                      <button
                        key={k}
                        type="button"
                        role="radio"
                        aria-checked={kind === k}
                        tabIndex={kind === k ? 0 : -1}
                        onClick={() => {
                          setKind(k);
                          setToUserId("");
                        }}
                        className={cn("touch-target rounded px-3 py-1.5 text-sm transition-colors duration-150", kind === k ? "bg-white text-black" : "text-secondary hover:text-fg")}
                      >
                        {HANDOFF_KIND_LABEL[k]}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-secondary">{HANDOFF_KIND_LABEL[kind]}: the onboarding specialist takes over the migration project; you stay the relationship owner.</p>
                )}
                <div className="space-y-1">
                  <Label htmlFor="ho-to">Hand to</Label>
                  <NativeSelect id="ho-to" value={toUserId} onChange={(e) => setToUserId(e.target.value)} required>
                    <option value="">{receivers.length ? "Pick a person…" : "Nobody eligible"}</option>
                    {receivers.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                        {ROLE_HINT[r.role] ? ` · ${ROLE_HINT[r.role]}` : ""}
                      </option>
                    ))}
                  </NativeSelect>
                  {!receivers.length ? <p className="text-[11px] text-muted">Only people whose role can own this deal (and, for restricted deals, are on the access list) are listed.</p> : null}
                </div>
                <div className="space-y-1">
                  <div className="flex items-baseline justify-between">
                    <Label htmlFor="ho-context">Context *</Label>
                    <span className={cn("text-[11px] tabular", ctxLen >= MIN_CONTEXT ? "text-muted" : "text-secondary")}>
                      {ctxLen}/{MIN_CONTEXT}+
                    </span>
                  </div>
                  <Textarea id="ho-context" rows={4} value={brief.context} onChange={(e) => setBrief({ ...brief, context: e.target.value })} required aria-describedby="ho-context-hint" />
                  <p id="ho-context-hint" className="text-[11px] text-muted">
                    Prefilled {data.brief.engine === "heuristic" ? "from the deal record" : "by Copilot from the deal record"} — edit it so it reads like you.
                  </p>
                </div>
                <BriefField id="ho-stake" label="Stakeholders" value={brief.stakeholders} onChange={(v) => setBrief({ ...brief, stakeholders: v })} />
                <BriefField id="ho-commit" label="Commitments" value={brief.commitments} onChange={(v) => setBrief({ ...brief, commitments: v })} />
                <BriefField id="ho-risks" label="Risks" value={brief.risks} onChange={(v) => setBrief({ ...brief, risks: v })} />
                <div className="space-y-1">
                  <Label htmlFor="ho-next">Next step</Label>
                  <Input id="ho-next" value={brief.nextStep} onChange={(e) => setBrief({ ...brief, nextStep: e.target.value })} maxLength={500} />
                </div>
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!canSend}>
              {pending ? <Loader2 className="animate-spin" /> : null} Send handoff
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BriefField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} rows={2} value={value} onChange={(e) => onChange(e.target.value)} maxLength={2000} />
    </div>
  );
}
