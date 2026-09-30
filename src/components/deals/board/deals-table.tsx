"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  columnVisibilityFeature,
  createColumnHelper,
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, Columns3, Download, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, EmptyState } from "@/components/ui/misc";
import { bulkMoveStage, bulkReassign, updateDealQuick } from "@/lib/deals/actions";
import { needsReason, reasonPicklist } from "@/lib/deals/gates";
import { fmtDate, fmtNumber, fmtUsd } from "@/lib/format";
import { PRIORITY_LABELS, PRIORITY_ORDER, type BoardDeal, type Picklist, type PipelineDTO, type Priority, type StageDTO, type UserLite } from "@/lib/deals/types";
import { cn } from "@/lib/utils";
import { HealthBadge, OwnerStack, RelativeTime, RestrictedLock } from "../deal-bits";
import { StatusBadge } from "@/components/ui/badge";

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
  columnVisibilityFeature,
  rowSelectionFeature,
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});
const helper = createColumnHelper<typeof features, BoardDeal>();

const COLUMN_LABELS: Record<string, string> = {
  account: "Account",
  stage: "Stage",
  owner: "Owner",
  priority: "Priority",
  nextStep: "Next step",
  due: "Due",
  muu: "MUU",
  gross: "Gross",
  net: "Net",
  weighted: "Weighted",
  prob: "Prob.",
  health: "Health",
  days: "Days in stage",
  lastActivity: "Last activity",
};

/** Server-side page of the list view (M-20): rows arrive sorted + paged; sort / page changes go through the URL. */
export type ServerListPage = { page: number; pageSize: number; total: number; sort: string; dir: "asc" | "desc" };

