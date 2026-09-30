import Link from "next/link";
import { notFound, forbidden } from "next/navigation";
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
  listDealsPage,
  pipelinePerms,
  type DealListPage,
  type ListSort,
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
  if (!perms.canView) forbidden(); // NEW-1: real 403
  // QA-19 (Appendix B "Export" row): the org-wide export grant (e.g. Finance) also covers board CSV export.
  const canExport = perms.canExport || (await can(user, "export", "export"));

  const sp = await searchParams;
  const { filters, lane, view } = parseBoardParams(sp);
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  // List view: one server-sorted page of 100 rows + SQL totals (M-20). Board: all cards, trimmed per column below.
  const listOpts = { page: Number(one("page") ?? 1), sort: one("sort") as ListSort | undefined, dir: one("dir") === "asc" ? ("asc" as const) : ("desc" as const) };
  const [stagesBy, loaded, users, assignable, categories, lost, hold, hidden, createProps, canCreateContact] = await allLimited([
    () => getStagesByPipeline(),
    () => (view === "list" ? listDealsPage(user, key, filters, listOpts) : listDealsForBoard(user, key, filters)),
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
  const listPage: DealListPage | null = Array.isArray(loaded) ? null : loaded;
  const deals = Array.isArray(loaded) ? loaded : loaded.deals;
  const open = deals.filter((d) => d.status === "open");
  const sum = (f: (d: (typeof deals)[number]) => number) => open.reduce((a, d) => a + f(d), 0);
  const hasNet = !hidden.has("revSharePct") && open.every((d) => d.netUsd !== undefined);
  const kpi = listPage
    ? { openDeals: listPage.kpis.openDeals, muu: listPage.kpis.muu, gross: listPage.kpis.gross, net: listPage.kpis.net, weighted: listPage.kpis.weighted, won: listPage.kpis.won }
    : { openDeals: open.length, muu: sum((d) => d.muu), gross: sum((d) => d.grossUsd), net: sum((d) => d.netUsd ?? 0), weighted: sum((d) => d.weightedUsd), won: deals.filter((d) => d.status === "won").length };
  // Board ships only the first N cards per column (+ totals over everything); the list view is paginated server-side.
  const totals = columnTotals(deals);
  const shown = listPage ? deals : trimPerStage(deals);
  // Owner filter: active users + anyone who owns a deal on this board (e.g. imported placeholder owners).
  const ownerOptions = [...users];
  const dealOwners = listPage ? listPage.owners : deals.flatMap((d) => d.owners);
  for (const o of dealOwners) if (!ownerOptions.some((u) => u.id === o.id)) ownerOptions.push({ id: o.id, name: o.name, image: o.image });
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
          <Kpi label="Open deals" value={fmtNumber(kpi.openDeals)} />
          {pipeline.unit === "muu" ? <Kpi label="MUU" value={fmtNumber(kpi.muu, { compact: true })} /> : null}
          {pipeline.unit !== "activation" ? <Kpi label={pipeline.unit === "muu" ? "Gross / yr" : "Value"} value={fmtUsd(kpi.gross, { compact: true })} /> : null}
          {pipeline.unit === "muu" && hasNet ? <Kpi label="RTB net" value={fmtUsd(kpi.net, { compact: true })} /> : null}
          {pipeline.unit !== "activation" ? <Kpi label="Weighted" value={fmtUsd(kpi.weighted, { compact: true })} /> : null}
          {pipeline.unit === "activation" ? <Kpi label="Live" value={fmtNumber(kpi.won)} /> : null}
        </dl>
      </div>
      <PipelineBoard
        pipeline={pipeline}
        stages={stages}
        deals={shown}
        listPage={listPage ? { page: listPage.page, pageSize: listPage.pageSize, total: listPage.total, sort: listPage.sort, dir: listPage.dir } : undefined}
        totals={totals}
        filters={filters}
        lane={lane}
        view={view}
        users={ownerOptions}
        assignable={assignable}
        categories={categories}
        perms={{ canEdit: perms.canEdit, canAssign: perms.canAssign, canExport }}
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
