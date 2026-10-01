"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, Lock, RotateCcw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorTick } from "@/components/ui/badge";
import { postRecap, reopenReview } from "@/lib/review/actions";
import { OUTCOME_PAST, OUTCOMES, type Outcome } from "@/lib/review/core";

export type RecapItem = { dealId: string; name: string; pipelineColor: string; restricted: boolean; outcome: Outcome; note: string | null; taskId: string | null };

export function Recap({
  sessionId,
  title,
  dealCount,
  items,
  tasksCreated,
  preview,
  postedId,
  slackReady = false,
}: {
  sessionId: string;
  title: string;
  dealCount: number;
  items: RecapItem[];
  tasksCreated: number;
  preview: string;
  postedId: string | null;
  /** QA MIN-38: only offer Slack when it is configured (otherwise the option and the "posted" toast would lie). */
  slackReady?: boolean;
}) {
  const router = useRouter();
  const [slack, setSlack] = useState(false);
  const [pending, start] = useTransition();
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, items.filter((i) => i.outcome === o).length])) as Record<Outcome, number>;

  function post() {
    start(async () => {
      const res = await postRecap({ sessionId, slack: slackReady && slack });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(slackReady && slack ? "Recap posted to the team feed and Slack." : "Recap posted to the team feed.");
        router.refresh();
      }
    });
  }
  function reopen() {
    start(async () => {
      const res = await reopenReview({ sessionId });
      if (!res.ok) toast.error(res.error);
      else router.refresh();
    });
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/review" className="-my-2 mb-1 inline-flex items-center gap-1 py-2 text-xs text-muted hover:text-fg">
        ← Pipeline review
      </Link>
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Recap</p>
      <h1 className="mt-1 break-words font-display text-2xl font-medium leading-8 text-fg sm:text-[28px] sm:leading-9">{title}</h1>
      <p className="mt-1 text-sm text-muted">
        {items.length} of {dealCount} deals decided · {tasksCreated} task{tasksCreated === 1 ? "" : "s"} created
      </p>

      <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5">
        {OUTCOMES.map((o) => (
          <div key={o} className="bg-surface-1 px-4 py-3 max-sm:last:odd:col-span-2">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">{OUTCOME_PAST[o]}</dt>
            <dd className="mt-1 font-display text-[28px] leading-9 text-fg tabular">{counts[o]}</dd>
          </div>
        ))}
      </dl>

      {items.length ? (
        <ul className="mt-6 divide-y divide-border rounded-lg border border-border bg-surface-1">
          {items.map((i) => (
            <li key={i.dealId} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <ColorTick color={i.pipelineColor} className="mt-1" />
              <div className="min-w-0 flex-1">
                <Link href={`/deals/${i.dealId}`} className="text-fg hover:underline">
                  {i.restricted ? <Lock className="mr-1 inline size-3 text-muted" aria-label="Restricted" /> : null}
                  {i.name}
                </Link>
                {i.note ? <p className="text-xs text-muted [overflow-wrap:anywhere]">{i.note}</p> : null}
              </div>
              <span className="shrink-0 text-xs text-secondary">{OUTCOME_PAST[i.outcome]}</span>
              {i.taskId ? (
                <Link href={`/tasks?task=${i.taskId}`} className="shrink-0 text-xs text-muted hover:text-fg">
                  Task
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-6 text-sm text-muted">No decisions were recorded.</p>
      )}

      <section className="mt-6 rounded-lg border border-border bg-surface-1 p-4" aria-labelledby="recap-share">
        <h2 id="recap-share" className="font-display text-base text-fg">
          Share with the team
        </h2>
        {postedId ? (
          <p className="mt-2 text-sm text-body">
            Posted to the team feed.{" "}
            <Link href="/team?kind=announcement" className="inline-flex items-center gap-1 text-fg underline-offset-4 hover:underline">
              See it <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs text-muted">Restricted deals are never named — only counted.</p>
            <pre className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-bg p-3 font-sans text-sm leading-6 text-body">{preview}</pre>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              {slackReady ? (
                <label className="flex items-center gap-2 text-sm text-body">
                  <input type="checkbox" checked={slack} onChange={(e) => setSlack(e.target.checked)} className="size-4 accent-white" />
                  Also post to Slack
                </label>
              ) : (
                <span />
              )}
              <Button variant="primary" onClick={post} disabled={pending || !items.length}>
                <Send /> {pending ? "Posting…" : "Post recap"}
              </Button>
            </div>
          </>
        )}
      </section>

      <div className="mt-4 flex justify-end">
        <Button variant="ghost" size="sm" onClick={reopen} disabled={pending}>
          <RotateCcw /> Reopen review
        </Button>
      </div>
    </div>
  );
}
