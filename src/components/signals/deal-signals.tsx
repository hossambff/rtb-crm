import Link from "next/link";
import { getCurrentUser } from "@/lib/rbac/server";
import { getAccessibleDeal } from "@/lib/integrations/deal-access";
import { getPrefs } from "@/lib/prefs";
import { listDealSignals } from "@/lib/signals/queries";
import { applyLabel, SIGNAL_LABELS, type SignalKind } from "@/lib/signals/core";
import { formatInTz } from "@/lib/time";
import { StatusBadge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/ui/relative-time";
import { SignalActions } from "./signal-actions";

const STATUS: Record<SignalKind, "good" | "warning" | "serious" | "info"> = {
  advance: "good",
  won: "good",
  close_date: "info",
  stall: "warning",
  risk: "warning",
  lost: "serious",
};

/**
 * Deal page slot (owner WS-C, V2 A4): pending signals detected in emails / calls on this deal, each with one-click Apply
 * (through the gated stage-move service) and Dismiss. Server component; renders nothing when there's nothing to act on
 * or the user can't see the deal (listDealSignals uses dealAccessWhere, so restricted deals stay hidden).
 */
export async function DealSignalsPanel({ dealId }: { dealId: string }) {
  if (!/^[0-9a-f-]{36}$/i.test(dealId)) return null;
  const user = await getCurrentUser();
  if (!user) return null;
  let signals: Awaited<ReturnType<typeof listDealSignals>> = [];
  let canAct = false;
  try {
    const prefs = await getPrefs(user.id);
    if (prefs.autopilot?.emailSignals === false) return null;
    [signals, canAct] = await Promise.all([listDealSignals(user, dealId), getAccessibleDeal(user, dealId, "edit").then(Boolean)]);
  } catch {
    return null;
  }
  if (!signals.length) return null;
  const fmt = (d: Date) => formatInTz(d, user.timezone, "date");

  return (
    <section aria-labelledby={`signals-${dealId}`} className="rounded-lg border border-border bg-surface-1">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <h3 id={`signals-${dealId}`} className="text-xs font-medium uppercase tracking-wider text-muted">
          Signals <span className="tabular text-secondary">({signals.length})</span>
        </h3>
        <p className="hidden text-[11px] text-muted sm:block">Detected in email and calls · nothing changes until you apply</p>
      </header>
      <ul className="divide-y divide-border">
        {signals.map((sig) => {
          const label = applyLabel(sig.kind, sig.suggestedStageName, sig.suggestedCloseDate ? new Date(sig.suggestedCloseDate) : null, fmt);
          return (
            <li key={sig.id} className="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={STATUS[sig.kind]} label={SIGNAL_LABELS[sig.kind]} />
                  <span className="text-xs text-secondary">{sig.rationale}</span>
                </div>
                {sig.quote ? <blockquote className="border-l border-border-strong pl-2 text-xs italic leading-5 text-body">“{sig.quote}”</blockquote> : null}
                <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
                  {sig.sourceHref ? (
                    <Link href={sig.sourceHref} className="hover:text-fg hover:underline">
                      {sig.source === "email" ? "From an email" : "From a call"}
                    </Link>
                  ) : (
                    <span>{sig.source === "email" ? "From an email" : "From a call"}</span>
                  )}
                  <span aria-hidden>·</span>
                  <RelativeTime value={sig.createdAt} />
                  <span aria-hidden>·</span>
                  <span>{sig.engine?.startsWith("ai:") ? "AI" : "Rules"}{sig.confidence != null ? ` ${Math.round(sig.confidence * 100)}%` : ""}</span>
                </p>
              </div>
              {canAct ? <SignalActions id={sig.id} dealId={dealId} label={label} confirm={sig.kind === "won" || sig.kind === "lost" ? `${label}? Close details and gates still apply.` : null} /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
