"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRightLeft, Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { answerHandoff, withdrawHandoff } from "@/lib/handoffs/actions";
import { HANDOFF_KIND_LABEL, type HandoffBrief, type HandoffKind } from "@/lib/handoffs/core";
import { RelativeTime } from "@/components/deals/deal-bits";

export type HandoffView = {
  id: string;
  kind: HandoffKind;
  status: string;
  brief: HandoffBrief;
  from: { id: string; name: string; image: string | null } | null;
  to: { id: string; name: string; image: string | null };
  createdAt: string;
};

/**
 * Pending handoff on a deal. Receiver: the brief + Accept / Decline (with a note). Sender / editors: who it's waiting on
 * + Withdraw. Everyone else who can see the deal: one quiet line.
 */
export function HandoffBanner({ handoff, currentUserId, canEdit, focus }: { handoff: HandoffView; currentUserId: string; canEdit: boolean; focus?: boolean }) {
  const router = useRouter();
  const [declining, setDeclining] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [pending, start] = React.useTransition();
  const ref = React.useRef<HTMLElement>(null);
  const forMe = handoff.to.id === currentUserId;
  const mine = handoff.from?.id === currentUserId;

  React.useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: "center" });
  }, [focus]);

  const respond = (accept: boolean) =>
    start(async () => {
      const r = await answerHandoff({ handoffId: handoff.id, accept, note: note.trim() || undefined });
      if (!r.ok) return void toast.error(r.error);
      toast.success(accept ? "Accepted — the deal is yours" : "Declined — it's back with the sender");
      router.refresh();
    });
  const withdraw = () =>
    start(async () => {
      const r = await withdrawHandoff({ handoffId: handoff.id });
      if (!r.ok) return void toast.error(r.error);
      toast.success("Handoff withdrawn");
      router.refresh();
    });

  if (!forMe) {
    return (
      <section ref={ref} aria-label="Pending handoff" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface-1 px-4 py-2.5 text-[13px]">
        <ArrowRightLeft className="size-4 text-muted" aria-hidden />
        <span className="text-body">
          {HANDOFF_KIND_LABEL[handoff.kind]} to <span className="text-fg">{handoff.to.name}</span> — waiting for them to accept
        </span>
        <RelativeTime iso={handoff.createdAt} prefix="sent " className="text-[11px] text-muted" />
        {mine || canEdit ? (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={withdraw} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <X />} Withdraw
          </Button>
        ) : null}
      </section>
    );
  }

  const b = handoff.brief;
  return (
    <section ref={ref} aria-labelledby={`ho-${handoff.id}`} className="relative rounded-lg border border-border-strong bg-surface-2 py-4 pl-5 pr-4">
      <span aria-hidden className="absolute inset-y-3 left-0 w-px bg-white" />
      <div className="flex flex-wrap items-center gap-2">
        <Avatar name={handoff.from?.name} src={handoff.from?.image} size={22} />
        <h2 id={`ho-${handoff.id}`} className="text-sm font-medium text-fg">
          {handoff.from?.name ?? "A teammate"} is handing you this deal
        </h2>
        <span className="text-[11px] text-muted">
          {HANDOFF_KIND_LABEL[handoff.kind]} · <RelativeTime iso={handoff.createdAt} />
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-[13px] leading-5 text-body">{b.context}</p>
      <dl className="mt-3 grid gap-3 text-[12px] sm:grid-cols-2">
        {b.stakeholders ? <BriefBlock label="Stakeholders" text={b.stakeholders} /> : null}
        {b.commitments ? <BriefBlock label="Commitments" text={b.commitments} /> : null}
        {b.risks ? <BriefBlock label="Risks" text={b.risks} /> : null}
        {b.nextStep ? <BriefBlock label="Next step" text={b.nextStep} /> : null}
      </dl>
      {declining ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            respond(false);
          }}
        >
          <Label htmlFor={`ho-note-${handoff.id}`}>Why are you declining?</Label>
          <Textarea id={`ho-note-${handoff.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus required minLength={3} placeholder="e.g. Not my territory — try Will" />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setDeclining(false)} disabled={pending}>
              Back
            </Button>
            <Button type="submit" size="sm" variant="secondary" disabled={pending || note.trim().length < 3}>
              {pending ? <Loader2 className="animate-spin" /> : <X />} Decline
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={() => respond(true)} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Check />} Accept {handoff.kind === "ae_to_onboarding" ? "onboarding" : "ownership"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDeclining(true)} disabled={pending}>
            Decline…
          </Button>
        </div>
      )}
    </section>
  );
}

function BriefBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap text-body">{text}</dd>
    </div>
  );
}
