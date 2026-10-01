import { cn } from "@/lib/utils";
import { fmtNumber, fmtUsd } from "@/lib/format";
import { bandText, type Tier } from "@/lib/proposals/docx/tiers";
import type { TermSheetEconomics } from "@/lib/proposals/termsheet";

/** "Partner economics" sidebar: MUU, the applicable tier, shares, and an illustrative annual figure. No hooks. */
export function PartnerEconomics({ e, tiers, className }: { e: TermSheetEconomics; tiers: Tier[]; className?: string }) {
  return (
    <section aria-labelledby="pe-title" className={cn("rounded-lg border border-border bg-surface-1 p-4", className)}>
      <h3 id="pe-title" className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
        Partner economics
      </h3>
      <dl className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <dt className="text-[11px] text-muted">Monthly users</dt>
          <dd className="font-display text-2xl leading-8 text-fg tabular">{e.muu !== null ? fmtNumber(e.muu, { compact: true }) : "—"}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-muted">Applicable tier</dt>
          <dd className="font-display text-2xl leading-8 text-fg tabular">{e.tier ? e.tier.band : "—"}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-muted">Partner share</dt>
          <dd className="text-lg text-fg tabular">{e.tier ? `${e.tier.partnerPct}%` : "—"}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-muted">Roundtable share</dt>
          <dd className="text-lg text-fg tabular">{e.tier ? `${e.tier.rtbPct}%` : "—"}</dd>
        </div>
      </dl>
      {e.overridden ? (
        <p className="mt-2 text-xs text-secondary">
          Tier chosen by the rep. The MUU alone points to {e.impliedTierIndex !== null ? tiers[e.impliedTierIndex]?.label : "no tier"}.
        </p>
      ) : null}
      {!tiers.length ? <p className="mt-2 text-xs text-muted">This template has no revenue-share schedule.</p> : !e.tier && e.muu === null ? <p className="mt-2 text-xs text-muted">Add the deal&apos;s MUU to find its tier.</p> : null}

      {tiers.length ? (
        <ol className="mt-4 space-y-1 border-t border-border pt-3 text-xs">
          {tiers.map((t, i) => (
            <li key={`${t.label}-${i}`} className={cn("flex items-center justify-between gap-2 rounded px-2 py-1", i === e.tierIndex ? "bg-surface-3 text-fg" : "text-secondary")}>
              <span className="tabular">{t.label || bandText(t)}</span>
              <span className="tabular">
                {t.partnerPct}% / {t.rtbPct}%
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="mt-4 border-t border-border pt-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted">Illustrative, per year</p>
        <dl className="mt-2 space-y-1 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="text-secondary">Gross (MUU × ${fmtNumber(e.usdPerMuu)})</dt>
            <dd className="text-fg tabular">{e.muu !== null ? fmtUsd(e.grossUsd, { compact: true }) : "—"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-secondary">Partner</dt>
            <dd className="text-fg tabular">{e.partnerUsd !== null && e.muu !== null ? fmtUsd(e.partnerUsd, { compact: true }) : "—"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-secondary">Roundtable</dt>
            <dd className="text-fg tabular">{e.rtbUsd !== null && e.muu !== null ? fmtUsd(e.rtbUsd, { compact: true }) : "—"}</dd>
          </div>
        </dl>
        <p className="mt-2 text-[11px] leading-4 text-muted">Illustrative only: the pipeline&apos;s $/MUU convention, not a forecast or an offer. Not shown in the document.</p>
      </div>
    </section>
  );
}
