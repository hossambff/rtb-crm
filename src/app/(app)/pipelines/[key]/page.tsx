import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { can, requireUser } from "@/lib/rbac/server";
import {
  assignableUsers,
  boardCategories,
  createDealProps,
  getPicklist,
  getPipelineByKey,
  getStagesByPipeline,
  listActiveUsers,
  listDealsForBoard,
  pipelinePerms,
} from "@/lib/deals/queries";
import { hiddenDealFields } from "@/lib/deals/service";
import { parseBoardParams } from "@/lib/deals/filters";
import { allLimited } from "@/lib/deals/concurrency";
import { columnTotals, trimPerStage } from "@/lib/deals/board-shape";
import { ColorTick } from "@/components/ui/badge";
import { PipelineBoard } from "@/components/deals/board/pipeline-board";
import { CreateDealButton } from "@/components/deals/create-deal-dialog";
import { fmtNumber, fmtUsd } from "@/lib/format";

export async function generateMetadata({ params }: PageProps<"/pipelines/[key]">) {
  const { key } = await params;
  const p = await getPipelineByKey(key.toUpperCase());
  return { title: p?.name ?? "Pipeline" };
}

export default async function PipelineBoardPage({ params, searchParams }: PageProps<"/pipelines/[key]">) {
  const user = await requireUser();
  const { key: rawKey } = await params;
  const key = rawKey.toUpperCase();
  const pipeline = await getPipelineByKey(key);
  if (!pipeline) notFound();
  const perms = await pipelinePerms(user, key);
  if (!perms.canView) notFound();

  const { filters, lane, view } = parseBoardParams(await searchParams);
  const [stagesBy, deals, users, assignable, categories, lost, hold, hidden, createProps, canCreateContact] = await allLimited([
    () => getStagesByPipeline(),
    () => listDealsForBoard(user, key, filters),
    () => listActiveUsers(),
    () => assignableUsers(user, key),
    () => boardCategories(user, pipeline.id),
    () => getPicklist("lost_reason"),
    () => getPicklist("hold_reason"),
    () => hiddenDealFields(user.role),
    () => createDealProps(user),
    () => can(user, "contacts", "create"),
  ], 2);
  const stages = stagesBy[pipeline.id] ?? [];
  const open = deals.filter((d) => d.status === "open");
  const sum = (f: (d: (typeof deals)[number]) => number) => open.reduce((a, d) => a + f(d), 0);
  const hasNet = open.every((d) => d.netUsd !== undefined);
  // Board ships only the first N cards per column (+ totals over everything); list view needs all rows for sorting.
  const totals = columnTotals(deals);
  const shown = view === "list" ? deals : trimPerStage(deals);
  // Owner filter: active users + anyone who owns a deal on this board (e.g. imported placeholder owners).
  const ownerOptions = [...users];
  for (const d of deals) for (const o of d.owners) if (!ownerOptions.some((u) => u.id === o.id)) ownerOptions.push({ id: o.id, name: o.name, image: o.image });
  ownerOptions.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/pipelines" className="mb-1 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
            <ChevronLeft className="size-3.5" /> Pipelines
          </Link>
          <h1 className="flex items-center gap-2.5 font-display text-[28px] font-medium leading-9 text-fg">
            <ColorTick color={pipeline.color} className="h-6" />
            {pipeline.name}
          </h1>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-right tabular">
          <Kpi label="Open deals" value={fmtNumber(open.length)} />
          {pipeline.unit === "muu" ? <Kpi label="MUU" value={fmtNumber(sum((d) => d.muu), { compact: true })} /> : null}
          {pipeline.unit !== "activation" ? <Kpi label={pipeline.unit === "muu" ? "Gross / yr" : "Value"} value={fmtUsd(sum((d) => d.grossUsd), { compact: true })} /> : null}
          {pipeline.unit === "muu" && hasNet ? <Kpi label="RTB net" value={fmtUsd(sum((d) => d.netUsd ?? 0), { compact: true })} /> : null}
          {pipeline.unit !== "activation" ? <Kpi label="Weighted" value={fmtUsd(sum((d) => d.weightedUsd), { compact: true })} /> : null}
          {pipeline.unit === "activation" ? <Kpi label="Live" value={fmtNumber(deals.filter((d) => d.status === "won").length)} /> : null}
        </dl>
      </div>
      <PipelineBoard
        pipeline={pipeline}
        stages={stages}
        deals={shown}
        totals={totals}
        filters={filters}
        lane={lane}
        view={view}
        users={ownerOptions}
        assignable={assignable}
        categories={categories}
        perms={{ canEdit: perms.canEdit, canAssign: perms.canAssign, canExport: perms.canExport }}
        picklists={{ lost_reason: lost, hold_reason: hold }}
        hiddenFields={[...hidden]}
        canCreateContact={canCreateContact}
        createButton={<CreateDealButton {...createProps} defaultPipelineKey={key} size="sm" />}
      />
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className="font-display text-2xl leading-8 text-fg">{value}</dd>
    </div>
  );
}
