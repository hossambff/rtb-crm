"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, HandHelping, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/misc";
import { answerHelpRequest, listHelpTargets, requestHelp, withdrawHelpRequest } from "@/lib/help/actions";
import { HELP_STATUS_LABEL, isOverdue, type HelpStatus } from "@/lib/help/core";
import { fmtDate } from "@/lib/format";
import { ROLE_LABELS } from "@/lib/rbac/model";
import { RelativeTime } from "@/components/deals/deal-bits";

type Target = { id: string; name: string; image: string | null; role: string };
/** Role word in the picker (POL-10: the org's role labels, not a hard-coded "SVP"); anyone else is your manager. */
const HELP_ROLES = new Set(["executive", "sales_leader", "super_admin"]);
const roleWord = (role: string) => (HELP_ROLES.has(role) ? (ROLE_LABELS as Record<string, string>)[role] : undefined);

/**
 * "Request help" (V2 §C6) from a deal or a meeting: pick an exec / leader, say what you need and by when. The deal
 * snapshot and next meeting are attached automatically. Mountable anywhere (meeting pages pass `meetingId`).
 */
export function RequestHelpButton({ dealId, meetingId, label = "Request help", size = "sm" }: { dealId?: string; meetingId?: string; label?: string; size?: "sm" | "md" }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size={size} variant="secondary" onClick={() => setOpen(true)}>
        <HandHelping /> {label}
      </Button>
      {open ? <RequestHelpDialog dealId={dealId} meetingId={meetingId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function RequestHelpDialog({ dealId, meetingId, onClose }: { dealId?: string; meetingId?: string; onClose: () => void }) {
  const router = useRouter();
  const [targets, setTargets] = React.useState<Target[] | null>(null);
  const [targetUserId, setTarget] = React.useState("");
  const [ask, setAsk] = React.useState("");
  const [neededBy, setNeededBy] = React.useState("");
  const [pending, start] = React.useTransition();

  React.useEffect(() => {
    let alive = true;
    listHelpTargets({ dealId }).then((r) => {
      if (!alive) return;
      if (!r.ok) {
        toast.error(r.error);
        setTargets([]);
        return;
      }
      setTargets(r.data);
    });
    return () => {
      alive = false;
    };
  }, [dealId]);

  const submit = () =>
    start(async () => {
      const r = await requestHelp({ dealId, meetingId, targetUserId, ask: ask.trim(), neededBy: neededBy || null });
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Asked ${r.data.targetName} — you'll be notified when they answer`);
      onClose();
      router.refresh();
    });

  return (
    <Dialog open onOpenChange={(o) => (!o && !pending ? onClose() : undefined)}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Request help</DialogTitle>
            <DialogDescription>The deal summary and next meeting are attached automatically. It lands in their Today list.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-1">
              <Label htmlFor="hr-target">Who</Label>
              <NativeSelect id="hr-target" value={targetUserId} onChange={(e) => setTarget(e.target.value)} disabled={!targets} required>
                <option value="">{!targets ? "Loading…" : targets.length ? "Pick an exec or leader…" : "Nobody eligible"}</option>
                {(targets ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {roleWord(t.role) ? ` · ${roleWord(t.role)}` : " · your manager"}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="hr-ask">What do you need?</Label>
              <Textarea id="hr-ask" rows={3} value={ask} onChange={(e) => setAsk(e.target.value)} required minLength={10} maxLength={1000} placeholder="e.g. Join the TheStreet call Thursday to talk guarantee terms with their CRO" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hr-by">Needed by</Label>
              <Input id="hr-by" type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} className="[color-scheme:dark] sm:w-48" />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !targetUserId || ask.trim().length < 10}>
              {pending ? <Loader2 className="animate-spin" /> : null} Send request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type HelpView = {
  id: string;
  ask: string;
  context: string | null;
  neededBy: string | null;
  status: HelpStatus;
  response: string | null;
  createdAt: string;
  requester: { id: string; name: string; image: string | null };
  target: { id: string; name: string; image: string | null };
  /** Computed on the server (avoids a hydration mismatch from evaluating "now" during render, CR L10). */
  overdue?: boolean;
};

/** Help requests on a deal: the target answers inline (accept / decline / done), the requester can withdraw. */
export function HelpRequestList({ requests, currentUserId, focusId }: { requests: HelpView[]; currentUserId: string; focusId?: string | null }) {
  if (!requests.length) return null;
  return (
    <ul className="space-y-2" aria-label="Help requests">
      {requests.map((r) => (
        <HelpRow key={r.id} r={r} currentUserId={currentUserId} focus={focusId === r.id} />
      ))}
    </ul>
  );
}

function HelpRow({ r, currentUserId, focus }: { r: HelpView; currentUserId: string; focus: boolean }) {
  const router = useRouter();
  const [mode, setMode] = React.useState<null | "declined" | "done">(null);
  const [response, setResponse] = React.useState("");
  const [pending, start] = React.useTransition();
  const ref = React.useRef<HTMLLIElement>(null);
  const forMe = r.target.id === currentUserId;
  const mine = r.requester.id === currentUserId;
  const active = r.status === "open" || r.status === "accepted";
  const overdue = r.overdue ?? isOverdue(r, new Date());
  const [showContext, setShowContext] = React.useState(focus);
  React.useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: "center" });
  }, [focus]);

  const answer = (status: "accepted" | "declined" | "done") =>
    start(async () => {
      const res = await answerHelpRequest({ id: r.id, status, response: response.trim() || undefined });
      if (!res.ok) return void toast.error(res.error);
      toast.success(status === "accepted" ? "Accepted — they've been told" : status === "done" ? "Marked done" : "Declined");
      setMode(null);
      router.refresh();
    });
  const withdraw = () =>
    start(async () => {
      const res = await withdrawHelpRequest({ id: r.id });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Request withdrawn");
      router.refresh();
    });

  return (
    <li ref={ref} className={`rounded-lg border bg-surface-1 px-4 py-3 ${focus || (forMe && active) ? "border-border-strong" : "border-border"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
        <Avatar name={r.requester.name} src={r.requester.image} size={18} />
        <span className="text-secondary">
          <span className="text-fg">{mine ? "You" : r.requester.name}</span> asked <span className="text-fg">{forMe ? "you" : r.target.name}</span>
        </span>
        <RelativeTime iso={r.createdAt} className="text-[11px] text-muted" />
        <span className="ml-auto flex items-center gap-1.5">
          {r.neededBy ? <span className="text-[11px] text-muted tabular">by {fmtDate(r.neededBy, "EEE d MMM")}</span> : null}
          {overdue ? (
            <StatusBadge status="critical" label="Overdue" />
          ) : (
            <StatusBadge status={r.status === "done" ? "good" : r.status === "declined" ? "warning" : r.status === "accepted" ? "progress" : "info"} label={HELP_STATUS_LABEL[r.status]} />
          )}
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] text-body">{r.ask}</p>
      {r.context ? (
        <div className="mt-1.5">
          <button type="button" className="-my-2 py-2 text-[11px] text-muted underline-offset-2 hover:text-secondary hover:underline" aria-expanded={showContext} onClick={() => setShowContext((v) => !v)}>
            {showContext ? "Hide context" : "Show context"}
          </button>
          {showContext ? <p className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-surface-2 px-3 py-2 text-[12px] text-secondary">{r.context}</p> : null}
        </div>
      ) : null}
      {r.response ? <p className="mt-1.5 border-l border-border-strong pl-2 text-[12px] italic text-secondary">“{r.response}”</p> : null}
      {forMe && active ? (
        mode ? (
          <form
            className="mt-2 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              answer(mode);
            }}
          >
            <Textarea aria-label="Your response" rows={2} value={response} onChange={(e) => setResponse(e.target.value)} autoFocus required={mode === "declined"} placeholder={mode === "declined" ? "Why not / who instead?" : "What you did / outcome (optional)"} />
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)} disabled={pending}>
                Back
              </Button>
              <Button type="submit" size="sm" variant={mode === "done" ? "primary" : "secondary"} disabled={pending || (mode === "declined" && response.trim().length < 3)}>
                {pending ? <Loader2 className="animate-spin" /> : mode === "done" ? <Check /> : <X />} {mode === "done" ? "Mark done" : "Decline"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {r.status === "open" ? (
              <Button size="sm" variant="primary" onClick={() => answer("accepted")} disabled={pending}>
                {pending ? <Loader2 className="animate-spin" /> : <Check />} I&apos;m on it
              </Button>
            ) : null}
            <Button size="sm" variant={r.status === "accepted" ? "primary" : "secondary"} onClick={() => setMode("done")} disabled={pending}>
              Done…
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("declined")} disabled={pending}>
              Decline…
            </Button>
          </div>
        )
      ) : mine && active ? (
        <div className="mt-2">
          <Button size="sm" variant="ghost" onClick={withdraw} disabled={pending}>
            Withdraw
          </Button>
        </div>
      ) : null}
    </li>
  );
}
