import Link from "next/link";
import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { listVisiblePipelines } from "@/lib/deals/queries";
import { buildForecast, forecastScopes, unscheduledFor, type ForecastDeal, type ForecastScope } from "@/lib/forecast/service";
import { addToRollup, emptyRollup, quarterLabel, rollUpBy, type Rollup } from "@/lib/forecast/core";
import { formatInTz } from "@/lib/time";
import { PageHeader } from "@/components/ui/misc";
import { ForecastList } from "@/components/forecast/forecast-list";
import { BasisNote, CategoryTiles, ChangesList, ReconPanel, RollupTable, type ChangeRow, type RollupTableRow } from "@/components/forecast/rollup";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CalendarClock } from "lucide-react";
import { ModKey } from "@/components/ui/mod-key";
import { QuotaAttainment, type AttainmentRow } from "@/components/quotas/quota-attainment";
import { revenueQuotas } from "@/lib/quotas/queries";

export const metadata = { title: "Forecast" };

const VIEW_LABELS: Record<ForecastScope, string> = { mine: "My forecast", team: "Team roll-up", company: "Company" };
const LIST_CAP = 300;

export default async function ForecastPage({ searchParams }: PageProps<"/forecast">) {
  const user = await requireUser();
  const pipes = await listVisiblePipelines(user);
  if (!pipes.length) forbidden();
  const scopes = await forecastScopes(user);
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  const requested = one("view") as ForecastScope | undefined;
  const defaultView: ForecastScope = scopes.includes("company") && user.role !== "sales_leader" ? "company" : scopes.includes("team") && user.role === "sales_leader" ? "team" : "mine";
  const view: ForecastScope = requested && scopes.includes(requested) ? requested : defaultView;
  const motion = one("motion")?.toUpperCase().slice(0, 20) || null;
  const ownerParam = one("owner")?.slice(0, 100) || null;

  // First view of the week writes the weekly entries (idempotent); later views refresh changed suggestions only.
  const f = await buildForecast(user, view, { persist: true });
  const { current, next } = f.window;
  const motionMeta = new Map(pipes.map((p) => [p.key, p]));
  const inFilter = (d: { pipelineKey: string; ownerId: string | null }) => (!motion || d.pipelineKey === motion) && (!ownerParam || d.ownerId === ownerParam);
  const deals = f.deals.filter(inFilter);
  const ownerName = new Map(f.owners.map((o) => [o.id, o.name]));

  const rows = deals.map((d) => ({ ...d, category: d.effective }));
  const rollQ = (q: string) => rows.filter((r) => r.period === q).reduce<Rollup>((acc, r) => addToRollup(acc, r), emptyRollup());
  const curR = rollQ(current);
  const nextR = rollQ(next);

  const changes: ChangeRow[] = [
    ...deals.filter((d) => d.change).map((d) => ({ dealId: d.dealId, name: d.name, owner: d.ownerName, pipelineKey: d.pipelineKey, change: d.change!, linkable: true })),
    ...f.removed
      .filter((r) => (!motion || r.pipelineKey === motion) && (!ownerParam || r.ownerId === ownerParam))
      .map((r) => ({ dealId: r.dealId, name: r.name, owner: r.ownerId ? (ownerName.get(r.ownerId) ?? null) : null, pipelineKey: r.pipelineKey, change: r.change, linkable: true })),
  ];
  const deltaBy = (key: (c: { ownerId: string | null; pipelineKey: string }) => string) => {
    const m = new Map<string, number>();
    for (const d of deals) if (d.change) m.set(key(d), (m.get(key(d)) ?? 0) + d.change.deltaWeightedUsd);
    for (const r of f.removed) if (inFilter(r)) m.set(key(r), (m.get(key(r)) ?? 0) + r.change.deltaWeightedUsd);
    return m;
  };

  const qs = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const base: Record<string, string | null> = { view, motion, owner: ownerParam, ...patch };
    for (const [k, v] of Object.entries(base)) if (v) p.set(k, v);
    return `/forecast?${p.toString()}`;
  };

  const byMotionRows = (scopeRows: typeof rows): RollupTableRow[] => {
    const deltas = deltaBy((c) => c.pipelineKey);
    return [...rollUpBy(scopeRows, (r) => r.pipelineKey)]
      .map(([key, rollup]) => ({
        key,
        label: motionMeta.get(key)?.name ?? key,
        color: motionMeta.get(key)?.color,
        href: qs({ motion: key }),
        rollup,
        deltaWeightedUsd: f.hasLastWeek ? (deltas.get(key) ?? 0) : null,
      }))
      .sort((a, b) => (motionMeta.get(a.key) ? pipes.indexOf(motionMeta.get(a.key)!) : 99) - (motionMeta.get(b.key) ? pipes.indexOf(motionMeta.get(b.key)!) : 99));
  };
  const byOwnerRows = (): RollupTableRow[] => {
    const deltas = deltaBy((c) => c.ownerId ?? "none");
    return [...rollUpBy(rows, (r) => r.ownerId ?? "none")]
      .map(([key, rollup]) => ({ key, label: key === "none" ? "Unassigned" : (ownerName.get(key) ?? "Unknown"), href: key === "none" ? undefined : qs({ owner: key }), rollup, deltaWeightedUsd: f.hasLastWeek ? (deltas.get(key) ?? 0) : null }))
      .sort((a, b) => b.rollup.total.weightedUsd - a.rollup.total.weightedUsd);
  };

  // Quota attainment (team onboarding): revenue quotas vs this quarter's commit / best (forecast numbers unchanged).
  const quotaOwners = view === "mine" ? [user.id] : view === "team" && !ownerParam ? f.owners.map((o) => o.id) : [];
  const quotas = await revenueQuotas(quotaOwners, current, motion).catch(() => new Map());
  const attainmentRows: AttainmentRow[] = [];
  if (view === "mine") {
    const q = quotas.get(user.id);
    if (q) attainmentRows.push({ key: user.id, label: "You", quotaUsd: q.usd, proposed: q.proposed, commitUsd: curR.commit.grossUsd, bestUsd: curR.best.grossUsd });
  } else if (view === "team") {
    const byOwner = rollUpBy(
      rows.filter((r) => r.period === current),
      (r) => r.ownerId ?? "none",
    );
    for (const [id, q] of quotas) {
      const r = byOwner.get(id) ?? emptyRollup();
      attainmentRows.push({ key: id, label: ownerName.get(id) ?? "Rep", href: qs({ owner: id }), quotaUsd: q.usd, proposed: q.proposed, commitUsd: r.commit.grossUsd, bestUsd: r.best.grossUsd });
    }
    attainmentRows.sort((a, b) => b.commitUsd / (b.quotaUsd || 1) - a.commitUsd / (a.quotaUsd || 1));
  }

  const pending = deals.filter((d) => d.needsConfirmation && d.canEdit);
  const listDeals = (list: ForecastDeal[]) => [...list].sort((a, b) => b.weightedUsd - a.weightedUsd).slice(0, LIST_CAP);
  const weekLabel = formatInTz(`${f.weekOf}T12:00:00Z`, "UTC", "short");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Forecast"
        description={`Week of ${weekLabel} · ${quarterLabel(current)} and ${quarterLabel(next)} · suggestions from stage, health, activity, signals and close-date slips — your call is what counts.`}
      />
      <nav aria-label="Forecast views" className="-mt-2 flex flex-wrap items-center gap-1 border-b border-border">
        {scopes.map((s) => (
          <Link
            key={s}
            href={`/forecast?view=${s}`}
            aria-current={s === view ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150", s === view ? "border-white text-fg" : "border-transparent text-muted hover:text-fg")}
          >
            {VIEW_LABELS[s]}
            {s === "mine" && view === "mine" && pending.length ? <span className="ml-1.5 rounded-full bg-white px-1.5 text-[10px] font-semibold text-black tabular">{pending.length}</span> : null}
          </Link>
        ))}
        {motion || ownerParam ? (
          <span className="ml-auto flex items-center gap-2 py-2 text-xs text-muted">
            Filtered: {[motion ? (motionMeta.get(motion)?.name ?? motion) : null, ownerParam ? (ownerName.get(ownerParam) ?? "owner") : null].filter(Boolean).join(" · ")}
            <Link href={`/forecast?view=${view}`} className="text-fg underline-offset-4 hover:underline">
              Clear
            </Link>
          </span>
        ) : null}
      </nav>

      {f.recon.noCloseDate.deals + f.recon.closePassed.deals > 0 ? (
        <HygieneCallout
          noClose={f.recon.noCloseDate.deals}
          passed={f.recon.closePassed.deals}
          empty={f.recon.inWindow.deals === 0}
          href={`/deals?owner=${view === "mine" ? "me" : view === "team" ? "team" : "all"}&noclose=1`}
        />
      ) : null}
      <CategoryTiles
        rollup={curR}
        quarter={current}
        nextRollup={nextR}
        nextQuarter={next}
        unscheduled={unscheduledFor(f.recon, motion, ownerParam)}
        unscheduledHref={`/deals?owner=${view === "mine" ? "me" : view === "team" ? "team" : "all"}&noclose=1${motion ? `&motion=${motion}` : ""}`}
      />
      <BasisNote className="-mt-3" />
      {view === "mine" ? <QuotaAttainment title="My quota" quarterLabel={quarterLabel(current)} rows={attainmentRows} /> : null}

      {view === "mine" ? (
        <>
          <section aria-label="Needs your call" className="space-y-2">
            <h2 className="font-display text-lg text-fg">
              Needs your call {pending.length ? <span className="font-sans text-sm text-muted tabular">· {pending.length}</span> : null}
            </h2>
            <ForecastList deals={pending} mode="pending" />
          </section>
          <ChangesList changes={changes} hasLastWeek={f.hasLastWeek} />
          <details className="group rounded-lg">
            <summary className="cursor-pointer text-sm text-secondary hover:text-fg">All my deals in the forecast ({deals.length})</summary>
            <div className="mt-2">
              <ForecastList deals={listDeals(deals)} mode="all" />
            </div>
          </details>
        </>
      ) : null}

      {view === "team" ? (
        <>
          {ownerParam ? (
            <section className="space-y-2" aria-label="Rep deals">
              <h2 className="font-display text-lg text-fg">{ownerName.get(ownerParam) ?? "Rep"}&apos;s deals</h2>
              <ForecastList deals={listDeals(deals)} mode="all" emptyHint="No deals for this rep in the forecast window." />
            </section>
          ) : (
            <RollupTable title="By rep" firstCol="Rep" rows={byOwnerRows()} emptyText="Your team has no deals closing this quarter or next." />
          )}
          <QuotaAttainment title="Quota attainment" quarterLabel={quarterLabel(current)} rows={attainmentRows} />
          <RollupTable title="By motion" firstCol="Motion" rows={byMotionRows(rows)} />
          <ChangesList changes={changes} hasLastWeek={f.hasLastWeek} title="What changed since last week" />
        </>
      ) : null}

      {view === "company" ? (
        <>
          <RollupTable title={`${quarterLabel(current)} by motion`} firstCol="Motion" rows={byMotionRows(rows.filter((r) => r.period === current))} />
          <RollupTable title={`${quarterLabel(next)} by motion`} firstCol="Motion" rows={byMotionRows(rows.filter((r) => r.period === next))} />
          <ChangesList changes={changes} hasLastWeek={f.hasLastWeek} title="What changed since last week" />
          {motion || ownerParam ? (
            <section className="space-y-2" aria-label="Deals">
              <h2 className="font-display text-lg text-fg">Deals {deals.length > LIST_CAP ? <span className="font-sans text-sm text-muted">· top {LIST_CAP} by weighted value</span> : null}</h2>
              <ForecastList deals={listDeals(deals)} mode="all" />
            </section>
          ) : (
            <details className="rounded-lg">
              <summary className="cursor-pointer text-sm text-secondary hover:text-fg">By rep ({f.owners.length})</summary>
              <div className="mt-2">
                <RollupTable title="By rep" firstCol="Rep" rows={byOwnerRows()} />
              </div>
            </details>
          )}
        </>
      ) : null}

      <ReconPanel recon={f.recon} />
    </div>
  );
}

