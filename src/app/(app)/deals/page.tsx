import { Suspense } from "react";
import { forbidden, redirect } from "next/navigation";
import { can, requireUser, type AppUser } from "@/lib/rbac/server";
import { createDealProps, getStagesByPipeline, listActiveUsers, listVisiblePipelines } from "@/lib/deals/queries";
import { getMyMotions } from "@/lib/prefs";
import { leadWithMotions } from "@/lib/prefs/core";
import { DEAL_SORTS, listDealsAcross, paramsToFilter, type DealSort } from "@/lib/commands/list";
import type { DealFilter } from "@/lib/commands/types";
import { PageHeader, Skeleton } from "@/components/ui/misc";
import { DealsList } from "@/components/deals/list/deals-list";
import { AutoOpenCreateDeal } from "@/components/deals/list/auto-open";
import { resolveListView } from "@/lib/views/queries";

export const metadata = { title: "Deals" };

/** Default owner view (V2 B8 smart defaults): reps → mine, leaders → my team, org-wide roles → everyone. */
function defaultOwner(role: string): "me" | "team" | "all" {
  if (["executive", "admin", "super_admin", "finance"].includes(role)) return "all";
  if (role === "sales_leader") return "team";
  return "me";
}

/** /deals — every motion in one list with row selection and bulk actions (V2 A8, KAN-5). */
export default async function DealsPage({ searchParams }: PageProps<"/deals">) {
  const user = await requireUser();
  const pipes = await listVisiblePipelines(user);
  if (!pipes.length) forbidden();
  const sp = await searchParams;
  // V2 §B8: default view / last-used filters on a bare /deals. "My team" only for sales leaders — executives and admins
  // keep this page's org-wide default (defaultOwner). Empty query only → always redirects to a non-empty one (no loop).
  const viewQs = await resolveListView(user, "deals", sp, { teamValue: user.role === "sales_leader" ? "team" : null });
  if (viewQs) redirect(`/deals${viewQs}`);
  const ownerDefault = defaultOwner(user.role);
  const withDefault = sp.owner ? sp : { ...sp, owner: ownerDefault };
  const filter = paramsToFilter(withDefault, user);
  // Only motions the user can see (the filter can't widen access — dealAccessWhere applies anyway).
  if (filter.pipelineKeys) filter.pipelineKeys = filter.pipelineKeys.filter((k) => pipes.some((p) => p.key === k));
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  const sortRaw = one("sort");
  const sort: DealSort = sortRaw && (DEAL_SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as DealSort) : "weighted";
  const dir = one("dir") === "asc" ? "asc" : "desc";

  const createProps = await createDealProps(user);

  return (
    <>
      <PageHeader
        title="Deals"
        description="Every motion in one list. Select rows for bulk changes — each one is previewed before it runs."
        actions={<AutoOpenCreateDeal {...createProps} size="sm" />}
      />
      <Suspense fallback={<ListSkeleton />}>
        <DealsData user={user} pipes={pipes} filter={filter} sort={sort} dir={dir} page={Number(one("page") ?? 1)} ownerDefault={ownerDefault} />
      </Suspense>
    </>
  );
}

async function DealsData({
  user,
  pipes,
  filter,
  sort,
  dir,
  page: pageNo,
  ownerDefault,
}: {
  user: AppUser;
  pipes: Awaited<ReturnType<typeof listVisiblePipelines>>;
  filter: DealFilter;
  sort: DealSort;
  dir: "asc" | "desc";
  page: number;
  ownerDefault: string;
}) {
  const page = await listDealsAcross(user, filter, { page: pageNo, sort, dir });
  // QA MIN-05: the Motion filter leads with "motions I sell".
  const mine = await getMyMotions(user).catch(() => null);
  const ordered = mine && mine.source !== "all" ? leadWithMotions(pipes, mine.keys) : pipes;
  const stagesBy = await getStagesByPipeline();
  const users = await listActiveUsers();
  const canEnroll = await can(user, "email", "view");
  const canExport = pipes.some((p) => p.perms.canExport) || (await can(user, "export", "export"));
  return (
    <DealsList
      rows={page.rows}
      total={page.total}
      page={page.page}
      pageSize={page.pageSize}
      sort={sort}
      dir={dir}
      filter={filter}
      totals={{ weightedUsd: page.weightedUsd, grossUsd: page.grossUsd }}
      pipelines={ordered.map((p) => ({ key: p.key, name: p.name, color: p.color }))}
      stageGroups={pipes.map((p) => ({ pipelineKey: p.key, pipelineName: p.name, stages: (stagesBy[p.id] ?? []).map((st) => st.name) }))}
      users={users.map((u) => ({ id: u.id, name: u.name }))}
      ownerDefault={ownerDefault}
      canAssign={pipes.some((p) => p.perms.canAssign)}
      canExport={canExport}
      canEnroll={canEnroll}
    />
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading deals" className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-32" />
        ))}
      </div>
      {Array.from({ length: 10 }, (_, i) => (
        <Skeleton key={i} className="h-11" />
      ))}
    </div>
  );
}
