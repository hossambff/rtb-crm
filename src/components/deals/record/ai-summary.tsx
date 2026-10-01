"use client";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { refreshAiSummary } from "@/lib/deals/actions";
import type { StoredDealSummary } from "@/lib/deals/summary-core";

import { useRun } from "./use-run";
import { RelativeTime } from "../deal-bits";

/** CARD-2 AI summary: surface-2 box, thin white left rule, "Copilot" label in Playfair italic. */
export function AiSummaryBox({
  dealId,
  summary,
  at,
  restricted,
}: {
  dealId: string;
  summary: StoredDealSummary | { text: string } | null;
  at: string | null;
  restricted: boolean;
}) {
  const [run, pending] = useRun();
  const structured = summary && "summary" in summary ? summary : null;
  const scrollTo = (ref: string) => {
    const el = document.getElementById(ref.replace(":", "-"));
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-1", "ring-white/60");
      setTimeout(() => el.classList.remove("ring-1", "ring-white/60"), 1600);
    }
  };
  return (
    <section className="relative rounded-lg border border-border bg-surface-2 py-4 pl-5 pr-4" aria-labelledby="ai-summary-h">
      <span aria-hidden className="absolute inset-y-3 left-0 w-px bg-white" />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="ai-summary-h" className="font-display text-lg italic text-fg">
          Copilot
        </h2>
        <span className="text-[11px] text-muted">
          {at ? <RelativeTime iso={at} prefix="Updated " /> : "Not generated yet"}
          {structured ? ` · ${structured.engine === "heuristic" ? "heuristic" : structured.engine.replace(/^ai:/, "")}` : ""}
          {restricted ? " · restricted deal: generated locally, never sent to AI" : ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={pending}
          onClick={() => run(() => refreshAiSummary({ dealId }), { success: (d) => (d.engine === "heuristic" ? "Summary refreshed (heuristic)" : "Summary refreshed") })}
        >
          {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
        </Button>
      </div>
      {!summary ? (
        <p className="mt-2 text-sm text-muted">Generate a summary of where this deal stands, open commitments on both sides, risks and the next best action.</p>
      ) : structured ? (
        <div className="mt-2 space-y-3 text-[13px] leading-5">
          <p className="text-body">{structured.summary}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Block title="Last touch" items={[structured.lastTouch]} />
            <Block title="Recommended next action" items={[structured.nextAction]} strong />
            <Block title="We owe" items={structured.ourCommitments} empty="Nothing open" />
            <Block title="They owe" items={structured.theirCommitments} empty="Nothing open" />
          </div>
          {structured.risks.length ? <Block title="Risks" items={structured.risks} /> : null}
          {structured.citations.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted">Sources</span>
              {structured.citations.slice(0, 8).map((c, i) => (
                <button
                  key={`${c.ref}-${i}`}
                  type="button"
                  onClick={() => scrollTo(c.ref)}
                  title={c.quote}
                  className="max-w-56 truncate rounded border border-border-strong px-1.5 py-0.5 text-[11px] text-secondary hover:text-fg"
                >
                  “{c.quote}”
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-[13px] text-body">{"text" in summary ? summary.text : ""}</p>
      )}
    </section>
  );
}

function Block({ title, items, empty, strong }: { title: string; items: string[]; empty?: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted">{title}</p>
      {items.length ? (
        <ul className="mt-1 space-y-0.5">
          {items.map((t, i) => (
            <li key={i} className={strong ? "text-fg" : "text-body"}>
              {items.length > 1 ? "· " : ""}
              {t}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-muted">{empty ?? "—"}</p>
      )}
    </div>
  );
}