/** Spreadsheet-style deal grid (LIST-1/2): sort, column chooser, inline edit, bulk reassign / stage change / export. */
export function DealsTable({
  pipeline,
  stages,
  deals,
  serverPage,
  assignable,
  canAssign,
  canExport,
  picklists,
  onExportSelected,
}: {
  pipeline: PipelineDTO;
  stages: StageDTO[];
  deals: BoardDeal[];
  serverPage?: ServerListPage;
  assignable: UserLite[];
  canAssign: boolean;
  canExport: boolean;
  picklists: { lost_reason: Picklist; hold_reason: Picklist };
  onExportSelected: (ids: string[]) => void;
}) {
  const stageById = React.useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [localSorting, setLocalSorting] = React.useState<SortingState>([{ id: "weighted", desc: true }]);
  const sorting: SortingState = serverPage ? [{ id: serverPage.sort, desc: serverPage.dir === "desc" }] : localSorting;
  const goTo = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    router.push(`${pathname}?${next.toString()}`);
  };
  const setSorting = (u: SortingState | ((old: SortingState) => SortingState)) => {
    const next = typeof u === "function" ? u(sorting) : u;
    if (!serverPage) return setLocalSorting(next);
    const first = next[0];
    if (first) goTo({ sort: first.id, dir: first.desc ? "desc" : "asc", page: "1" });
  };
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const hasNet = deals.some((d) => d.netUsd !== undefined);

  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.display({
          id: "select",
          enableHiding: false,
          header: ({ table }) => (
            <input
              type="checkbox"
              aria-label="Select all"
              className="size-3.5 accent-white"
              checked={table.getIsAllRowsSelected()}
              ref={(el) => {
                if (el) el.indeterminate = table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected();
              }}
              onChange={table.getToggleAllRowsSelectedHandler()}
            />
          ),
          cell: ({ row }) => (
            <input
              type="checkbox"
              aria-label={`Select ${row.original.name}`}
              className="size-3.5 accent-white"
              checked={row.getIsSelected()}
              disabled={!row.getCanSelect()}
              onChange={row.getToggleSelectedHandler()}
            />
          ),
        }),
        helper.accessor("name", {
          header: "Deal",
          enableHiding: false,
          sortFn: "text",
          cell: ({ row }) => (
            <span className="flex min-w-0 items-center gap-1.5">
              <Link href={`/deals/${row.original.id}`} className="truncate font-medium text-fg hover:underline">
                {row.original.name}
              </Link>
              {row.original.restricted ? <RestrictedLock /> : null}
            </span>
          ),
        }),
        helper.accessor((d) => d.accountName ?? "", { id: "account", header: "Account", sortFn: "text", cell: (c) => <span className="text-secondary">{c.getValue() || "—"}</span> }),
        helper.accessor((d) => stageById.get(d.stageId)?.sortOrder ?? 0, {
          id: "stage",
          header: "Stage",
          cell: ({ row }) => <span className="whitespace-nowrap text-body">{stageById.get(row.original.stageId)?.name ?? "—"}</span>,
        }),
        helper.accessor((d) => d.owners[0]?.name ?? "", {
          id: "owner",
          header: "Owner",
          sortFn: "text",
          cell: ({ row }) =>
            canAssign && row.original.canEdit ? (
              <InlineSelect
                label="Owner"
                value={row.original.ownerId ?? ""}
                options={[
                  ...(!row.original.ownerId ? [{ value: "", label: "Unassigned" }] : []),
                  ...(row.original.ownerId && !assignable.some((u) => u.id === row.original.ownerId)
                    ? [{ value: row.original.ownerId, label: row.original.owners[0]?.name ?? "Current owner" }]
                    : []),
                  ...assignable.map((u) => ({ value: u.id, label: u.name })),
                ]}
                onSave={(v) => save(row.original.id, { ownerId: v })}
              />
            ) : (
              <OwnerStack owners={row.original.owners} />
            ),
        }),
        helper.accessor((d) => (d.priority ? PRIORITY_ORDER[d.priority]! : 9), {
          id: "priority",
          header: "Priority",
          cell: ({ row }) =>
            row.original.canEdit ? (
              <InlineSelect
                label="Priority"
                value={row.original.priority ?? ""}
                options={[{ value: "", label: "—" }, ...Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label }))]}
                onSave={(v) => save(row.original.id, { priority: (v || null) as Priority | null })}
              />
            ) : (
              <span>{row.original.priority ? PRIORITY_LABELS[row.original.priority] : "—"}</span>
            ),
        }),
        helper.accessor((d) => d.nextStep ?? "", {
          id: "nextStep",
          header: "Next step",
          sortFn: "text",
          cell: ({ row }) =>
            row.original.canEdit ? (
              <InlineText value={row.original.nextStep ?? ""} label="Next step" onSave={(v) => save(row.original.id, { nextStep: v || null })} />
            ) : (
              <span className="truncate">{row.original.nextStep ?? "—"}</span>
            ),
        }),
        helper.accessor((d) => (d.nextStepDueAt ? new Date(d.nextStepDueAt).getTime() : Number.MAX_SAFE_INTEGER), {
          id: "due",
          header: "Due",
          cell: ({ row }) => (
            <span className="flex items-center gap-1.5">
              {row.original.canEdit ? (
                <InlineDate value={row.original.nextStepDueAt} label="Next step due" onSave={(v) => save(row.original.id, { nextStepDueAt: v })} />
              ) : (
                <span className="tabular">{fmtDate(row.original.nextStepDueAt, "d MMM")}</span>
              )}
              {row.original.overdueDays > 0 ? <StatusBadge status="critical" label={`${row.original.overdueDays}d`} /> : null}
            </span>
          ),
        }),
        helper.accessor("muu", { header: "MUU", cell: (c) => <span className="tabular">{c.getValue() ? fmtNumber(c.getValue(), { compact: true }) : "—"}</span> }),
        helper.accessor("grossUsd", { id: "gross", header: pipeline.unit === "usd" ? "Value" : "Gross", cell: (c) => <span className="tabular">{fmtUsd(c.getValue(), { compact: true })}</span> }),
        helper.accessor((d) => d.netUsd ?? 0, { id: "net", header: "Net", cell: (c) => <span className="tabular">{fmtUsd(c.getValue(), { compact: true })}</span> }),
        helper.accessor("probability", {
          id: "prob",
          header: "Prob.",
          cell: ({ row }) => (
            <span className="tabular">
              {Math.round(row.original.probability * 100)}%{row.original.overridden ? "*" : ""}
              {row.original.overridePending ? <span className="ml-1 text-[10px] text-muted">pending</span> : null}
            </span>
          ),
        }),
        helper.accessor("weightedUsd", { id: "weighted", header: "Weighted", cell: (c) => <span className="tabular">{fmtUsd(c.getValue(), { compact: true })}</span> }),
        helper.accessor((d) => d.healthScore ?? -1, { id: "health", header: "Health", cell: ({ row }) => <HealthBadge score={row.original.healthScore} explanation={row.original.healthExplanation} /> }),
        helper.accessor("daysInStage", { id: "days", header: "Days", cell: (c) => <span className="tabular">{c.getValue()}</span> }),
        helper.accessor((d) => (d.lastActivityAt ? new Date(d.lastActivityAt).getTime() : 0), {
          id: "lastActivity",
          header: "Last activity",
          cell: ({ row }) => <RelativeTime iso={row.original.lastActivityAt} className="text-muted" />,
        }),
      ]),
    [stageById, assignable, canAssign, pipeline.unit],
  );

  const table = useTable({
    features,
    columns,
    data: deals,
    getRowId: (d) => d.id,
    state: { sorting, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: (row) => row.original.canEdit,
    enableSortingRemoval: false,
    autoResetPageIndex: false,
    manualSorting: Boolean(serverPage),
    manualPagination: Boolean(serverPage),
    initialState: {
      pagination: { pageIndex: 0, pageSize: 100 },
      columnVisibility: {
        muu: pipeline.unit === "muu",
        net: hasNet && pipeline.unit === "muu",
        gross: pipeline.unit !== "activation",
        weighted: pipeline.unit !== "activation",
        prob: pipeline.unit !== "activation",
        lastActivity: false,
        account: true,
      },
    },
  });

  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);

  if (!deals.length) return <EmptyState title="No deals match" description="Try clearing filters or create a new deal." />;

  return (
    <div className="space-y-2">
      <div className="flex min-h-9 flex-wrap items-center gap-2">
        {selectedIds.length ? (
          <BulkBar
            ids={selectedIds}
            stages={stages}
            assignable={assignable}
            canAssign={canAssign}
            canExport={canExport}
            picklists={picklists}
            onClear={() => setRowSelection({})}
            onExport={() => onExportSelected(selectedIds)}
          />
        ) : (
          <p className="text-xs text-muted tabular">
            {serverPage
              ? `${serverPage.total} deal${serverPage.total === 1 ? "" : "s"} · showing ${Math.min(serverPage.total, (serverPage.page - 1) * serverPage.pageSize + 1)}–${Math.min(serverPage.total, serverPage.page * serverPage.pageSize)}`
              : `${deals.length} deal${deals.length === 1 ? "" : "s"}`}{" "}
            · click a cell to edit
          </p>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="ml-auto">
              <Columns3 /> Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {table
              .getAllLeafColumns()
              .filter((c) => c.getCanHide())
              .map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-body hover:bg-surface-3">
                  <input type="checkbox" className="size-3.5 accent-white" checked={c.getIsVisible()} onChange={c.getToggleVisibilityHandler()} />
                  {COLUMN_LABELS[c.id] ?? c.id}
                </label>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[960px] border-collapse text-[13px]">
          <thead className="bg-surface-1">
            {table.getHeaderGroups().map((g) => (
              <tr key={g.id}>
                {g.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  const sortable = h.column.getCanSort() && h.column.id !== "select";
                  return (
                    <th
                      key={h.id}
                      scope="col"
                      aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined}
                      className={cn("h-9 whitespace-nowrap border-b border-border px-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted", h.column.id === "select" ? "w-8" : "")}
                    >
                      {h.isPlaceholder ? null : sortable ? (
                        <button type="button" className="inline-flex items-center gap-1 hover:text-fg" onClick={h.column.getToggleSortingHandler()}>
                          <table.FlexRender header={h} />
                          {sorted === "asc" ? <ArrowUp className="size-3" /> : sorted === "desc" ? <ArrowDown className="size-3" /> : <ChevronsUpDown className="size-3 opacity-40" />}
                        </button>
                      ) : (
                        <table.FlexRender header={h} />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className={cn("border-b border-border last:border-0 hover:bg-surface-1", row.getIsSelected() ? "bg-surface-2/60" : "")}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className={cn("h-10 max-w-64 px-3 align-middle text-body", cell.column.id === "nextStep" ? "min-w-56" : "")}>
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {serverPage && serverPage.total > serverPage.pageSize ? (
        <div className="flex items-center justify-end gap-2 text-xs text-muted tabular">
          <span>
            Page {serverPage.page} of {Math.ceil(serverPage.total / serverPage.pageSize)}
          </span>
          <Button size="sm" variant="secondary" disabled={serverPage.page <= 1} onClick={() => goTo({ page: String(serverPage.page - 1) })}>
            Previous
          </Button>
          <Button size="sm" variant="secondary" disabled={serverPage.page * serverPage.pageSize >= serverPage.total} onClick={() => goTo({ page: String(serverPage.page + 1) })}>
            Next
          </Button>
        </div>
      ) : !serverPage && table.getPageCount() > 1 ? (
        <div className="flex items-center justify-end gap-2 text-xs text-muted tabular">
          <span>
            Page {table.state.pagination.pageIndex + 1} of {table.getPageCount()}
          </span>
          <Button size="sm" variant="secondary" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
            Previous
          </Button>
          <Button size="sm" variant="secondary" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
            Next
          </Button>
        </div>
      ) : null}
      <p className="text-[11px] text-muted">* probability override applied. Weighted = {pipeline.unit === "muu" ? "gross" : "value"} × probability.</p>
    </div>
  );
}

async function save(dealId: string, patch: Parameters<typeof updateDealQuick>[0]["patch"]) {
  const r = await updateDealQuick({ dealId, patch });
  if (!r.ok) toast.error(r.error);
  return r.ok;
}

function InlineText({ value, label, onSave }: { value: string; label: string; onSave: (v: string) => Promise<boolean> }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const [busy, setBusy] = React.useState(false);
  if (!editing) {
    return (
      <button type="button" className="block w-full truncate rounded px-1 py-0.5 text-left hover:bg-surface-2" onClick={() => (setDraft(value), setEditing(true))} aria-label={`Edit ${label}`}>
        {value || <span className="text-muted">Add…</span>}
      </button>
    );
  }
  const commit = async () => {
    if (draft.trim() === value) return setEditing(false);
    setBusy(true);
    const ok = await onSave(draft.trim());
    setBusy(false);
    if (ok) setEditing(false);
  };
  return (
    <Input
      autoFocus
      aria-label={label}
      className="h-7 text-[13px]"
      value={draft}
      disabled={busy}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

function InlineDate({ value, label, onSave }: { value: string | null; label: string; onSave: (v: string | null) => Promise<boolean> }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <input
      type="date"
      aria-label={label}
      disabled={busy}
      className="h-7 rounded border border-transparent bg-transparent px-1 text-[13px] text-body tabular hover:border-border focus:border-border-strong [color-scheme:dark]"
      defaultValue={value ? value.slice(0, 10) : ""}
      onChange={async (e) => {
        setBusy(true);
        await onSave(e.target.value || null);
        setBusy(false);
      }}
    />
  );
}

function InlineSelect({ value, label, options, onSave }: { value: string; label: string; options: { value: string; label: string }[]; onSave: (v: string) => Promise<boolean> }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <select
      aria-label={label}
      disabled={busy}
      className="h-7 max-w-40 rounded border border-transparent bg-transparent px-1 text-[13px] text-body hover:border-border focus:border-border-strong"
      value={value}
      onChange={async (e) => {
        setBusy(true);
        await onSave(e.target.value);
        setBusy(false);
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-surface-2">
          {o.label}
        </option>
      ))}
    </select>
  );
}

function BulkBar({
  ids,
  stages,
  assignable,
  canAssign,
  canExport,
  picklists,
  onClear,
  onExport,
}: {
  ids: string[];
  stages: StageDTO[];
  assignable: UserLite[];
  canAssign: boolean;
  canExport: boolean;
  picklists: { lost_reason: Picklist; hold_reason: Picklist };
  onClear: () => void;
  onExport: () => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [stageId, setStageId] = React.useState("");
  const [reasonCode, setReasonCode] = React.useState("");
  const [reasonText, setReasonText] = React.useState("");
  const stage = stages.find((s) => s.id === stageId);
  const list = stage ? reasonPicklist(stage.category) : null;

  const runMove = () =>
    startTransition(async () => {
      if (!stage) return;
      const r = await bulkMoveStage({ dealIds: ids, toStageId: stage.id, reasonCode: reasonCode || undefined, reasonText: reasonText || undefined });
      if (!r.ok) return void toast.error(r.error);
      const { moved, skipped } = r.data;
      if (skipped.length) toast.warning(`${moved.length} moved · ${skipped.length} skipped`, { description: skipped.slice(0, 4).map((s) => `${s.name}: ${s.reason}`).join("\n") });
      else toast.success(`${moved.length} deal${moved.length === 1 ? "" : "s"} moved to ${stage.name}`);
      setStageId("");
      onClear();
    });

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border-strong bg-surface-2 px-2 py-1">
      <span className="px-1 text-xs font-medium text-fg tabular">{ids.length} selected</span>
      {canAssign ? (
        <NativeSelect
          aria-label="Reassign selected"
          className="h-7 w-auto text-xs"
          value=""
          disabled={pending}
          onChange={(e) => {
            const ownerId = e.target.value;
            if (!ownerId) return;
            startTransition(async () => {
              const r = await bulkReassign({ dealIds: ids, ownerId });
              if (!r.ok) return void toast.error(r.error);
              toast.success(`${r.data.moved.length} reassigned${r.data.skipped.length ? ` · ${r.data.skipped.length} skipped` : ""}`);
              onClear();
            });
          }}
        >
          <option value="">Reassign to…</option>
          {assignable.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </NativeSelect>
      ) : null}
      <NativeSelect aria-label="Move selected to stage" className="h-7 w-auto text-xs" value={stageId} onChange={(e) => setStageId(e.target.value)} disabled={pending}>
        <option value="">Move to stage…</option>
        {stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </NativeSelect>
      {stage && needsReason(stage.category) ? (
        <>
          {list ? (
            <NativeSelect aria-label="Reason" className="h-7 w-auto text-xs" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              <option value="">Reason…</option>
              {picklists[list].map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          ) : null}
          <Input aria-label="Reason details" className="h-7 w-44 text-xs" placeholder={stage.category === "won" ? "Win note (required)" : "Details"} value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
        </>
      ) : null}
      {stage ? (
        <Button
          size="sm"
          variant="primary"
          className="h-7"
          disabled={pending || (!!stage && needsReason(stage.category) && (list ? !reasonCode : reasonText.trim().length < 3))}
          onClick={runMove}
        >
          {pending ? <Loader2 className="animate-spin" /> : null} Apply
        </Button>
      ) : null}
      {canExport ? (
        <Button size="sm" variant="ghost" className="h-7" onClick={onExport}>
          <Download /> Export
        </Button>
      ) : null}
      <Button size="icon-sm" variant="ghost" onClick={onClear} aria-label="Clear selection">
        <X />
      </Button>
    </div>
  );
}
