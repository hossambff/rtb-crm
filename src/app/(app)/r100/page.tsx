import { requireUser } from "@/lib/rbac/server";
import { getR100Program } from "@/lib/r100/queries";
import { fmtNumber, fmtPct } from "@/lib/format";
import { PIPELINE_COLORS } from "@/lib/palette";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader, Stat } from "@/components/ui/misc";
import { BurnUpChart, FunnelChart } from "@/components/r100/charts";
import { R100Table } from "@/components/r100/r100-table";

export const metadata = { title: "Roundtable 100" };

export default async function R100Page({ searchParams }: PageProps<"/r100">) {
  const user = await requireUser();
  const sp = await searchParams;
  const initialQuery = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const initialStage = typeof sp.stage === "string" ? sp.stage.slice(0, 60) : "all";
  const data = await getR100Program(user);
  if (!data) return <EmptyState title="Roundtable 100 pipeline is not configured" description="Ask an admin to run the seed for pipelines." />;
  const progress = Math.min(1, data.liveCount / Math.max(1, data.goal));
  const target = data.funnel.find((f) => f.key === "target")?.count ?? 0;

  return (
    <div>
      <PageHeader
        title="Roundtable 100"
        description="Public companies and token projects with live RTB100 profiles. Live = Profile Activated or Made First Post."
      />

      <section aria-label="Goal tracker" className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="@container min-w-0 rounded-lg border border-border bg-surface-1 px-4 py-4 sm:px-6 sm:py-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Live accounts vs goal</p>
          <p className="mt-2 font-display text-[clamp(2.25rem,16cqi,3rem)] leading-none text-fg tabular">
            {fmtNumber(data.liveCount)}
            <span className="ml-2 align-baseline font-display text-2xl text-muted">/ {fmtNumber(data.goal)}</span>
          </p>
          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={data.liveCount} aria-valuemin={0} aria-valuemax={data.goal} aria-label="Progress to goal">
            <div className="h-full rounded-full" style={{ width: `${progress * 100}%`, background: PIPELINE_COLORS.R100 }} />
          </div>
          <p className="mt-2 text-xs text-muted">
            {fmtPct(progress)} of goal · {fmtNumber(Math.max(0, data.goal - data.liveCount))} to go
          </p>
          <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-border pt-4 text-sm">
            <div>
              <dt className="text-xs text-muted">Participation this month</dt>
              <dd className="mt-1 font-display text-2xl text-fg tabular">
                {fmtNumber(data.participation.participating)}
                <span className="text-base text-muted"> / {fmtNumber(data.participation.inWindow)}</span>
              </dd>
              <p className="text-[11px] text-muted">Live companies in months 1–3 that posted</p>
            </div>
            <div>
              <dt className="text-xs text-muted">At Target</dt>
              <dd className="mt-1 font-display text-2xl text-fg tabular">{fmtNumber(target)}</dd>
              <p className="text-[11px] text-muted">{fmtNumber(data.total)} companies in program</p>
            </div>
          </dl>
        </div>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Burn-up</CardTitle>
              <CardDescription>Cumulative live accounts by first post date, against the goal of {fmtNumber(data.goal)}.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <BurnUpChart data={data.burnUp} goal={data.goal} />
          </CardContent>
        </Card>
      </section>

      <div className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Funnel by stage</CardTitle>
              <CardDescription>Target → Outreach → … → Made First Post (Live). Companies currently in each stage.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <FunnelChart data={data.funnel} />
          </CardContent>
        </Card>
        <div className="grid content-start grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-1">
          <Stat label="Interviews published" value={fmtNumber(data.rows.filter((r) => r.interviews.some((i) => i.status === "published")).length)} hint="Companies with at least one published interview" />
          <Stat label="Bonus eligible" value={fmtNumber(data.rows.filter((r) => r.r100.bonusEligible).length)} hint="Feeds the RTB100 activation commission" />
        </div>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Companies</CardTitle>
            <CardDescription>
              {data.canEditAny ? "Edit stage, first post, participation, posts, profile, interviews and bonus inline." : "Read-only view."} Moving a company to a live stage stamps the first post date if empty.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <R100Table rows={data.rows} stages={data.stages} initialQuery={initialQuery} initialStage={initialStage} />
        </CardContent>
      </Card>
    </div>
  );
}