/** The forecast only sees deals with a close date this quarter or next — make the gap (and the fix) obvious. */
function HygieneCallout({ noClose, passed, empty, href }: { noClose: number; passed: number; empty: boolean; href: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3", empty ? "border-border-strong bg-surface-1" : "border-border")}>
      <CalendarClock className="size-5 shrink-0 text-muted" strokeWidth={1.5} aria-hidden />
      <p className="min-w-0 flex-1 text-sm text-body">
        {noClose ? (
          <>
            <span className="text-fg tabular">{noClose.toLocaleString("en-US")}</span> open deal{noClose === 1 ? "" : "s"} {noClose === 1 ? "has" : "have"} no expected close date
          </>
        ) : null}
        {noClose && passed ? " and " : null}
        {passed ? (
          <>
            <span className="text-fg tabular">{passed.toLocaleString("en-US")}</span> {passed === 1 ? "has a close date" : "have close dates"} in an earlier quarter
          </>
        ) : null}
        {empty ? " — so nothing is forecast yet." : noClose + passed === 1 ? " — it isn't in this forecast." : " — they aren't in this forecast."}
        <span className="block text-xs text-muted">Select them on Deals → Close date → “end of quarter” (previewed, undoable), or type it in <ModKey then="K" />.</span>
      </p>
      <Button asChild size="sm" variant={empty ? "primary" : "secondary"}>
        <Link href={href}>Set close dates</Link>
      </Button>
    </div>
  );
}
