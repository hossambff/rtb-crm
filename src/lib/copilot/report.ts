/** Pure pipeline aggregation for Copilot's pipeline_report tool and quick actions (unit-tested). */
import { dealValue } from "@/lib/pipeline-math";
import type { PipelineReport, PipelineReportRow } from "./types";

export type ReportDealRow = {
  pipelineKey: string;
  unit: "muu" | "usd" | "activation";
  stageName: string;
  stageSort: number;
  stageCategory: string;
  stageProbability: number;
  ownerName: string | null;
  muu: number | null;
  usdPerMuu: number | null;
  pipelineUsdPerMuu: number | null;
  /** null when hidden for the role — net falls back to the pipeline default share */
  revSharePct: number | null;
  pipelineRevSharePct: number | null;
  contractValueCents: number | null;
  annualizedValueCents: number | null;
  probabilityOverride: number | null;
  overrideStatus: string | null;
};

export function basisLabel(basis: "gross" | "net"): string {
  return basis === "gross"
    ? "GROSS revenue — MUU × $/MUU (annual) for audience pipelines; annualized/contract value for $ pipelines"
    : "RTB NET share — gross × revenue-share % for audience pipelines; $ pipelines count in full";
}

export function aggregatePipeline(
  rows: ReportDealRow[],
  opts: { basis: "gross" | "net"; groupBy: "stage" | "owner" | "category"; includeOverrides: boolean; pipelineKey: string | null; status: "open" | "all"; revShareHidden: boolean },
): PipelineReport {
  const groups = new Map<string, PipelineReportRow & { sort: number }>();
  let overrideDeals = 0;
  const pipelines = new Set<string>(rows.map((r) => r.pipelineKey));
  const empty = (group: string, sort: number) => ({ group, sort, deals: 0, muu: 0, valueUsd: 0, weightedUsd: 0, liveActivations: 0 });
  for (const r of rows) {
    const v = dealValue({
      unit: r.unit,
      muu: r.muu,
      usdPerMuu: r.usdPerMuu,
      pipelineUsdPerMuu: r.pipelineUsdPerMuu,
      revSharePct: opts.revShareHidden ? null : r.revSharePct,
      pipelineRevSharePct: r.pipelineRevSharePct,
      contractValueCents: r.contractValueCents,
      annualizedValueCents: r.annualizedValueCents,
      stageProbability: r.stageProbability,
      probabilityOverride: opts.includeOverrides ? r.probabilityOverride : null,
      overrideStatus: r.overrideStatus,
    });
    if (v.overridden) overrideDeals++;
    const key =
      opts.groupBy === "stage"
        ? (pipelines.size > 1 || !opts.pipelineKey ? `${r.pipelineKey} · ${r.stageName}` : r.stageName)
        : opts.groupBy === "owner"
          ? (r.ownerName ?? "Unassigned")
          : r.stageCategory;
    const sort = opts.groupBy === "stage" ? r.stageSort : 0;
    const g = groups.get(key) ?? empty(key, sort);
    g.deals++;
    g.muu += v.muu;
    g.valueUsd += opts.basis === "gross" ? v.grossUsd : v.netUsd;
    g.weightedUsd += opts.basis === "gross" ? v.weightedGrossUsd : v.weightedNetUsd;
    if (r.unit === "activation" && r.stageCategory === "won") g.liveActivations++;
    groups.set(key, g);
  }
  const pipeOf = (g: string) => (g.includes(" · ") ? g.split(" · ")[0]! : "");
  const list = [...groups.values()].sort((a, b) =>
    opts.groupBy === "stage" ? pipeOf(a.group).localeCompare(pipeOf(b.group)) || a.sort - b.sort : b.valueUsd - a.valueUsd || b.deals - a.deals,
  );
  const totals = list.reduce((t, r) => ({ ...t, deals: t.deals + r.deals, muu: t.muu + r.muu, valueUsd: t.valueUsd + r.valueUsd, weightedUsd: t.weightedUsd + r.weightedUsd, liveActivations: t.liveActivations + r.liveActivations }), empty("Total", 0));
  const notes: string[] = [];
  if (opts.basis === "net" && opts.revShareHidden) notes.push("Deal-level revenue-share terms are hidden for your role; net uses each pipeline's default share.");
  if (opts.includeOverrides && overrideDeals > 0) notes.push(`Includes ${overrideDeals} approved manual probability override(s).`);
  if (!opts.includeOverrides) notes.push("Weighted values use stage probabilities only (manual overrides excluded).");
  if (pipelines.has("R100")) notes.push("Roundtable 100 deals carry no $ value; they count as live activations when won.");
  return {
    basis: opts.basis,
    basisLabel: basisLabel(opts.basis),
    groupBy: opts.groupBy,
    pipelineKey: opts.pipelineKey,
    status: opts.status,
    includeOverrides: opts.includeOverrides,
    overrideDeals,
    rows: list.map((r) => ({ group: r.group, deals: r.deals, muu: r.muu, valueUsd: r.valueUsd, weightedUsd: r.weightedUsd, liveActivations: r.liveActivations })),
    totals: { group: totals.group, deals: totals.deals, muu: totals.muu, valueUsd: totals.valueUsd, weightedUsd: totals.weightedUsd, liveActivations: totals.liveActivations },
    notes,
  };
}
