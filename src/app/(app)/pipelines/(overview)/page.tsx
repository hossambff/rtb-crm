import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { requireUser } from "@/lib/rbac/server";
import { createDealProps, pipelineOverview } from "@/lib/deals/queries";
import { EmptyState, PageHeader, Stat } from "@/components/ui/misc";
import { ColorTick, StatusBadge } from "@/components/ui/badge";
import { CreateDealButton } from "@/components/deals/create-deal-dialog";
import { fmtNumber, fmtUsd } from "@/lib/format";
import { Term } from "@/components/ui/term";
import { motionTermId } from "@/lib/glossary";
import { getMyMotions } from "@/lib/prefs";

export const metadata = { title: "Pipelines" };

export default async function PipelinesPage({ searchParams }: PageProps<"/pipelines">) {
  const user = await requireUser();
  const sp = await searchParams;
  const [all, createProps, mine] = await Promise.all([pipelineOverview(user), createDealProps(user), getMyMotions(user)]);
  // "Motions I sell" (V2 §B2): lead with the user's motions; one click shows every motion they can see.
  const focused = all.filter((p) => mine.keys.includes(p.key));
  const canFocus = mine.source !== "all" && focused.length > 0 && focused.length < all.length;
  const showAll = sp.motions === "all" || !canFocus;
  const overview = showAll ? all : focused;
  const totals = overview.reduce(
    (a, p) => ({ open: a.open + p.openCount, weighted: a.weighted + (p.unit === "activation" ? 0 : p.weightedUsd), overdue: a.overdue + p.overdueCount, won: a.won + p.wonCount }),
    { open: 0, weighted: 0, overdue: 0, won: 0 },
  );

  return (
    <>
      <PageHeader
        title="Pipelines"
        description={
          canFocus ? (
            <>
              {showAll ? `All ${all.length} motions.` : `Your motions: ${focused.map((p) => p.key).join(", ")}.`}{" "}
              <Link href={showAll ? "/pipelines" : "/pipelines?motions=all"} className="text-secondary underline underline-offset-4 hover:text-fg">
                {showAll ? "Only mine" : `Show all ${all.length}`}
              </Link>
              <span className="text-muted"> · Values are annual; gross vs RTB net is always labeled.</span>
            </>
          ) : (
            "Every motion, one place. Values are annual; gross vs RTB net is always labeled."
          )
        }
        actions={<CreateDealButton {...createProps} />}
      />
      {overview.length === 0 ? (
        <EmptyState
          title="No pipelines available"
          description="Your role doesn't have access to any deal pipeline yet. Ask an admin to grant you a motion."
          action={
            <Link href="/settings#preferences" className="text-sm text-secondary underline underline-offset-4 hover:text-fg">
              Check your preferences
            </Link>
          }
        />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Weighted pipeline (gross)"
              value={fmtUsd(totals.weighted, { compact: true })}
              hint={
                <>
                  <Term id="weighted">Weighted</Term> = open deals × probability, all $ motions
                </>
              }
            />
            <Stat label="Open deals" value={fmtNumber(totals.open)} />
            <Stat label="Won" value={fmtNumber(totals.won)} hint="Won stages incl. migrating / live" />
            <Stat
              label="Next step overdue"
              value={fmtNumber(totals.overdue)}
              hint={
                totals.overdue ? (
                  <>
                    Open deals past their <Term id="nextStep">next-step</Term> due date
                  </>
                ) : (
                  "Nothing slipping"
                )
              }
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {overview.map((p) => {
              const term = motionTermId(p.key);
              return (
                // The card isn't one big link: the jargon labels are <Term> buttons (QA MIN-04), so only the title and
                // arrow navigate.
                <div key={p.id} className="group relative flex flex-col rounded-lg border border-border bg-surface-1 p-5 transition-colors duration-150 hover:border-border-strong">
                  <div className="flex items-start gap-3">
                    <ColorTick color={p.color} className="mt-1.5 h-5" />
                    <div className="min-w-0 flex-1">
                      <h2 className="font-display text-xl font-medium leading-7 text-fg">
                        <Link href={`/pipelines/${p.key}`} className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80">
                          {p.name}
                        </Link>
                      </h2>
                      <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                        {term ? <Term id={term}>{p.key}</Term> : p.key} ·{" "}
                        {p.unit === "muu" ? (
                          <>
                            <Term id="muu">MUU</Term> motion
                          </>
                        ) : p.unit === "usd" ? (
                          "$ contract motion"
                        ) : (
                          "Activation program"
                        )}
                      </p>
                    </div>
                    <Link href={`/pipelines/${p.key}`} aria-label={`Open the ${p.name} board`} className="rounded-sm text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80">
                      <ArrowUpRight className="size-4" aria-hidden />
                    </Link>
                  </div>
                  {p.description ? <p className="mt-3 line-clamp-2 text-[13px] text-secondary">{p.description}</p> : null}
                  <dl className="mt-5 grid grid-cols-3 gap-x-4 gap-y-3 border-t border-border pt-4 tabular">
                    <Metric label="Open" value={fmtNumber(p.openCount)} />
                    <Metric label="Won" value={fmtNumber(p.wonCount)} />
                    {p.unit === "muu" ? (
                      <>
                        <Metric label={<Term id="muu">MUU</Term>} value={fmtNumber(p.muu, { compact: true })} />
                        <Metric label={<Term id="gross">Gross</Term>} value={fmtUsd(p.grossUsd, { compact: true })} />
                        {p.netUsd !== undefined ? (
                          <Metric label={<Term id="rtbNet">RTB net</Term>} value={fmtUsd(p.netUsd, { compact: true })} />
                        ) : (
                          <Metric label={<Term id="rtbNet">RTB net</Term>} value="Hidden" muted />
                        )}
                        <Metric label={<Term id="weighted">Weighted</Term>} value={fmtUsd(p.weightedUsd, { compact: true })} />
                      </>
                    ) : p.unit === "usd" ? (
                      <>
                        <Metric label="Value" value={fmtUsd(p.grossUsd, { compact: true })} />
                        <Metric label={<Term id="weighted">Weighted</Term>} value={fmtUsd(p.weightedUsd, { compact: true })} />
                      </>
                    ) : (
                      <Metric label="Live" value={fmtNumber(p.liveCount)} />
                    )}
                  </dl>
                  <div className="mt-4 flex min-h-5 items-center gap-2">
                    {p.overdueCount > 0 ? <StatusBadge status="critical" label={`${p.overdueCount} overdue`} /> : <StatusBadge status="good" label="On schedule" />}
                    {!p.perms.canEdit ? <span className="text-[11px] text-muted">View only</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

function Metric({ label, value, muted }: { label: React.ReactNode; value: string; muted?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className={muted ? "text-sm text-muted" : "font-display text-lg leading-6 text-fg"}>{value}</dd>
    </div>
  );
}
