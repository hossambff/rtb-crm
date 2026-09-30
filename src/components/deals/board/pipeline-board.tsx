"use client";
import * as React from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/misc";
import { exportDealsCsv, loadStageDeals } from "@/lib/deals/actions";
import type { ColumnTotals } from "@/lib/deals/board-shape";
import type { BoardDeal, BoardFilters, BoardView, Lane, Picklist, PipelineDTO, StageDTO, UserLite } from "@/lib/deals/types";
import { useStageMove } from "../stage-move";
import { BoardToolbar } from "./board-toolbar";
import { Kanban } from "./kanban";
import { DealsTable, type ServerListPage } from "./deals-table";

/**
 * Client shell for /pipelines/[key]: optimistic Kanban (useOptimistic → auto-rollback when the server action fails),
 * server-trimmed columns with "show more" (KAN-8), list view, URL-persisted filters, CSV export (permissioned server-side).
 */
export function PipelineBoard({
  pipeline,
  stages,
  deals,
  listPage,
  totals,
  filters,
  lane,
  view,
  users,
  assignable,
  categories,
  perms,
  picklists,
  hiddenFields,
  canCreateContact,
  createButton,
}: {
  pipeline: PipelineDTO;
  stages: StageDTO[];
  deals: BoardDeal[];
  /** List view is paginated + sorted server-side (M-20). */
  listPage?: ServerListPage;
  totals: Record<string, ColumnTotals>;
  filters: BoardFilters;
  lane: Lane;
  view: BoardView;
  users: UserLite[];
  assignable: UserLite[];
  categories: string[];
  perms: { canEdit: boolean; canAssign: boolean; canExport: boolean };
  picklists: { lost_reason: Picklist; hold_reason: Picklist };
  hiddenFields: string[];
  canCreateContact: boolean;
  createButton?: React.ReactNode;
}) {
  const stageById = React.useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);

  // Extra cards loaded with "show more"; reset whenever the server sends a fresh board (after a mutation / filter).
  const [extra, setExtra] = React.useState<BoardDeal[]>([]);
  const [prevDeals, setPrevDeals] = React.useState(deals);
  if (prevDeals !== deals) {
    setPrevDeals(deals);
    setExtra([]);
  }
  const merged = React.useMemo(() => {
    if (!extra.length) return deals;
    const ids = new Set(deals.map((d) => d.id));
    return [...deals, ...extra.filter((d) => !ids.has(d.id))];
  }, [deals, extra]);

  const [optimisticDeals, applyMove] = React.useOptimistic(merged, (state: BoardDeal[], m: { dealId: string; stageId: string }) =>
    state.map((d) =>
      d.id === m.dealId
        ? { ...d, stageId: m.stageId, status: stageById.get(m.stageId)?.category ?? d.status, daysInStage: 0, overdueDays: stageById.get(m.stageId)?.category === "open" ? d.overdueDays : 0 }
        : d,
    ),
  );
  // Keep column totals consistent with optimistic moves until the server re-renders.
  const liveTotals = React.useMemo(() => {
    const before = new Map(merged.map((d) => [d.id, d.stageId]));
    const moved = optimisticDeals.filter((d) => before.get(d.id) !== d.stageId);
    if (!moved.length) return totals;
    const next: Record<string, ColumnTotals> = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, { ...v }]));
    const bump = (stageId: string, d: BoardDeal, sign: 1 | -1) => {
      const t = (next[stageId] ??= { count: 0, muu: 0, gross: 0, net: 0, weighted: 0 });
      t.count += sign;
      t.muu += sign * d.muu;
      t.gross += sign * d.grossUsd;
      t.weighted += sign * d.weightedUsd;
      if (t.net !== null && d.netUsd !== undefined) t.net += sign * d.netUsd;
    };
    for (const d of moved) {
      bump(before.get(d.id)!, d, -1);
      bump(d.stageId, d, 1);
    }
    return next;
  }, [merged, optimisticDeals, totals]);

  const { request, dialog } = useStageMove({
    picklists,
    hiddenFields,
    canCreateContact,
    onOptimistic: (dealId, stageId) => applyMove({ dealId, stageId }),
  });

  const [loadingStage, setLoadingStage] = React.useState<string | null>(null);
  const loadMore = async (stageId: string, offset: number) => {
    setLoadingStage(stageId);
    const r = await loadStageDeals({ pipelineKey: pipeline.key, stageId, filters, offset, limit: 100 });
    setLoadingStage(null);
    if (!r.ok) return void toast.error(r.error);
    setExtra((prev) => [...prev, ...r.data]);
  };

  const [exporting, startExport] = React.useTransition();
  const runExport = (dealIds?: string[]) =>
    startExport(async () => {
      const r = await exportDealsCsv({ pipelineKey: pipeline.key, filters, dealIds });
      if (!r.ok) return void toast.error(r.error);
      const blob = new Blob([r.data.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.data.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${r.data.count} deal${r.data.count === 1 ? "" : "s"}`);
    });

  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-4">
      <BoardToolbar
        filters={filters}
        lane={lane}
        view={view}
        users={users}
        categories={categories}
        canExport={perms.canExport}
        onExport={() => runExport()}
        exporting={exporting}
        right={createButton}
      />
      {deals.length === 0 && hasFilters ? (
        <EmptyState title="No deals match these filters" description="Clear a filter or search for something else." />
      ) : view === "list" ? (
        <DealsTable
          pipeline={pipeline}
          stages={stages}
          deals={optimisticDeals}
          serverPage={listPage}
          assignable={assignable}
          canAssign={perms.canAssign}
          canExport={perms.canExport}
          picklists={picklists}
          onExportSelected={(ids) => runExport(ids)}
        />
      ) : (
        <Kanban
          pipeline={pipeline}
          stages={stages}
          deals={optimisticDeals}
          lane={lane}
          totals={liveTotals}
          onMove={(d, s) => request(d, s)}
          onLoadMore={loadMore}
          loadingStage={loadingStage}
        />
      )}
      {dialog}
    </div>
  );
}
