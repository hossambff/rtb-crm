"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, CalendarClock, Check, ExternalLink, Flag, ListTodo, Lock, OctagonX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorTick, StatusBadge } from "@/components/ui/badge";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Kbd } from "@/components/team/kbd";
import { fmtUsd } from "@/lib/format";
import { healthStatus } from "@/lib/palette";
import { cn } from "@/lib/utils";
import { endReview, recordDecision } from "@/lib/review/actions";
import { EXCEPTION_META, OUTCOME_KEYS, OUTCOME_LABELS, OUTCOME_PAST, OUTCOMES, latestDecisions, type Decision, type Outcome } from "@/lib/review/core";
import type { WalkDeal } from "@/lib/review/queries";

type Props = {
  session: { id: string; title: string };
  deals: WalkDeal[];
  decisions: Decision[];
  missing: number;
  lostReasons: { value: string; label: string }[];
  todayKey: string; // YYYY-MM-DD in the facilitator's zone
};

const ICONS: Record<Outcome, typeof Check> = { keep: Check, push: CalendarClock, update: ListTodo, escalate: Flag, close_lost: OctagonX };

/** YYYY-MM-DD arithmetic (calendar days, zone-free). */
function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function endOfQuarter(ymd: string, offset = 0): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  const q = Math.floor(d.getUTCMonth() / 3) + offset;
  const end = new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0, 12));
  return end.toISOString().slice(0, 10);
}
function businessDaysFrom(ymd: string, n: number): string {
  let d = ymd;
  let added = 0;
  while (added < n) {
    d = addDays(d, 1);
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)));
}

