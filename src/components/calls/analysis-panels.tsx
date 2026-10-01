import { Badge } from "@/components/ui/badge";
import { fmtNumber } from "@/lib/format";
import type { TranscriptAnalysis } from "@/lib/transcripts/analysis-core";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wider text-muted">{title}</h4>
      {children}
    </section>
  );
}

const none = <p className="text-sm text-muted">None found.</p>;

export function SummaryPanel({ a }: { a: TranscriptAnalysis }) {
  const sentiment = a.sentiment > 0.25 ? "Positive" : a.sentiment < -0.25 ? "Negative" : "Neutral";
  return (
    <div className="space-y-5">
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-body marker:text-muted">
        {a.summary.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
        <span>
          Sentiment <span className="text-secondary tabular">{sentiment} ({a.sentiment.toFixed(2)})</span>
        </span>
        <span>
          Engine <span className="text-secondary">{a.engine === "heuristic" ? "Heuristic (AI unavailable)" : a.engine.replace(/^ai:/, "AI · ")}</span>
        </span>
      </div>
      {a.decisions.length ? (
        <Section title="Decisions">
          <ul className="list-disc space-y-1 pl-5 text-sm text-body marker:text-muted">
            {a.decisions.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

export function InsightPanels({ a }: { a: TranscriptAnalysis }) {
  const q = a.qualification;
  const rows: [string, React.ReactNode][] = [
    ["MUU confirmed", q.muu_confirmed ? <span className="tabular">{fmtNumber(q.muu_confirmed)}</span> : null],
    ["Decision maker", q.decision_maker],
    ["Current stack", q.current_stack.length ? q.current_stack.join(", ") : null],
    ["Pain", q.pain.length ? q.pain.join(" · ") : null],
    ["Timeline", q.timeline],
    ["Rev-share appetite", q.rev_share_appetite],
    ["NDA status", q.nda_status],
    ["Migration complexity", q.migration_complexity],
  ];
  return (
    <div className="space-y-5">
      <Section title="Qualification">
        <dl className="divide-y divide-border rounded-md border border-border">
          {rows.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-3 px-3 py-2 text-sm sm:grid-cols-[140px_minmax(0,1fr)]">
              <dt className="text-xs text-muted">{k}</dt>
              <dd className={v ? "min-w-0 break-words text-body" : "text-muted"}>{v ?? "—"}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title="Objections">
        {a.objections.length ? (
          <ul className="space-y-2">
            {a.objections.map((o, i) => (
              <li key={i} className="space-y-1 rounded-md border border-border px-3 py-2 text-sm">
                <p className="text-fg">“{o.objection}”</p>
                {o.response_given ? <p className="text-xs text-secondary">Response given: {o.response_given}</p> : null}
                {o.recommended_rebuttal ? <p className="text-xs text-body">Recommended: {o.recommended_rebuttal}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          none
        )}
      </Section>
      <div className="grid gap-5 sm:grid-cols-2">
        <Section title="Competitors">
          {a.competitors.length ? (
            <div className="flex flex-wrap gap-1.5">
              {a.competitors.map((c) => (
                <Badge key={c}>{c}</Badge>
              ))}
            </div>
          ) : (
            none
          )}
        </Section>
        <Section title="Risks">
          {a.risks.length ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-body marker:text-muted">
              {a.risks.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            none
          )}
        </Section>
      </div>
    </div>
  );
}
