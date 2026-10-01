import { Term } from "@/components/ui/term";
import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { ColorTick } from "@/components/ui/badge";
import { CATEGORY_LABELS, quarterLabel, type Rollup, type WowChange } from "@/lib/forecast/core";
import type { Reconciliation, ReconBucket } from "@/lib/forecast/service";
import { fmtNumber, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { VIZ } from "@/lib/palette";

/** Server-rendered roll-up pieces for /forecast (no hooks). Every number says its basis (PRD §14.1). */

export function BasisNote({ className }: { className?: string }) {
  return (
    <p className={cn("text-[11px] text-muted", className)}>
      Gross = annual value (MUU × $/MUU for MUU motions) · Weighted = gross × probability (approved overrides included, as on Pipelines) · Activation motions carry no $ value.
    </p>
  );
}

export function CategoryTiles({
  rollup,
  quarter,
  nextRollup,
  nextQuarter,
  unscheduled,
  unscheduledHref,
}: {
  rollup: Rollup;
  quarter: string;
  nextRollup: Rollup;
  nextQuarter: string;
  /** Open deals without an expected close date — shown separately, never in commit / best totals. */
  unscheduled?: { deals: number; grossUsd: number; weightedUsd: number };
  unscheduledHref?: string;
}) {
  const cells: { key: "commit" | "best" | "pipeline"; hint: string }[] = [
    { key: "commit", hint: "will close this quarter" },
    { key: "best", hint: "could close with a push" },
    { key: "pipeline", hint: "in play, not likely yet" },
  ];
  const showUnscheduled = unscheduled && unscheduled.deals > 0;
  return (
    <div className={cn("grid grid-cols-1 gap-3", showUnscheduled ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3")}>
      {cells.map((c) => {
        const b = rollup[c.key];
        const n = nextRollup[c.key];
        return (
          <div key={c.key} className="rounded-lg border border-border bg-surface-1 px-5 py-4">
            <p className="flex items-baseline justify-between text-xs font-medium uppercase tracking-wide text-muted">
              <span>
                <Term id={c.key === "pipeline" ? "pipelineCat" : c.key}>{CATEGORY_LABELS[c.key]}</Term>
              </span>
              <span className="normal-case tracking-normal">{quarterLabel(quarter)}</span>
            </p>
            <p className="mt-2 font-display text-[32px] leading-10 text-fg tabular">{fmtUsd(b.grossUsd, { compact: true })}</p>
            <p className="mt-1 text-xs text-muted tabular">
              {fmtNumber(b.deals)} deal{b.deals === 1 ? "" : "s"} · weighted {fmtUsd(b.weightedUsd, { compact: true })}
              {b.unconfirmed ? ` · ${b.unconfirmed} unconfirmed` : ""}
            </p>
            <p className="mt-2 border-t border-border pt-2 text-[11px] text-muted tabular">
              {quarterLabel(nextQuarter)}: {fmtUsd(n.grossUsd, { compact: true })} gross · {fmtNumber(n.deals)} deal{n.deals === 1 ? "" : "s"}
            </p>
            <p className="sr-only">{c.hint}</p>
          </div>
        );
      })}
      {showUnscheduled ? (
        <div className="rounded-lg border border-dashed border-border-strong px-5 py-4">
          <p className="flex items-baseline justify-between text-xs font-medium uppercase tracking-wide text-muted">
            <span>
              <Term id="unscheduled">Unscheduled</Term>
            </span>
            <span className="normal-case tracking-normal">no close date</span>
          </p>
          <p className="mt-2 font-display text-[32px] leading-10 text-fg tabular">{fmtUsd(unscheduled.grossUsd, { compact: true })}</p>
          <p className="mt-1 text-xs text-muted tabular">
            {fmtNumber(unscheduled.deals)} open deal{unscheduled.deals === 1 ? "" : "s"} · <Term id="weighted">weighted</Term> {fmtUsd(unscheduled.weightedUsd, { compact: true })}
          </p>
          <p className="mt-2 border-t border-border pt-2 text-[11px] text-muted">
            Not in Commit or Best case until a close date is set.
            {unscheduledHref ? (
              <>
                {" "}
                <Link href={unscheduledHref} className="text-secondary underline-offset-2 hover:text-fg hover:underline">
                  Set dates
                </Link>
              </>
            ) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export type RollupTableRow = { key: string; label: string; color?: string; href?: string; rollup: Rollup; deltaWeightedUsd: number | null };

export function RollupTable({ title, rows, firstCol, emptyText }: { title: string; rows: RollupTableRow[]; firstCol: string; emptyText?: string }) {
  const total = rows.reduce(
    (a, r) => {
      a.commit += r.rollup.commit.grossUsd;
      a.best += r.rollup.best.grossUsd;
      a.pipeline += r.rollup.pipeline.grossUsd;
      a.weighted += r.rollup.total.weightedUsd;
      a.delta += r.deltaWeightedUsd ?? 0;
      a.unconfirmed += r.rollup.total.unconfirmed;
      a.deals += r.rollup.total.deals;
      return a;
    },
    { commit: 0, best: 0, pipeline: 0, weighted: 0, delta: 0, unconfirmed: 0, deals: 0 },
  );
  const hasDelta = rows.some((r) => r.deltaWeightedUsd != null);
  return (
    <section aria-label={title}>
      <h2 className="mb-2 font-display text-lg text-fg">{title}</h2>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted">{emptyText ?? "Nothing in the forecast window."}</p>
      ) : (
        <>
        {/* Phones (QA MIN-29): one stacked card per row instead of a 640 px table. */}
        <ul className="divide-y divide-border rounded-lg border border-border sm:hidden">
          {rows.map((r) => (
            <li key={r.key} className="px-3 py-2.5">
              <p className="flex items-center gap-2 text-sm">
                {r.color ? <ColorTick color={r.color} /> : null}
                {r.href ? (
                  <Link href={r.href} className="min-w-0 truncate text-fg hover:underline">
                    {r.label}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate text-fg">{r.label}</span>
                )}
                <span className="text-[11px] text-muted">{fmtNumber(r.rollup.total.deals)}</span>
              </p>
              <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs tabular">
                <dt className="text-muted">Commit</dt>
                <dd className="text-right text-body">{fmtUsd(r.rollup.commit.grossUsd, { compact: true })}</dd>
                <dt className="text-muted">Best case</dt>
                <dd className="text-right text-body">{fmtUsd(r.rollup.best.grossUsd, { compact: true })}</dd>
                <dt className="text-muted">Pipeline</dt>
                <dd className="text-right text-body">{fmtUsd(r.rollup.pipeline.grossUsd, { compact: true })}</dd>
                <dt className="text-muted">Weighted</dt>
                <dd className="text-right text-fg">{fmtUsd(r.rollup.total.weightedUsd, { compact: true })}</dd>
                {r.rollup.total.unconfirmed ? (
                  <>
                    <dt className="text-muted">Unconfirmed</dt>
                    <dd className="text-right text-fg">{fmtNumber(r.rollup.total.unconfirmed)}</dd>
                  </>
                ) : null}
              </dl>
            </li>
          ))}
        </ul>
        <div className="hidden overflow-x-auto overscroll-x-contain rounded-lg border border-border sm:block">
          <table className="table-sticky-first w-full min-w-[640px] border-collapse text-[13px] tabular">
            <thead className="bg-surface-1 text-[11px] uppercase tracking-wider text-muted">
              <tr>
                <th className="h-9 px-3 text-left font-medium">{firstCol}</th>
                <th className="px-3 text-right font-medium">Commit</th>
                <th className="px-3 text-right font-medium">Best case</th>
                <th className="px-3 text-right font-medium">Pipeline</th>
                <th className="px-3 text-right font-medium">Weighted</th>
                {hasDelta ? <th className="px-3 text-right font-medium">vs last week</th> : null}
                <th className="px-3 text-right font-medium">Unconfirmed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-border">
                  <td className="h-10 px-3">
                    <span className="flex items-center gap-2">
                      {r.color ? <ColorTick color={r.color} /> : null}
                      {r.href ? (
                        <Link href={r.href} className="text-fg hover:underline">
                          {r.label}
                        </Link>
                      ) : (
                        <span className="text-fg">{r.label}</span>
                      )}
                      <span className="text-[11px] text-muted">{fmtNumber(r.rollup.total.deals)}</span>
                    </span>
                  </td>
                  <td className="px-3 text-right text-body">{fmtUsd(r.rollup.commit.grossUsd, { compact: true })}</td>
                  <td className="px-3 text-right text-body">{fmtUsd(r.rollup.best.grossUsd, { compact: true })}</td>
                  <td className="px-3 text-right text-body">{fmtUsd(r.rollup.pipeline.grossUsd, { compact: true })}</td>
                  <td className="px-3 text-right text-fg">{fmtUsd(r.rollup.total.weightedUsd, { compact: true })}</td>
                  {hasDelta ? (
                    <td className="px-3 text-right">
                      <Delta v={r.deltaWeightedUsd} />
                    </td>
                  ) : null}
                  <td className={cn("px-3 text-right", r.rollup.total.unconfirmed ? "text-fg" : "text-muted")}>{fmtNumber(r.rollup.total.unconfirmed)}</td>
                </tr>
              ))}
              {rows.length > 1 ? (
                <tr className="border-t border-border-strong bg-surface-1 font-medium">
                  <td className="h-10 px-3 text-fg">
                    Total <span className="text-[11px] font-normal text-muted">{fmtNumber(total.deals)}</span>
                  </td>
                  <td className="px-3 text-right text-fg">{fmtUsd(total.commit, { compact: true })}</td>
                  <td className="px-3 text-right text-fg">{fmtUsd(total.best, { compact: true })}</td>
                  <td className="px-3 text-right text-fg">{fmtUsd(total.pipeline, { compact: true })}</td>
                  <td className="px-3 text-right text-fg">{fmtUsd(total.weighted, { compact: true })}</td>
                  {hasDelta ? (
                    <td className="px-3 text-right">
                      <Delta v={total.delta} />
                    </td>
                  ) : null}
                  <td className="px-3 text-right text-fg">{fmtNumber(total.unconfirmed)}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        </>
      )}
      <p className="mt-1.5 text-[11px] text-muted">Commit / Best case / Pipeline in gross; Weighted across all categories incl. Omitted.</p>
    </section>
  );
}

export function Delta({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted">—</span>;
  if (Math.abs(v) < 1) {
    return (
      <span className="inline-flex items-center gap-0.5 text-muted">
        <Minus className="size-3" aria-hidden /> 0
      </span>
    );
  }
  const Up = v > 0;
  const Icon = Up ? ArrowUpRight : ArrowDownRight;
  // Diverging data color (PRD §16A: blue = up, peach = down), never alone: sign + icon + text.
  return (
    <span className="inline-flex items-center gap-0.5 text-body">
      <Icon className="size-3" style={{ color: Up ? VIZ[0] : VIZ[1] }} aria-hidden />
      {Up ? "+" : "−"}
      {fmtUsd(Math.abs(v), { compact: true })}
    </span>
  );
}

export type ChangeRow = { dealId: string; name: string; owner: string | null; pipelineKey: string; change: WowChange; linkable: boolean };

export function ChangesList({ changes, title = "Since last week", hasLastWeek }: { changes: ChangeRow[]; title?: string; hasLastWeek: boolean }) {
  const sorted = [...changes].sort((a, b) => Math.abs(b.change.deltaWeightedUsd) - Math.abs(a.change.deltaWeightedUsd));
  const top = sorted.slice(0, 10);
  const rest = sorted.slice(10, 200);
  const net = changes.reduce((a, c) => a + c.change.deltaWeightedUsd, 0);
  return (
    <section aria-label={title}>
      <h2 className="mb-2 flex items-baseline gap-2 font-display text-lg text-fg">
        {title}
        {hasLastWeek && changes.length ? (
          <span className="font-sans text-xs font-normal text-muted">
            net weighted <Delta v={net} />
          </span>
        ) : null}
      </h2>
      {!hasLastWeek ? (
        <p className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted">
          This is the first recorded forecast week. Week-over-week changes, with reasons, appear from next Monday.
        </p>
      ) : !changes.length ? (
        <p className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted">No material changes since last week.</p>
      ) : (
        <div className="rounded-lg border border-border bg-surface-1">
          <ChangeItems rows={top} />
          {rest.length ? (
            <details className="border-t border-border">
              <summary className="cursor-pointer px-4 py-2 text-xs text-muted hover:text-fg">Show {rest.length} more</summary>
              <ChangeItems rows={rest} />
            </details>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ChangeItems({ rows }: { rows: ChangeRow[] }) {
  return (
    <ul className="divide-y divide-border">
      {rows.map((c) => (
        <li key={c.dealId} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2 text-[13px]">
          <span className="min-w-0 flex-1 basis-48">
            {c.linkable ? (
              <Link href={`/deals/${c.dealId}`} className="text-fg hover:underline">
                {c.name}
              </Link>
            ) : (
              <span className="text-fg">{c.name}</span>
            )}
            <span className="ml-1.5 text-[11px] text-muted">
              {c.pipelineKey}
              {c.owner ? ` · ${c.owner}` : ""}
            </span>
            <span className="block text-xs text-secondary">{c.change.reason}</span>
          </span>
          <span className="tabular">
            <Delta v={c.change.deltaWeightedUsd} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ReconPanel({ recon }: { recon: Reconciliation }) {
  const line = (label: string, b: ReconBucket, hint: string, strong = false) => (
    <tr className="border-t border-border">
      <td data-primary className={cn("h-9 px-3", strong ? "text-fg" : "text-body")}>
        <span className="block">
          {label}
          <span className="block text-[11px] font-normal text-muted">{hint}</span>
        </span>
      </td>
      <td data-label="Deals" className="px-3 text-right text-muted">{fmtNumber(b.deals)}</td>
      <td data-label="Gross" className="px-3 text-right text-body">{fmtUsd(b.grossUsd, { compact: true })}</td>
      <td data-label="Weighted" className={cn("px-3 text-right", strong ? "text-fg" : "text-body")}>{fmtUsd(b.weightedUsd, { compact: true })}</td>
    </tr>
  );
  const sum = recon.inWindow.weightedUsd + recon.closePassed.weightedUsd + recon.beyondWindow.weightedUsd + recon.noCloseDate.weightedUsd;
  const ok = Math.abs(sum - recon.open.weightedUsd) < 1;
  return (
    <details className="rounded-lg border border-border bg-surface-1">
      <summary className="cursor-pointer px-4 py-3 text-sm text-secondary hover:text-fg">
        How this reconciles to Pipelines <span className="text-muted">· open weighted {fmtUsd(recon.open.weightedUsd, { compact: true })}</span>
      </summary>
      <div className="overflow-x-auto border-t border-border">
        <table className="table-cards w-full min-w-[480px] border-collapse text-[13px] tabular">
          <thead className="text-[11px] uppercase tracking-wider text-muted">
            <tr>
              <th className="h-8 px-3 text-left font-medium">Open deals in this view</th>
              <th className="px-3 text-right font-medium">Deals</th>
              <th className="px-3 text-right font-medium">Gross</th>
              <th className="px-3 text-right font-medium">Weighted</th>
            </tr>
          </thead>
          <tbody>
            {line("In the forecast window", recon.inWindow, "close this quarter or next — the numbers above")}
            {line("Close date passed", recon.closePassed, "open deals whose close date is in an earlier quarter — update them")}
            {line("Closes after next quarter", recon.beyondWindow, "not forecast yet")}
            {line("No close date", recon.noCloseDate, "can't be forecast until a date is set")}
            {line("Open pipeline", recon.open, "every open deal in this view, same math as Pipelines (Company view = the Pipelines overview total)", true)}
          </tbody>
        </table>
        {recon.byMotion.length > 1 ? (
          <table className="table-cards w-full min-w-[480px] border-collapse border-t border-border text-[12px] tabular">
            <tbody>
              {recon.byMotion.map((m) => (
                <tr key={m.key} className="border-t border-border first:border-t-0">
                  <td data-primary className="h-8 px-3 text-body">
                    <span className="flex items-center gap-2">
                      <ColorTick color={m.color} /> {m.name}
                    </span>
                  </td>
                  <td data-label="Deals" className="px-3 text-right text-muted">
                    {fmtNumber(m.inWindow.deals)} / {fmtNumber(m.open.deals)} deals in window
                  </td>
                  <td data-label="Weighted" className="px-3 text-right text-body">
                    {fmtUsd(m.inWindow.weightedUsd, { compact: true })} of {fmtUsd(m.open.weightedUsd, { compact: true })} weighted
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted">
          {ok ? "Buckets add up to the open pipeline exactly." : "Buckets differ from the open total by rounding."} Forecast categories never change a deal&apos;s probability.
        </p>
      </div>
    </details>
  );
}
