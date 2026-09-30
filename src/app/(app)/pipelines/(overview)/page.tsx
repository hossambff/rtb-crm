import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { requireUser } from "@/lib/rbac/server";
import { createDealProps, pipelineOverview } from "@/lib/deals/queries";
import { EmptyState, PageHeader, Stat } from "@/components/ui/misc";
import { ColorTick, StatusBadge } from "@/components/ui/badge";
import { CreateDealButton } from "@/components/deals/create-deal-dialog";
import { fmtNumber, fmtUsd } from "@/lib/format";

export const metadata = { title: "Pipelines" };

export default async function PipelinesPage() {
  const user = await requireUser();
  const overview = await pipelineOverview(user);
  const createProps = await createDealProps(user);
  const totals = overview.reduce(
    (a, p) => ({ open: a.open + p.openCount, weighted: a.weighted + (p.unit === "activation" ? 0 : p.weightedUsd), overdue: a.overdue + p.overdueCount, won: a.won + p.wonCount }),
    { open: 0, weighted: 0, overdue: 0, won: 0 },
  );

  return (
    <>
      <PageHeader
        title="Pipelines"
        description="Every motion, one place. Values are annual; gross vs RTB net is always labeled."
        actions={<CreateDealButton {...createProps} />}
      />
      {overview.length === 0 ? (
        <EmptyState title="No pipelines available" description="Your role doesn't have access to any deal pipeline yet. Ask an admin." />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Weighted pipeline (gross)" value={fmtUsd(totals.weighted, { compact: true })} hint="Open deals × probability, all $ motions" />
            <Stat label="Open deals" value={fmtNumber(totals.open)} />
            <Stat label="Won" value={fmtNumber(totals.won)} hint="Won stages incl. migrating / live" />
            <Stat label="Next step overdue" value={fmtNumber(totals.overdue)} hint={totals.overdue ? "Open deals past their next-step due date" : "Nothing slipping"} />
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {overview.map((p) => (
              <Link
                key={p.id}
                href={`/pipelines/${p.key}`}
                className="group flex flex-col rounded-lg border border-border bg-surface-1 p-5 transition-colors duration-150 hover:border-border-strong focus-visible:border-border-strong"
              >
                <div className="flex items-start gap-3">
                  <ColorTick color={p.color} className="mt-1.5 h-5" />
                  <div className="min-w-0 flex-1">
                    <h2 className="font-display text-xl font-medium leading-7 text-fg">{p.name}</h2>
                    <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                      {p.key} · {p.unit === "muu" ? "MUU motion" : p.unit === "usd" ? "$ contract motion" : "Activation program"}
                    </p>
                  </div>
                  <ArrowUpRight className="size-4 text-muted transition-colors group-hover:text-fg" aria-hidden />
                </div>
                {p.description ? <p className="mt-3 line-clamp-2 text-[13px] text-secondary">{p.description}</p> : null}
                <dl className="mt-5 grid grid-cols-3 gap-x-4 gap-y-3 border-t border-border pt-4 tabular">
                  <Metric label="Open" value={fmtNumber(p.openCount)} />
                  <Metric label="Won" value={fmtNumber(p.wonCount)} />
                  {p.unit === "muu" ? (
                    <>
                      <Metric label="MUU" value={fmtNumber(p.muu, { compact: true })} />
                      <Metric label="Gross" value={fmtUsd(p.grossUsd, { compact: true })} />
                      {p.netUsd !== undefined ? <Metric label="RTB net" value={fmtUsd(p.netUsd, { compact: true })} /> : <Metric label="RTB net" value="Hidden" muted />}
                      <Metric label="Weighted" value={fmtUsd(p.weightedUsd, { compact: true })} />
                    </>
                  ) : p.unit === "usd" ? (
                    <>
                      <Metric label="Value" value={fmtUsd(p.grossUsd, { compact: true })} />
                      <Metric label="Weighted" value={fmtUsd(p.weightedUsd, { compact: true })} />
                    </>
                  ) : (
                    <Metric label="Live" value={fmtNumber(p.liveCount)} />
                  )}
                </dl>
                <div className="mt-4 flex min-h-5 items-center gap-2">
                  {p.overdueCount > 0 ? <StatusBadge status="critical" label={`${p.overdueCount} overdue`} /> : <StatusBadge status="good" label="On schedule" />}
                  {!p.perms.canEdit ? <span className="text-[11px] text-muted">View only</span> : null}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Metric({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className={muted ? "text-sm text-muted" : "font-display text-lg leading-6 text-fg"}>{value}</dd>
    </div>
  );
}
