"use client";
import * as React from "react";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { refreshAiSummary } from "@/lib/deals/actions";
import type { StoredDealSummary } from "@/lib/deals/summary-core";
import { cn } from "@/lib/utils";
import { AiSummaryBox } from "./ai-summary";
import { useRun } from "./use-run";
import { RelativeTime } from "../deal-bits";

/**
 * Summary-first header (V2 §B6): the Copilot summary in three lines, with the full breakdown (commitments both ways,
 * risks, sources) one click away. Restricted deals are summarized locally, never sent to AI.
 */
export function SummaryCard({ dealId, summary, at, restricted, className }: { dealId: string; summary: StoredDealSummary | { text: string } | null; at: string | null; restricted: boolean; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const [run, pending] = useRun();
  const text = summary ? ("summary" in summary ? summary.summary : summary.text) : null;
  const next = summary && "nextAction" in summary ? summary.nextAction : null;
  return (
    <section aria-labelledby="summary-h" className={cn("relative min-w-0 rounded-lg border border-border bg-surface-1 py-3.5 pl-5 pr-4", className)}>
      <span aria-hidden className="absolute inset-y-3 left-0 w-px bg-white" />
      <div className="flex items-center gap-2">
        <h2 id="summary-h" className="font-display text-base italic text-fg">
          Copilot
        </h2>
        <span className="min-w-0 truncate text-[11px] text-muted">{at ? <RelativeTime iso={at} prefix="updated " /> : "no summary yet"}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Refresh summary"
          disabled={pending}
          onClick={() => run(() => refreshAiSummary({ dealId }), { success: (d) => (d.engine === "heuristic" ? "Summary refreshed (heuristic)" : "Summary refreshed") })}
        >
          {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>
      {text ? (
        <p className={cn("mt-1 text-[13px] leading-5 text-body", open ? "" : "line-clamp-3")}>{text}</p>
      ) : (
        <p className="mt-1 text-[13px] text-muted">
          {pending ? "Writing a summary…" : "Get a three-line read on where this deal stands, what's owed both ways and what to do next."}
        </p>
      )}
      {next && !open ? (
        <p className="mt-1.5 truncate text-[12px] text-secondary" title={next}>
          <span className="text-muted">Next best action · </span>
          {next}
        </p>
      ) : null}
      {summary && "summary" in summary ? (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted transition-colors duration-150 hover:text-fg">
          <ChevronDown className={cn("size-3 transition-transform duration-150", open ? "rotate-180" : "")} aria-hidden />
          {open ? "Less" : "Commitments, risks & sources"}
        </button>
      ) : !summary ? (
        <Button size="sm" variant="secondary" className="mt-2" disabled={pending} onClick={() => run(() => refreshAiSummary({ dealId }), { success: "Summary ready" })}>
          Summarize this deal
        </Button>
      ) : null}
      {open ? (
        <div className="mt-3">
          <AiSummaryBox dealId={dealId} summary={summary} at={at} restricted={restricted} />
        </div>
      ) : null}
    </section>
  );
}
