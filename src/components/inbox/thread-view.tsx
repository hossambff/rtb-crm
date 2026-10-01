import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, Lock } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { fmtDate, fmtRelative } from "@/lib/format";
import { stripQuoted } from "@/lib/gmail/parse";
import type { ThreadDetail } from "@/lib/gmail/queries";
import { INTENT_LABELS } from "./inbox-filters";
import { CommitmentList, ReanalyzeButton } from "./commitments";
import { ThreadActions } from "./thread-actions";

function Sentiment({ value }: { value: number }) {
  const label = value > 0.25 ? "Positive" : value < -0.25 ? "Negative" : "Neutral";
  return (
    <span className="text-xs text-muted">
      Sentiment <span className="text-secondary tabular">{label} ({value.toFixed(2)})</span>
    </span>
  );
}

export function ThreadView({ detail, backHref, userEmail, canSend }: { detail: ThreadDetail; backHref: string; userEmail: string; canSend: boolean }) {
  const { thread, messages } = detail;
  const taskStatus = Object.fromEntries(detail.tasks.map((t) => [t.id, t.status]));
  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");
  const replyTo = lastInbound?.fromAddr
    ? [lastInbound.fromAddr]
    : thread.participants.filter((p) => p !== userEmail.toLowerCase()).slice(0, 3);

  return (
    <article aria-labelledby="thread-subject" className="flex flex-col">
      <header className="space-y-3 border-b border-border px-4 py-4 sm:px-5">
        <Link href={backHref} className="-my-2 inline-flex items-center gap-1 py-2 text-xs text-muted hover:text-fg xl:hidden">
          <ChevronLeft className="size-3.5" /> All threads
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 id="thread-subject" className="min-w-0 break-words font-display text-xl leading-7 text-fg">
            {thread.private ? <Lock className="mr-1.5 inline size-4 text-muted" aria-label="Private" /> : null}
            {thread.subject ?? "(no subject)"}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {thread.awaitingReplyFrom === "us" ? <StatusBadge status="warning" label="Reply owed" /> : null}
            {thread.awaitingReplyFrom === "them" ? <Badge>Waiting on them</Badge> : null}
            {thread.aiIntent ? <Badge>{INTENT_LABELS[thread.aiIntent] ?? thread.aiIntent}</Badge> : null}
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <div className="flex gap-1.5">
            <dt className="text-muted">Deal</dt>
            <dd className="text-secondary">
              {thread.dealId ? (
                detail.dealName ? (
                  <Link href={`/deals/${thread.dealId}`} className="text-fg underline-offset-2 hover:underline">
                    {detail.dealName}
                  </Link>
                ) : (
                  "Linked (no access)"
                )
              ) : (
                "Not linked"
              )}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted">Account</dt>
            <dd className="text-secondary">
              {thread.accountId && detail.accountName ? (
                <Link href={`/accounts/${thread.accountId}`} className="hover:text-fg">
                  {detail.accountName}
                </Link>
              ) : (
                "—"
              )}
            </dd>
          </div>
          {!detail.isOwn ? (
            <div className="flex gap-1.5">
              <dt className="text-muted">Mailbox</dt>
              <dd className="text-secondary">{detail.mailboxName}</dd>
            </div>
          ) : null}
        </dl>
        <ThreadActions
          threadId={thread.id}
          dealId={thread.dealId}
          isPrivate={thread.private}
          isOwn={detail.isOwn}
          suggestedDeal={detail.suggestedDeal}
          reply={{ to: replyTo, canSend }}
        />
      </header>

      {thread.private ? (
        <p className="px-4 py-6 text-sm text-muted sm:px-5">This thread is private. Its content isn&apos;t stored and new messages aren&apos;t logged.</p>
      ) : (
        <ol className="divide-y divide-border">
          {messages.map((m) => {
            const a = m.analysis;
            const fresh = stripQuoted(m.bodyText ?? "");
            const hasQuoted = (m.bodyText ?? "").trim().length > fresh.length + 20;
            return (
              <li key={m.id} className="space-y-3 px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                    {m.direction === "outbound" ? (
                      <ArrowUpRight className="size-3.5 text-muted" aria-label="Sent" />
                    ) : (
                      <ArrowDownLeft className="size-3.5 text-muted" aria-label="Received" />
                    )}
                    <span className="break-all font-medium text-fg">{m.fromAddr ?? "Unknown sender"}</span>
                    <span className="min-w-0 break-all text-xs text-muted">→ {[...m.toAddrs, ...m.ccAddrs].slice(0, 4).join(", ")}</span>
                  </p>
                  <time className="text-xs text-muted" dateTime={m.sentAt?.toISOString()} title={fmtDate(m.sentAt, "d MMM yyyy HH:mm")}>
                    {fmtRelative(m.sentAt)}
                  </time>
                </div>
                <div className="whitespace-pre-wrap break-words text-sm leading-6 text-body">{fresh || <span className="text-muted">(no text)</span>}</div>
                {hasQuoted ? (
                  <details className="text-xs text-muted">
                    <summary className="cursor-pointer select-none hover:text-fg">Show quoted text</summary>
                    <div className="mt-2 whitespace-pre-wrap break-words border-l border-border-strong pl-3">{m.bodyText}</div>
                  </details>
                ) : null}

                <section aria-label="AI analysis" className="space-y-2 rounded-md bg-surface-2/40 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Analysis</span>
                    {a && "intent" in a && a.intent ? (
                      <>
                        <span className="text-xs text-secondary">{INTENT_LABELS[a.intent] ?? a.intent}</span>
                        {typeof a.sentiment === "number" ? <Sentiment value={a.sentiment} /> : null}
                        <span className="text-[11px] text-muted">{a.engine === "heuristic" ? "Heuristic" : a.engine?.replace(/^ai:/, "AI · ")}</span>
                      </>
                    ) : (
                      <span className="text-xs text-muted">{m.analyzedAt ? "Couldn't analyze this message." : "Queued for analysis."}</span>
                    )}
                    {detail.isOwn ? <span className="ml-auto"><ReanalyzeButton messageId={m.id} /></span> : null}
                  </div>
                  {a?.progress_signals?.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {a.progress_signals.map((p, i) => (
                        <Badge key={i} title={p.evidence}>
                          {p.type.replace(/_/g, " ")}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {a?.suggested_stage?.stage ? (
                    <p className="text-xs text-secondary">
                      Stage suggestion: <span className="text-fg">{a.suggested_stage.stage}</span>{" "}
                      <span className="text-muted">
                        ({Math.round(a.suggested_stage.confidence * 100)}% · {a.suggested_stage.reason}) — review on the deal; never applied automatically.
                      </span>
                    </p>
                  ) : null}
                  {a?.risk_flags?.length ? (
                    <p className="text-xs text-secondary">
                      Risks: <span className="text-body">{a.risk_flags.join(" · ")}</span>
                    </p>
                  ) : null}
                  {a?.commitments?.length ? (
                    <CommitmentList messageId={m.id} commitments={a.commitments} taskIds={a.taskIds ?? {}} taskStatus={taskStatus} canAct={detail.isOwn} />
                  ) : null}
                </section>
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
}
