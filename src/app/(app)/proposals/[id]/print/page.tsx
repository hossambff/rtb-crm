import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { audit } from "@/lib/audit";
import { getProposal } from "@/lib/proposals/queries";
import { REVENUE_LINE_LABELS, REVENUE_LINES } from "@/lib/proposals/calc";
import { fmtDate } from "@/lib/format";
import { EmptyState } from "@/components/ui/misc";
import { MaskControls } from "@/components/proposals/mask-controls";

/** Approved claim alternative from the claims library (scripts/seed.ts) — the only wording collateral may use. */
const PROFIT_FLOOR_CLAIM = "Profit floor guarantee subject to contract terms";

export const metadata = { title: "Pro forma one-pager" };

/** $000s with thousands separators, as in the RTB pro forma template. No dashes in client copy (language rule). */
const k = (usd: number) => {
  const v = Math.round(usd / 1000);
  return v < 0 ? `(${Math.abs(v).toLocaleString("en-US")})` : v.toLocaleString("en-US");
};
const m = (usd: number) => `$${(usd / 1_000_000).toFixed(2).replace(/0$/, "")}M`;

export default async function ProposalPrintPage({ params, searchParams }: PageProps<"/proposals/[id]/print">) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await getProposal(user, id);
  if (!d) notFound();
  if (!d.exportable) {
    return (
      <EmptyState
        title="Export blocked"
        description={d.triggers.length ? `This version needs executive approval first: ${d.triggers.join("; ")}.` : "This version can't be exported in its current status."}
        action={
          <Link href={`/proposals/${id}`} className="text-sm text-fg underline">
            Back to the pro forma
          </Link>
        }
      />
    );
  }
  const sp = await searchParams;
  const rawMask = typeof sp.mask === "string" ? sp.mask : "revShare";
  const mask = rawMask === "none" ? [] : rawMask.split(",").filter(Boolean);
  const hide = (key: string) => mask.includes(key);
  await audit({ actorId: user.id, action: "proposal.export_view", entity: "proposal", entityId: id, after: { mask } });

  const { inputs: i, outputs: o, deal } = d;
  const client = deal.accountName ?? deal.name;
  const floor = o.guaranteeFloorAnnual;
  const revenueRows = REVENUE_LINES.filter((l) => i.revenue[l] > 0);
  const funded = [
    ...i.costs.filter((c) => c.rtbFundedPct > 0 && c.amount > 0).map((c) => ({ label: c.label, amount: c.amount * c.rtbFundedPct })),
    ...(o.smAbsorbed > 0 ? [{ label: "Ad sales, marketing and commerce ops (share)", amount: o.smAbsorbed }] : []),
    ...(o.gaAbsorbed > 0 ? [{ label: "Corporate overhead, G&A (share)", amount: o.gaAbsorbed }] : []),
  ];
  const treatment = (pct: number) => (pct >= 1 ? "Roundtable funds" : pct <= 0 ? "Retained" : `${Math.round((1 - pct) * 100)}% retained`);
  // QA-23: guarantee copy uses the approved claim wording (claims library: "Guaranteed to make at least what you make
  // today" is restricted → "Profit floor guarantee subject to contract terms").
  const guaranteeText =
    i.guaranteeType === "none"
      ? "No fee to join"
      : hide("guarantee")
        ? "TBD"
        : i.guaranteeType === "profit_floor"
          ? i.guaranteeAmount > 0
            ? `${m(floor)} per year profit floor, subject to contract terms`
            : PROFIT_FLOOR_CLAIM
          : `${m(i.guaranteeAmount)} per month, subject to contract terms`;

  return (
    <div>
      <style>{`
        .onepager { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        @media print {
          @page { size: letter; margin: 0; }
          html, body { background: #000 !important; }
          body * { visibility: hidden; }
          .onepager, .onepager * { visibility: visible; }
          .onepager { position: absolute; left: 0; top: 0; width: 100%; min-height: 100vh; margin: 0 !important; border: 0 !important; border-radius: 0 !important; }
          .no-print { display: none !important; }
        }
      `}</style>
      <div className="no-print mb-3 flex items-center justify-between">
        <Link href={`/proposals/${id}`} className="text-sm text-secondary hover:text-fg">
          ← Back to v{d.proposal.version}
        </Link>
        <span className="text-xs text-muted">Use your browser&apos;s “Save as PDF”. Background graphics must be on.</span>
      </div>
      <MaskControls active={mask} />

      <article className="onepager mx-auto max-w-[8.5in] rounded-lg border border-border bg-black px-10 py-9 text-white">
        <header className="flex items-start justify-between border-b border-white/30 pb-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-white/60">Partnership pro forma · illustrative</p>
            <h1 className="mt-1 font-display text-[30px] leading-9 text-white">
              {client} <span className="text-white/60">×</span> Roundtable
            </h1>
            {i.scenarioLabel ? <p className="mt-1 text-xs text-white/70">{i.scenarioLabel}</p> : null}
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/roundtable-lockup-white.png" alt="Roundtable" style={{ height: 56, width: "auto" }} />
          <div className="text-right text-[10px] uppercase tracking-[0.15em] text-white/60">
            <p>Version {d.proposal.version}</p>
            <p>{fmtDate(new Date())}</p>
            <p>$000s</p>
          </div>
        </header>

        <p className="mt-5 font-display text-xl leading-7 text-white">
          Same revenue. {m(o.rtbFundedTotal)} less cost.{" "}
          {o.ebitdaMultiple ? `EBITDA ${o.ebitdaMultiple.toFixed(2)}x, before any growth.` : "Before any growth."}
        </p>

        <section className="mt-5 grid grid-cols-4 gap-3">
          <HeroCard label="Cost Roundtable takes on" value={m(o.rtbFundedTotal)} />
          <HeroCard label="EBITDA before revenue share" value={o.ebitdaMultiple ? `${o.ebitdaMultiple.toFixed(2)}x` : m(o.clientEbitdaAfter)} />
          <HeroCard label={i.guaranteeType === "profit_floor" ? "Profit floor" : "Guarantee"} value={guaranteeText} />
          <HeroCard label="Managed migration" value="~30 days" />
        </section>

        <section className="mt-5 grid grid-cols-2 gap-4 text-[11px] leading-4">
          <div className="rounded border border-white/25 p-3">
            <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.15em] text-white/70">What Roundtable takes off your P&amp;L</p>
            <ul className="space-y-1">
              {funded.map((f) => (
                <li key={f.label} className="flex justify-between gap-3">
                  <span className="text-white/85">{f.label}</span>
                  <span className="tabular text-white">{k(f.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded border border-white/25 p-3">
            <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.15em] text-white/70">What stays 100% yours</p>
            <ul className="space-y-1 text-white/85">
              <li>Your brands, domains, newsroom and editorial control</li>
              <li>Your IP, audience and data</li>
              <li>Every revenue line on your P&amp;L, held flat in this view</li>
              <li>No purchase price, no fee to join, no integration cost</li>
            </ul>
          </div>
        </section>

        <table className="mt-5 w-full text-[11px] leading-4 tabular">
          <thead>
            <tr className="border-b border-white/40 text-left text-[10px] uppercase tracking-[0.12em] text-white/60">
              <th className="py-1.5 font-medium">$000s</th>
              <th className="py-1.5 text-right font-medium">Today</th>
              <th className="py-1.5 text-right font-medium">With Roundtable</th>
              <th className="py-1.5 pl-4 font-medium">Treatment</th>
            </tr>
          </thead>
          <tbody>
            {revenueRows.map((l) => (
              <PnlRow key={l} label={REVENUE_LINE_LABELS[l].replace(/ \(out of scope.*\)$/, "")} a={k(i.revenue[l])} b={k(i.revenue[l])} t={i.revShareLines.includes(l) ? "In scope" : "Out of scope, unchanged"} />
            ))}
            <PnlRow strong label="Total revenue" a={k(o.revenueTotal)} b={k(o.revenueTotal)} t="Held flat" />
            {i.costs
              .filter((c) => c.amount > 0)
              .map((c, idx) => (
                <PnlRow key={`${c.label}-${idx}`} label={c.label} a={k(c.amount)} b={k(c.amount * (1 - c.rtbFundedPct))} t={treatment(c.rtbFundedPct)} />
              ))}
            {i.smCost > 0 ? <PnlRow label="Ad sales, marketing and commerce ops" a={k(i.smCost)} b={k(i.smCost * (1 - i.smAbsorbPct))} t={treatment(i.smAbsorbPct)} /> : null}
            {i.gaCost > 0 ? <PnlRow label="Corporate allocation, G&A" a={k(i.gaCost)} b={k(i.gaCost * (1 - i.gaAbsorbPct))} t={treatment(i.gaAbsorbPct)} /> : null}
            <PnlRow strong label="Total operating cost" a={k(o.costsBefore)} b={k(o.costsAfter)} t={`${k(-o.rtbFundedTotal)} (${Math.round((o.rtbFundedTotal / Math.max(1, o.costsBefore)) * 100)}%)`} />
            <PnlRow
              strong
              label="EBITDA before revenue share"
              a={`${k(o.clientEbitdaBefore)} (${(o.marginBefore * 100).toFixed(1)}%)`}
              b={`${k(o.clientEbitdaAfter)} (${(o.marginAfter * 100).toFixed(1)}%)`}
              t=""
            />
            <PnlRow
              label={hide("revShare") ? "Roundtable revenue share (TBD)" : `Roundtable revenue share (${Math.round(i.revSharePct * 100)}%)`}
              a=""
              b={hide("revShare") ? "TBD" : k(-o.rtbShare)}
              t="A subset of the new profit created, never of today's profit"
            />
            <PnlRow
              strong
              label="EBITDA after revenue share"
              a={k(o.clientEbitdaBefore)}
              b={hide("revShare") ? (i.guaranteeType === "profit_floor" && !hide("guarantee") ? `≥ ${k(floor)}` : "TBD") : k(o.clientNetAfterShare)}
              t={i.guaranteeType === "profit_floor" ? PROFIT_FLOOR_CLAIM : ""}
            />
          </tbody>
        </table>

        <div className="mt-4 flex items-center justify-between bg-white px-4 py-2.5 text-black">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">Today&apos;s profit vs new profit created</span>
          <span className="font-display text-lg tabular">
            {k(o.clientEbitdaBefore)} / +{k(o.uplift)}
          </span>
        </div>
        {i.guaranteeType === "profit_floor" ? (
          <p className="mt-3 font-display text-sm italic text-white/90">
            You keep your {k(o.clientEbitdaBefore)} and your share of the {k(o.uplift)}. The floor is a protection, not the expectation.{" "}
            {PROFIT_FLOOR_CLAIM} (trailing twelve months of digital operating profit).
          </p>
        ) : null}

        <section className="mt-4 grid grid-cols-4 gap-3 border-t border-white/30 pt-3 text-[11px]">
          <Term label="Revenue share" value={hide("revShare") ? "TBD" : `${Math.round(i.revSharePct * 100)}% of in-scope revenue`} />
          <Term label="Guarantee" value={guaranteeText} />
          <Term label="Ramp" value={hide("terms") ? "TBD" : i.rampMonths ? `${i.rampMonths} months at 100% to you` : "None"} />
          <Term label="Term" value={hide("terms") ? "TBD" : `${i.termYears} years`} />
        </section>

        {!hide("multiYear") && o.years.length > 1 ? (
          <table className="mt-4 w-full text-[10px] leading-4 tabular">
            <thead>
              <tr className="border-b border-white/40 text-left uppercase tracking-[0.12em] text-white/60">
                <th className="py-1 font-medium">Year</th>
                {o.years.map((y) => (
                  <th key={y.year} className="py-1 text-right font-medium">
                    Y{y.year}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-white/15">
                <td className="py-1 text-white/85">EBITDA before revenue share</td>
                {o.years.map((y) => (
                  <td key={y.year} className="py-1 text-right">
                    {k(y.ebitdaAfter)}
                  </td>
                ))}
              </tr>
              <tr className="border-b border-white/15">
                <td className="py-1 text-white/85">Your EBITDA after revenue share</td>
                {o.years.map((y) => (
                  <td key={y.year} className="py-1 text-right">
                    {hide("revShare") ? "TBD" : k(y.clientNetWithGuarantee)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        ) : null}

        <footer className="mt-6 border-t border-white/30 pt-3 text-[9px] leading-3 text-white/60">
          Illustrative, from public sources and estimates; not an offer, not a projection. Figures in $000s. Revenue is held flat by construction; savings phase in as vendor contracts roll off.
          No CPM or RPM is promised. Roundtable financials are not included.
        </footer>
      </article>
    </div>
  );
}

function HeroCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-white/25 px-3 py-2.5">
      <p className="font-display text-xl leading-6 text-white tabular">{value}</p>
      <p className="mt-1 text-[9px] uppercase tracking-[0.14em] text-white/60">{label}</p>
    </div>
  );
}

function PnlRow({ label, a, b, t, strong }: { label: string; a: string; b: string; t: string; strong?: boolean }) {
  return (
    <tr className={strong ? "border-y border-white/40 font-semibold text-white" : "border-b border-white/10 text-white/85"}>
      <td className="py-1 pr-2">{label}</td>
      <td className="py-1 text-right">{a}</td>
      <td className="py-1 text-right">{b}</td>
      <td className="py-1 pl-4 text-[10px] font-normal text-white/60">{t}</td>
    </tr>
  );
}

function Term({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-[0.14em] text-white/60">{label}</p>
      <p className="mt-0.5 text-white">{value}</p>
    </div>
  );
}
