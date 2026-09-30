import { PIPELINE_COLORS } from "@/lib/palette";
import { fmtNumber, fmtPct, fmtUsd } from "@/lib/format";
import { basisLabel } from "@/lib/analytics/filters";
import { dealHref, pageContext } from "@/lib/analytics/page";
import {
  adsRevenue,
  engagedConcentration,
  pendingOverrides,
  pipelineByMotion,
  r100Live,
  snapshotTrend,
  stageDistribution,
  tierDistribution,
  TIER_LABELS,
  topBrands,
  weekAgoWeighted,
  weeklyMovement,
  wonYtd,
} from "@/lib/analytics/executive";
import { pctChange, pivot } from "@/lib/analytics/transforms";
import { BarChart, KpiTile, LineChart, formatValue } from "@/components/charts";
import { ChartGrid, DealLines, KpiGrid, Panel, RankTable, Section } from "@/components/analytics/bits";
import { DataTable } from "@/components/charts/chart-card";

export const metadata = { title: "Executive overview · Analytics" };

export default async function ExecutiveOverviewPage({ searchParams }: PageProps<"/analytics">) {
  const { ctx, now } = await pageContext(searchParams);
  if (!ctx) return null;
  const f = ctx.filters;
  const net = f.basis === "net";
  const [motions, dist, brands, conc, moves, won, pending, r100, ads, trend, weekAgo] = await Promise.all([
    pipelineByMotion(ctx),
    f.pipeline ? stageDistribution(ctx) : tierDistribution(ctx),
    topBrands(ctx, 25),
    engagedConcentration(ctx),
    weeklyMovement(ctx, now),
    wonYtd(ctx, now),
    pendingOverrides(ctx),
    r100Live(ctx, now),
    adsRevenue(ctx, now),
    snapshotTrend(ctx, now).catch(() => null), // optional widgets fail soft
    weekAgoWeighted(ctx, now).catch(() => null),
  ]);

  const sum = (k: keyof (typeof motions)[number]) => motions.reduce((a, m) => a + Number(m[k] ?? 0), 0);
  const weighted = sum(net ? "weightedNet" : "weightedGross");
  const unweighted = sum(net ? "net" : "gross");
  const muuTotal = sum("muu");
  const weightedMuu = sum("weightedMuu");
  const estMuu = sum("estimatedMuu");
  const overrideDelta = sum(net ? "overrideDeltaNet" : "overrideDeltaGross");
  const overriddenDeals = sum("overriddenDeals");
  const moneyLabel = net ? "RTB net" : "Gross";
  const provenance = [
    basisLabel(f),
    muuTotal ? `MUU incl. estimates (${fmtPct(estMuu / muuTotal)} not verified)` : "MUU incl. estimates",
    `${f.overrides ? "incl." : "excl."} manual overrides (${overrideDelta >= 0 ? "+" : "−"}${fmtUsd(Math.abs(overrideDelta), { compact: true })} vs stage probability)`,
  ].join(" · ");
  const wowDelta = weekAgo != null && !net ? pctChange(weighted, weekAgo) : null;

  const motionRows = motions.map((m) => ({ motion: m.key, weighted: net ? m.weightedNet : m.weightedGross, muu: m.weightedMuu }));
  const motionColors = Object.fromEntries(motions.map((m) => [m.key, PIPELINE_COLORS[m.key] ?? m.color]));
  const motionKeys = motions.map((m) => m.key);

  return (
    <div className="space-y-8">
      <KpiGrid>
        <KpiTile
          label="Weighted pipeline"
          value={fmtUsd(weighted, { compact: true })}
          basis={`${moneyLabel} · weighted · ${fmtUsd(unweighted, { compact: true })} unweighted`}
          delta={wowDelta != null ? { text: `${wowDelta >= 0 ? "+" : ""}${fmtPct(wowDelta, 1)} vs last week`, direction: wowDelta > 0 ? "up" : wowDelta < 0 ? "down" : "flat", good: wowDelta >= 0 } : undefined}
        />
        <KpiTile label="Open pipeline MUU" value={fmtNumber(muuTotal, { compact: true })} basis={`${fmtNumber(weightedMuu, { compact: true })} weighted · ${muuTotal ? fmtPct(estMuu / muuTotal) : "—"} estimated`} />
        <KpiTile label="Won YTD" value={fmtUsd(won.value, { compact: true })} basis={`${moneyLabel} · ${won.deals} deals · ${fmtNumber(won.muu, { compact: true })} MUU`} trend={won.valueTrend} />
        <KpiTile
          label="Top-5 concentration"
          value={conc.share == null ? "—" : fmtPct(conc.share)}
          basis={`of engaged weighted (${moneyLabel.toLowerCase()}) · ${conc.accounts} accounts ≥ ${fmtPct(conc.threshold)} stage`}
        />
        <KpiTile
          label="Manual override exposure"
          value={`${overrideDelta >= 0 ? "+" : "−"}${fmtUsd(Math.abs(overrideDelta), { compact: true })}`}
          basis={`${moneyLabel} weighted · ${overriddenDeals} deals overridden${pending ? ` · ${pending} pending approval` : ""}${f.overrides ? "" : " · excluded"}`}
        />
        <KpiTile label="Roundtable 100 live" value={`${r100.live} / ${r100.goal}`} basis={`${fmtPct(r100.goal ? r100.live / r100.goal : 0)} of goal`} trend={r100.trend} trendColor={PIPELINE_COLORS.R100} />
        <KpiTile label="TheStreet annualized" value={fmtUsd(ads.annualized, { compact: true })} basis={`Gross · ${ads.clients} current clients · bookings ${fmtUsd(ads.bookings, { compact: true })} in range`} />
        <KpiTile
          label="Collections"
          value={ads.collected == null ? "—" : fmtUsd(ads.collected, { compact: true })}
          basis={ads.collected == null ? "Requires revenue access" : `Paid in range · overdue AR ${fmtUsd(ads.overdue ?? 0, { compact: true })}`}
        />
      </KpiGrid>

      <Section title="Pipeline by motion" description="Open deals as of now. The date range applies to flows (won, created, moves).">
        <ChartGrid>
          <BarChart
            title={`Weighted pipeline · ${moneyLabel}`}
            description="Open deals × stage probability"
            data={motionRows}
            categoryKey="motion"
            categoryLabel="Motion"
            series={[{ key: "weighted", label: `Weighted ${moneyLabel.toLowerCase()}` }]}
            categoryColors={motionColors}
            format="usdCompact"
            footnote={provenance}
          />
          <BarChart
            title="Weighted MUU"
            description="MUU motions (NetDev, Enterprise, Sports)"
            data={motionRows.filter((r) => r.muu > 0)}
            categoryKey="motion"
            categoryLabel="Motion"
            series={[{ key: "muu", label: "Weighted MUU" }]}
            categoryColors={motionColors}
            format="compact"
            footnote={`MUU incl. estimates · ${f.overrides ? "incl." : "excl."} manual overrides`}
            emptyText="No MUU pipeline in this selection."
          />
        </ChartGrid>
        <div className="rounded-lg border border-border bg-surface-1 px-3 py-2">
          <DataTable
            caption="Pipeline by motion"
            table={{
              columns: [
                { label: "Motion" },
                { label: "Deals", numeric: true },
                { label: "MUU", numeric: true },
                { label: "Weighted MUU", numeric: true },
                { label: "Gross", numeric: true },
                ...(ctx.netAllowed ? [{ label: "RTB net", numeric: true }] : []),
                { label: `Weighted ${moneyLabel.toLowerCase()}`, numeric: true },
                { label: "Override Δ", numeric: true },
              ],
              rows: motions.map((m) => [
                m.name,
                fmtNumber(m.deals),
                m.unit === "muu" ? fmtNumber(m.muu, { compact: true }) : "—",
                m.unit === "muu" ? fmtNumber(m.weightedMuu, { compact: true }) : "—",
                fmtUsd(m.gross, { compact: true }),
                ...(ctx.netAllowed ? [fmtUsd(m.net, { compact: true })] : []),
                fmtUsd(net ? m.weightedNet : m.weightedGross, { compact: true }),
                fmtUsd(net ? m.overrideDeltaNet : m.overrideDeltaGross, { compact: true }),
              ]),
            }}
          />
        </div>
      </Section>

      <ChartGrid>
        {f.pipeline ? (
          <BarChart
            title="Stage distribution"
            description={`${f.pipeline} · open and won stages · weighted ${moneyLabel.toLowerCase()}`}
            data={(dist as Awaited<ReturnType<typeof stageDistribution>>).map((r) => ({ stage: r.stage, weighted: r.weighted, deals: r.deals }))}
            categoryKey="stage"
            categoryLabel="Stage"
            series={[{ key: "weighted", label: `Weighted ${moneyLabel.toLowerCase()}`, color: PIPELINE_COLORS[f.pipeline] }]}
            format="usdCompact"
            footnote={provenance}
            table={{
              columns: [{ label: "Stage" }, { label: "Deals", numeric: true }, { label: "Weighted", numeric: true }],
              rows: (dist as Awaited<ReturnType<typeof stageDistribution>>).map((r) => [r.stage, fmtNumber(r.deals), fmtUsd(r.weighted, { compact: true })]),
            }}
          />
        ) : (
          <BarChart
            title="Tier distribution"
            description={`Open deals by probability tier · unweighted ${moneyLabel.toLowerCase()} by motion`}
            data={TIER_LABELS.slice(0, -1).map((tier) => pivot(dist as Awaited<ReturnType<typeof tierDistribution>>, "tier", "motion", "value", motionKeys).find((r) => r.tier === tier) ?? { tier, ...Object.fromEntries(motionKeys.map((k) => [k, 0])) })}
            categoryKey="tier"
            categoryLabel="Tier"
            series={motionKeys.map((k) => ({ key: k, label: k, color: PIPELINE_COLORS[k] }))}
            orientation="vertical"
            stacked
            totalColumn
            format="usdCompact"
            footnote={provenance}
          />
        )}
        <Panel title="This week" description="New, advanced and slipped deals in the last 7 days (stage history)" footnote={`${moneyLabel} basis · values unweighted`}>
          <div className="grid grid-cols-3 gap-2 border-b border-border pb-3">
            {(
              [
                ["New", moves.created],
                ["Advanced", moves.advanced],
                ["Slipped", moves.slipped],
              ] as const
            ).map(([label, m]) => (
              <div key={label}>
                <p className="text-xs text-secondary">{label}</p>
                <p className="font-display text-2xl text-fg">{m.count}</p>
                <p className="text-[11px] text-muted">{fmtUsd(m.value, { compact: true })}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-x-4 pt-2 md:grid-cols-2">
            <DealLines
              items={moves.advanced.top.map((d) => ({ id: d.id, name: d.name, pipeline: d.pipeline, primary: `${d.from ?? "—"} → ${d.to}`, secondary: d.reason ?? undefined, value: d.value }))}
              format="usdCompact"
              href={dealHref}
              empty="No deals advanced this week."
            />
            <DealLines
              items={moves.slipped.top.map((d) => ({ id: d.id, name: d.name, pipeline: d.pipeline, primary: `${d.from ?? "—"} → ${d.to}`, secondary: d.reason ?? undefined, value: d.value }))}
              format="usdCompact"
              href={dealHref}
              empty="Nothing slipped this week."
            />
          </div>
        </Panel>
      </ChartGrid>

      <Section title="Top 25 brands" description={`Ranked by weighted open value (${moneyLabel.toLowerCase()}). Restricted accounts appear only for their access list.`}>
        <div className="rounded-lg border border-border bg-surface-1 px-4 py-3">
          <RankTable
            format="usdCompact"
            valueLabel={`Weighted ${moneyLabel.toLowerCase()}`}
            columns={["Motions", "Deals", "MUU", "Top stage %"]}
            rows={brands.map((b) => ({
              key: b.accountId,
              label: b.name,
              value: b.weighted,
              cells: [b.motions, fmtNumber(b.deals), b.muu ? fmtNumber(b.muu, { compact: true }) : "—", fmtPct(b.maxProb)],
            }))}
          />
          <p className="mt-2 border-t border-border pt-2 text-[11px] text-muted">{provenance}</p>
        </div>
      </Section>

      {trend ? (
        <LineChart
          title="Weighted pipeline trend"
          description="Nightly snapshots, last 12 weeks, by motion"
          data={pivot(trend, "day", "pipeline", "weighted", motionKeys.length ? motionKeys : Object.keys(PIPELINE_COLORS))}
          xKey="day"
          series={(motionKeys.length ? motionKeys : Object.keys(PIPELINE_COLORS)).map((k) => ({ key: k, label: k, color: PIPELINE_COLORS[k] }))}
          format="usdCompact"
          area
          stacked
          footnote={`Gross basis (snapshot) · ${f.overrides ? "incl." : "excl."} manual overrides · company-wide`}
          emptyText="Snapshots accumulate nightly — the trend appears after the first runs."
        />
      ) : null}

      <p className="text-[11px] text-muted">
        Won and bookings use the {f.range === "ytd" ? "year-to-date" : "selected"} range where noted; open pipeline is live. Values in {moneyLabel.toLowerCase()} unless labelled. Weighted = value × {f.overrides ? "approved override or stage" : "stage"} probability.{" "}
        {ads.scheduled != null ? `Scheduled AR ${formatValue(ads.scheduled, "usdCompact")}.` : ""}
      </p>
    </div>
  );
}