export function Walkthrough({ session, deals, decisions: initialDecisions, missing, lostReasons, todayKey }: Props) {
  const router = useRouter();
  const [decisions, setDecisions] = useState<Decision[]>(initialDecisions);
  const latest = useMemo(() => latestDecisions(decisions), [decisions]);
  const firstOpen = Math.max(0, deals.findIndex((d) => !latest.has(d.id)));
  const [index, setIndex] = useState(firstOpen);
  const [panel, setPanel] = useState<Outcome | null>(null);
  const [help, setHelp] = useState(false);
  const [pending, start] = useTransition();
  const [finishing, startFinish] = useTransition();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const deal = deals[Math.min(index, deals.length - 1)];
  const decidedCount = deals.filter((d) => latest.has(d.id)).length;
  const allDone = deals.length > 0 && decidedCount === deals.length;

  const go = useCallback((i: number) => setIndex(Math.max(0, Math.min(deals.length - 1, i))), [deals.length]);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [index]);

  const nextUndecided = useCallback(
    (from: number, decided: Map<string, Decision>) => {
      for (let k = 1; k <= deals.length; k++) {
        const j = (from + k) % deals.length;
        if (!decided.has(deals[j]!.id)) return j;
      }
      return from;
    },
    [deals],
  );

  const submit = useCallback(
    (payload: Parameters<typeof recordDecision>[0]) => {
      start(async () => {
        const res = await recordDecision(payload);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.data.message);
        setPanel(null);
        const next = [...decisions, res.data.decision];
        setDecisions(next);
        const map = latestDecisions(next);
        // a short beat so the decision registers visually before moving on
        setTimeout(() => go(nextUndecided(index, map)), 180);
        router.refresh();
      });
    },
    [decisions, go, index, nextUndecided, router],
  );

  const choose = useCallback(
    (o: Outcome) => {
      if (!deal || pending) return;
      if (o === "close_lost" && !deal.lostStageId) {
        toast.error("This pipeline has no lost stage.");
        return;
      }
      if (o === "keep") submit({ sessionId: session.id, dealId: deal.id, outcome: "keep" });
      else setPanel(o);
    },
    [deal, pending, session.id, submit],
  );

  function finish() {
    startFinish(async () => {
      const res = await endReview({ sessionId: session.id });
      if (!res.ok) toast.error(res.error);
      else router.refresh();
    });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (panel || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      // QA MIN-30: nothing fires behind the open help dialog (only "?" closes it); held keys don't repeat decisions.
      if (help) {
        if (e.key === "?") setHelp(false);
        return;
      }
      if (e.repeat) return;
      if (e.key === "ArrowRight" || e.key === "j") {
        e.preventDefault();
        go(index + 1);
      } else if (e.key === "ArrowLeft" || e.key === "k") {
        e.preventDefault();
        go(index - 1);
      } else if (e.key === "?") setHelp((h) => !h);
      else if (e.key === "o" && deal) window.open(`/deals/${deal.id}`, "_blank", "noopener");
      else {
        const o = OUTCOMES.find((x) => OUTCOME_KEYS[x] === e.key);
        if (o) {
          e.preventDefault();
          choose(o);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, help, index, go, choose, deal]);

  if (!deal) {
    return (
      <Shell title={session.title} onFinish={finish} finishing={finishing} decided={0} total={0}>
        <div className="mx-auto max-w-md py-24 text-center">
          <p className="font-display text-xl text-fg">No deals left in this review</p>
          <p className="mt-2 text-sm text-muted">{missing ? `${missing} deal${missing === 1 ? " was" : "s were"} deleted or you lost access.` : "The list is empty."}</p>
        </div>
      </Shell>
    );
  }

  const decided = latest.get(deal.id);
  const history = decisions.filter((d) => d.dealId === deal.id);
  const nextStepOverdue = deal.nextStepDueAt != null && deal.nextStepDueAt < todayKey;

  return (
    <Shell title={session.title} onFinish={finish} finishing={finishing} decided={decidedCount} total={deals.length}>
      {/* progress strip: one tick per deal, click to jump */}
      <nav aria-label="Deals in this review" className={cn("mx-auto mb-6 flex max-w-5xl px-4 md:px-8", deals.length > 50 ? "gap-px" : "gap-[2px]")}>
        {deals.map((d, i) => (
          <button
            key={d.id}
            type="button"
            onClick={() => go(i)}
            tabIndex={-1 /* mouse shortcut; keyboard users move with ← → */}
            aria-label={`${i + 1}. ${d.name}${latest.has(d.id) ? ` — ${OUTCOME_PAST[latest.get(d.id)!.outcome]}` : ""}`}
            aria-current={i === index ? "step" : undefined}
            className={cn(
              "h-1.5 min-w-0 flex-1 rounded-full transition-colors duration-150",
              i === index ? "bg-white" : latest.has(d.id) ? "bg-muted" : "bg-surface-3 hover:bg-border-strong",
            )}
          />
        ))}
      </nav>

      <div className="sr-only" aria-live="polite">
        Deal {index + 1} of {deals.length}: {deal.name}
      </div>

      <article className="mx-auto max-w-5xl px-4 pb-48 md:px-8 md:pb-36">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="tabular">
            {index + 1} / {deals.length}
          </span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1.5">
            <ColorTick color={deal.pipelineColor} /> {deal.pipelineName}
          </span>
          <span aria-hidden>·</span>
          <span>{deal.stageName}</span>
          <span aria-hidden>·</span>
          <span>{deal.ownerName ?? "Unassigned"}</span>
          {deal.restricted ? (
            <span className="inline-flex items-center gap-1 text-secondary">
              <Lock className="size-3" aria-hidden /> Restricted
            </span>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 ref={headingRef} tabIndex={-1} className="font-display text-[28px] font-medium leading-9 text-fg outline-none [overflow-wrap:anywhere] md:text-[34px] md:leading-[42px]">
              {deal.name}
            </h1>
            {deal.accountName ? <p className="mt-0.5 text-sm text-muted">{deal.accountName}</p> : null}
          </div>
          <Link href={`/deals/${deal.id}`} target="_blank" className="inline-flex items-center gap-1 text-xs text-secondary hover:text-fg">
            Open deal <ExternalLink className="size-3" aria-hidden /> <Kbd className="ml-1">O</Kbd>
          </Link>
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {deal.exceptions.length ? (
            deal.exceptions.map((e) => (
              <span key={e.kind} className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-body">
                <StatusBadge status={EXCEPTION_META[e.kind].tone} label={e.label} className="border-0 px-0 py-0" />
                <span className="text-muted">{e.detail}</span>
              </span>
            ))
          ) : (
            <StatusBadge status="good" label="Resolved since the list was built" />
          )}
        </div>

        {decided ? (
          <p className="mt-4 inline-flex items-center gap-2 rounded-md border border-white/40 bg-surface-2 px-3 py-1.5 text-sm text-fg">
            <Check className="size-4 text-good" aria-hidden />
            {OUTCOME_PAST[decided.outcome]}
            {decided.note ? <span className="text-muted">— {decided.note}</span> : null}
            {history.length > 1 ? <span className="text-xs text-muted">({history.length} decisions)</span> : null}
          </p>
        ) : null}

        <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
          {[
            { k: "Value", v: deal.valueUsd != null ? fmtUsd(deal.valueUsd, { compact: true }) : "—" },
            { k: "Health", v: deal.healthScore != null ? <StatusBadge status={healthStatus(deal.healthScore)} label={String(deal.healthScore)} /> : "—" },
            { k: "Close date", v: deal.expectedCloseLabel ?? "Not set" },
            { k: "In stage", v: `${deal.daysInStage}d${deal.slaDays ? ` / ${deal.slaDays}d SLA` : ""}` },
            { k: "Last touch", v: deal.lastActivityLabel ?? "Never" },
            { k: "Open tasks", v: `${deal.openTasks}${deal.overdueTasks ? ` (${deal.overdueTasks} overdue)` : ""}` },
          ].map((x) => (
            <div key={x.k} className="bg-surface-1 px-4 py-3">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">{x.k}</dt>
              <dd className="mt-1 text-sm text-fg tabular">{x.v}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-6 grid gap-4 lg:grid-cols-5">
          <div className="space-y-4 lg:col-span-3">
            <section className="rounded-lg border border-border bg-surface-2 p-4" aria-label="Summary">
              <div className="border-l border-white/80 pl-3">
                <p className="font-display text-sm italic text-secondary">{deal.summary ? "Copilot" : "Health"}</p>
                <p className="mt-1 whitespace-pre-line text-sm leading-6 text-body">{deal.summary ?? deal.healthExplanation ?? "No summary yet."}</p>
              </div>
            </section>
            <section className="rounded-lg border border-border bg-surface-1 p-4" aria-label="Next step">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Next step</p>
              {deal.nextStep ? (
                <p className="mt-1 text-[15px] text-fg">
                  {deal.nextStep}
                  <span className={cn("ml-2 text-xs", nextStepOverdue ? "text-critical" : "text-muted")}>{deal.nextStepDueLabel ? `due ${deal.nextStepDueLabel}` : "no due date"}</span>
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted">Nothing planned.</p>
              )}
            </section>
          </div>
          <section className="rounded-lg border border-border bg-surface-1 p-4 lg:col-span-2" aria-label="What changed this week">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">What changed this week</p>
            {deal.changes.length ? (
              <ol className="mt-2 space-y-2">
                {deal.changes.map((c, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="w-20 shrink-0 text-xs text-muted">{c.label}</span>
                    <span className="min-w-0 text-body [overflow-wrap:anywhere]">{c.text}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-2 text-sm text-muted">No changes and no activity in the last 7 days.</p>
            )}
          </section>
        </div>

        {allDone ? (
          <div className="mt-8 flex flex-col items-center gap-3 rounded-lg border border-border-strong bg-surface-2 px-6 py-8 text-center">
            <span className="inline-flex size-11 items-center justify-center rounded-full border border-border-strong" aria-hidden>
              <Check className="size-5 text-good" />
            </span>
            <p className="font-display text-xl text-fg">Every deal has a decision</p>
            <Button variant="primary" onClick={finish} disabled={finishing}>
              {finishing ? "Wrapping up…" : "Finish & see the recap"}
            </Button>
          </div>
        ) : null}
      </article>

      {/* decision bar */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-[2px]">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:px-8">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:flex md:flex-1">
            {OUTCOMES.map((o) => {
              const Icon = ICONS[o];
              const disabled = pending || (o === "close_lost" && !deal.lostStageId);
              return (
                <Button
                  key={o}
                  variant={decided?.outcome === o ? "primary" : "secondary"}
                  size="md"
                  onClick={() => choose(o)}
                  disabled={disabled}
                  className={cn("justify-start md:justify-center", o === "close_lost" && "[&_svg]:text-critical")}
                  aria-keyshortcuts={OUTCOME_KEYS[o]}
                >
                  <Icon aria-hidden />
                  <span className="truncate">{OUTCOME_LABELS[o]}</span>
                  <Kbd className="ml-auto hidden sm:inline-flex md:ml-1">{OUTCOME_KEYS[o]}</Kbd>
                </Button>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-2 md:justify-end">
            <Button variant="ghost" size="md" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous deal" aria-keyshortcuts="ArrowLeft">
              <ArrowLeft /> <span className="md:sr-only">Previous</span>
            </Button>
            <button type="button" onClick={() => setHelp(true)} className="hidden text-xs text-muted hover:text-fg md:inline">
              <Kbd>?</Kbd> shortcuts
            </button>
            <Button variant="ghost" size="md" onClick={() => go(index + 1)} disabled={index >= deals.length - 1} aria-label="Next deal" aria-keyshortcuts="ArrowRight">
              <span className="md:sr-only">Skip</span> <ArrowRight />
            </Button>
          </div>
        </div>
      </div>

      {panel && panel !== "keep" ? (
        <OutcomePanel
          key={`${deal.id}-${panel}`}
          outcome={panel}
          deal={deal}
          sessionId={session.id}
          lostReasons={lostReasons}
          todayKey={todayKey}
          pending={pending}
          onCancel={() => setPanel(null)}
          onSubmit={submit}
        />
      ) : null}

      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Shortcuts</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <ul className="space-y-2 text-sm text-body">
              {OUTCOMES.map((o) => (
                <li key={o} className="flex justify-between">
                  {OUTCOME_LABELS[o]} <Kbd>{OUTCOME_KEYS[o]}</Kbd>
                </li>
              ))}
              <li className="flex justify-between">
                Next / previous deal{" "}
                <span className="flex gap-1">
                  <Kbd>→</Kbd>
                  <Kbd>←</Kbd> <Kbd>J</Kbd>
                  <Kbd>K</Kbd>
                </span>
              </li>
              <li className="flex justify-between">
                Open the deal in a new tab <Kbd>O</Kbd>
              </li>
            </ul>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}

function Shell({ title, children, onFinish, finishing, decided, total }: { title: string; children: React.ReactNode; onFinish: () => void; finishing: boolean; decided: number; total: number }) {
  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-bg" role="region" aria-label="Pipeline review walk-through">
      <header className="sticky top-0 z-10 border-b border-border bg-bg/95 backdrop-blur-[2px]">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 md:px-8">
          <Link href="/review" aria-label="Exit review (progress is saved)" className="touch-target inline-flex items-center justify-center rounded p-1 text-muted hover:text-fg">
            <X className="size-5" />
          </Link>
          <p className="min-w-0 flex-1 truncate font-display text-base text-fg">{title}</p>
          <span className="hidden text-xs text-muted tabular sm:inline">
            {decided} of {total} decided
          </span>
          <Button variant="secondary" size="sm" onClick={onFinish} disabled={finishing}>
            {finishing ? "Finishing…" : "Finish"}
          </Button>
        </div>
      </header>
      <div className="pt-4">{children}</div>
    </div>
  );
}

function OutcomePanel({
  outcome,
  deal,
  sessionId,
  lostReasons,
  todayKey,
  pending,
  onCancel,
  onSubmit,
}: {
  outcome: Exclude<Outcome, "keep">;
  deal: WalkDeal;
  sessionId: string;
  lostReasons: { value: string; label: string }[];
  todayKey: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (p: Parameters<typeof recordDecision>[0]) => void;
}) {
  const needsNext = !deal.nextStep || !deal.nextStepDueAt;
  const baseClose = deal.expectedCloseDate && deal.expectedCloseDate > todayKey ? deal.expectedCloseDate : todayKey;
  const [close, setClose] = useState(addDays(baseClose, 30));
  const [nextStep, setNextStep] = useState(deal.nextStep ?? "");
  const [nextDue, setNextDue] = useState(deal.nextStepDueAt && deal.nextStepDueAt >= todayKey ? deal.nextStepDueAt : businessDaysFrom(todayKey, 3));
  const [createTask, setCreateTask] = useState(true);
  const [assignee, setAssignee] = useState(deal.escalateTo[0]?.id ?? "");
  const [escDue, setEscDue] = useState(businessDaysFrom(todayKey, 2));
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");

  const quick = [
    { label: "+2 weeks", v: addDays(baseClose, 14) },
    { label: "+1 month", v: addDays(baseClose, 30) },
    { label: "End of quarter", v: endOfQuarter(baseClose) > todayKey ? endOfQuarter(baseClose) : endOfQuarter(baseClose, 1) },
    { label: "Next quarter", v: endOfQuarter(baseClose, 1) },
  ].filter((q, i, a) => q.v > todayKey && a.findIndex((x) => x.v === q.v) === i);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = note.trim() || undefined;
    if (outcome === "push") onSubmit({ sessionId, dealId: deal.id, outcome, expectedCloseDate: close, note: n, ...(needsNext ? { nextStep: nextStep.trim(), nextStepDueAt: nextDue } : {}) });
    else if (outcome === "update") onSubmit({ sessionId, dealId: deal.id, outcome, nextStep: nextStep.trim(), nextStepDueAt: nextDue, createTask, note: n });
    else if (outcome === "escalate") onSubmit({ sessionId, dealId: deal.id, outcome, assigneeId: assignee, note: note.trim(), dueAt: escDue });
    else onSubmit({ sessionId, dealId: deal.id, outcome, reasonCode: reason, note: n });
  }

  const titles: Record<typeof outcome, { title: string; desc: string; cta: string }> = {
    push: { title: "Push the close date", desc: `Currently ${deal.expectedCloseLabel ?? "not set"}.`, cta: "Push date" },
    update: { title: "Update the next step", desc: "One concrete action with a date.", cta: "Save next step" },
    escalate: { title: "Escalate", desc: "Creates a high-priority task for the person you pick and notifies them.", cta: "Escalate" },
    close_lost: { title: "Close as lost", desc: "Moves the deal to Lost through the normal stage gates (approvals still apply).", cta: "Close lost" },
  };
  const t = titles[outcome];
  const valid =
    outcome === "push"
      ? close > todayKey && (!needsNext || (nextStep.trim().length >= 3 && Boolean(nextDue)))
      : outcome === "update"
        ? nextStep.trim().length >= 3 && nextDue >= todayKey
        : outcome === "escalate"
          ? Boolean(assignee) && note.trim().length >= 3
          : Boolean(reason);

  return (
    <Dialog open onOpenChange={(o) => (!o ? onCancel() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>
            {deal.name} · {t.desc}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <DialogBody>
            {outcome === "push" ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="rv-close">New close date</Label>
                  <Input id="rv-close" type="date" value={close} min={addDays(todayKey, 1)} onChange={(e) => setClose(e.target.value)} required autoFocus />
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {quick.map((q) => (
                      <button key={q.label} type="button" onClick={() => setClose(q.v)} className={cn("touch-target h-7 rounded-full border px-2.5 text-xs transition-colors duration-150", close === q.v ? "border-white bg-white text-black" : "border-border text-secondary hover:text-fg")}>
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>
                {needsNext ? (
                  <NextStepFields nextStep={nextStep} setNextStep={setNextStep} nextDue={nextDue} setNextDue={setNextDue} todayKey={todayKey} hint="Open deals need a next step — add one with the new date." />
                ) : null}
              </>
            ) : null}
            {outcome === "update" ? (
              <>
                <NextStepFields nextStep={nextStep} setNextStep={setNextStep} nextDue={nextDue} setNextDue={setNextDue} todayKey={todayKey} autoFocus />
                <label className="flex items-center gap-2 text-sm text-body">
                  <input type="checkbox" checked={createTask} onChange={(e) => setCreateTask(e.target.checked)} className="size-4 accent-white" />
                  Create a task for {deal.ownerName ?? "the owner"}
                </label>
              </>
            ) : null}
            {outcome === "escalate" ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="rv-assignee">Escalate to</Label>
                  <NativeSelect id="rv-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} autoFocus>
                    {deal.escalateTo.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — {p.hint}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rv-esc-due">Needed by</Label>
                  <Input id="rv-esc-due" type="date" value={escDue} min={todayKey} onChange={(e) => setEscDue(e.target.value)} />
                </div>
              </>
            ) : null}
            {outcome === "close_lost" ? (
              <div className="space-y-1.5">
                <Label htmlFor="rv-reason">Lost reason</Label>
                <NativeSelect id="rv-reason" value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus>
                  <option value="">Pick a reason</option>
                  {lostReasons.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="rv-note">{outcome === "escalate" ? "What do you need?" : "Note (optional)"}</Label>
              <Textarea id="rv-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} required={outcome === "escalate"} placeholder={outcome === "escalate" ? "e.g. CEO-to-CEO call to unblock legal" : "Shows in the recap"} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !valid}>
              {pending ? "Saving…" : t.cta} <Kbd className="border-black/30 text-black/60">↵</Kbd>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NextStepFields({
  nextStep,
  setNextStep,
  nextDue,
  setNextDue,
  todayKey,
  hint,
  autoFocus,
}: {
  nextStep: string;
  setNextStep: (v: string) => void;
  nextDue: string;
  setNextDue: (v: string) => void;
  todayKey: string;
  hint?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
      <div className="space-y-1.5">
        <Label htmlFor="rv-next">Next step</Label>
        <Input id="rv-next" value={nextStep} onChange={(e) => setNextStep(e.target.value)} maxLength={500} required minLength={3} autoFocus={autoFocus} placeholder="e.g. Send revised term sheet" />
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rv-next-due">Due</Label>
        <Input id="rv-next-due" type="date" value={nextDue} min={todayKey} onChange={(e) => setNextDue(e.target.value)} required />
      </div>
    </div>
  );
}
