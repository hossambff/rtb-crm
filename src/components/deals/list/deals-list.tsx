"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, CalendarClock, ChevronLeft, ChevronRight, Command as CommandIcon, Download, Loader2, Lock, Search, Send, Tag, UserRound, Workflow, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { ColorTick, StatusBadge } from "@/components/ui/badge";
import { EmptyState, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/misc";
import { exportDealsAction, previewCommand } from "@/lib/commands/actions";
import { setDealSelection } from "@/lib/commands/selection";
import { listHref } from "@/lib/views/core";
import { SavedViewsMenu } from "@/components/views/saved-views-menu";
import { MAX_COMMAND_RECORDS, type Command, type DealFilter, type Preview } from "@/lib/commands/types";
import { ShareDealsButton } from "@/components/share/share-dialog";
import type { DealRow, DealSort } from "@/lib/commands/list";
import { getEnrollOptions } from "@/lib/sequences/actions";
import { fmtDate, fmtUsd } from "@/lib/format";
import { healthStatus } from "@/lib/palette";
import { cn } from "@/lib/utils";
import { FilterSheet } from "@/components/ui/filter-sheet";
import { CommandPreviewDialog } from "./command-preview";

type StageGroup = { pipelineKey: string; pipelineName: string; stages: string[] };
type Opt = { id: string; name: string };

/**
 * /deals — every motion in one list (V2 A8 + KAN-5): URL filters, server sort + pagination, row selection (incl.
 * "select all N matching"), and a bulk bar (stage · owner · tag · sequence · export). Every bulk change goes through
 * the same preview → confirm → undo flow as ⌘K commands.
 */
export function DealsList({
  rows,
  total,
  page,
  pageSize,
  sort,
  dir,
  filter,
  totals,
  pipelines,
  stageGroups,
  users,
  ownerDefault,
  canAssign,
  canExport,
  canEnroll,
}: {
  rows: DealRow[];
  total: number;
  page: number;
  pageSize: number;
  sort: DealSort;
  dir: "asc" | "desc";
  filter: DealFilter;
  totals: { weightedUsd: number; grossUsd: number };
  pipelines: { key: string; name: string; color: string }[];
  stageGroups: StageGroup[];
  users: Opt[];
  ownerDefault: string;
  canAssign: boolean;
  canExport: boolean;
  canEnroll: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [navPending, startNav] = React.useTransition();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = React.useState(false);
  const [q, setQ] = React.useState(filter.text ?? "");
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);

  // A new page/filter clears the selection (rows changed under it).
  const rowKey = rows.map((r) => r.id).join(",");
  const [seenKey, setSeenKey] = React.useState(rowKey);
  if (seenKey !== rowKey) {
    setSeenKey(rowKey);
    setSelected(new Set());
    setAllMatching(false);
  }
  React.useEffect(() => {
    setDealSelection(allMatching ? [] : [...selected]);
  }, [selected, allMatching]);
  React.useEffect(() => () => setDealSelection([]), []);

  const go = React.useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      if (!("page" in patch)) next.delete("page");
      const qs = next.toString();
      startNav(() => router.replace(listHref(pathname, qs), { scroll: false }));
    },
    [pathname, router, sp],
  );
  React.useEffect(() => {
    if ((filter.text ?? "") === q.trim()) return;
    const t = setTimeout(() => go({ q: q.trim() || null }), 300);
    return () => clearTimeout(t);
  }, [q, filter.text, go]);

  // Keyboard: "/" focuses search, Esc clears the selection.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && !typing && (selected.size || allMatching)) {
        setSelected(new Set());
        setAllMatching(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size, allMatching]);

  const pageIds = rows.map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const count = allMatching ? total : selected.size;
  const targetFilter: DealFilter = allMatching ? filter : { ids: [...selected], status: "any" };

  const openPreview = async (command: Command, label: string) => {
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    setPreviewOpen(true);
    const r = await previewCommand({ command, label });
    setPreviewLoading(false);
    if (!r.ok) return setPreviewError(r.error);
    setPreview(r.data);
  };

  const runExport = async () => {
    setExporting(true);
    const r = await exportDealsAction({ filter: targetFilter });
    setExporting(false);
    if (!r.ok) return void toast.error(r.error);
    const blob = new Blob([r.data.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = r.data.filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${r.data.count} deal${r.data.count === 1 ? "" : "s"}`, { description: "Restricted deals are never exported." });
  };

  const sortBy = (key: DealSort) => go({ sort: key, dir: sort === key && dir === "desc" ? "asc" : "desc" });
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const ownerValue = sp.get("owner") ?? ownerDefault;
  // Phones: search + Overdue stay visible; everything else lives in the Filters sheet.
  const SECONDARY = ["motion", "stage", "owner", "idle", "status", "nonext", "noclose"] as const;
  const secondaryCount = SECONDARY.filter((k) => sp.get(k)).length;

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2" aria-busy={navPending}>
        <div className="relative min-w-0 flex-1 basis-40 sm:w-64 sm:flex-none sm:basis-auto">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" aria-hidden />
          <Input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search deals or accounts" aria-label="Search deals" className="pl-8 pr-8" />
          <kbd className="pointer-events-none absolute right-2 top-2 hidden rounded border border-border-strong px-1 text-[10px] text-muted sm:block">/</kbd>
        </div>
        <FilterSheet count={secondaryCount} onClear={() => go(Object.fromEntries(SECONDARY.map((k) => [k, null])))}>
        <NativeSelect aria-label="Motion" className="w-auto" value={filter.pipelineKeys?.join(",") ?? ""} onChange={(e) => go({ motion: e.target.value || null, stage: null })}>
          <option value="">All motions</option>
          {pipelines.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
        {filter.pipelineKeys?.length === 1 ? (
          <NativeSelect aria-label="Stage" className="w-auto" value={filter.stageNames?.[0] ?? ""} onChange={(e) => go({ stage: e.target.value || null })}>
            <option value="">All stages</option>
            {(stageGroups.find((g) => g.pipelineKey === filter.pipelineKeys![0])?.stages ?? []).map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        <NativeSelect aria-label="Owner" className="w-auto" value={ownerValue} onChange={(e) => go({ owner: e.target.value })}>
          <option value="me">Mine</option>
          <option value="team">My team</option>
          <option value="all">Everyone</option>
          <option value="none">Unassigned</option>
          {users.length ? <option disabled>──────────</option> : null}
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Idle" className="w-auto" value={filter.idleDays ? String(filter.idleDays) : ""} onChange={(e) => go({ idle: e.target.value || null })}>
          <option value="">Any activity</option>
          {[7, 14, 30, 60, 90].map((d) => (
            <option key={d} value={d}>
              Idle &gt; {d} days
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Status" className="w-auto" value={filter.status ?? "open"} onChange={(e) => go({ status: e.target.value === "open" ? null : e.target.value })}>
          <option value="open">Open</option>
          <option value="hold">On hold</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
          <option value="any">Any status</option>
        </NativeSelect>
        <div className="hidden md:contents">
          <Toggle label="Overdue" on={Boolean(filter.overdue)} onClick={() => go({ overdue: filter.overdue ? null : "1" })} />
        </div>
        <Toggle label="No next step" on={Boolean(filter.noNextStep)} onClick={() => go({ nonext: filter.noNextStep ? null : "1" })} />
        <Toggle label="No close date" on={Boolean(filter.noCloseDate)} onClick={() => go({ noclose: filter.noCloseDate ? null : "1" })} />
        </FilterSheet>
        <div className="md:hidden">
          <Toggle label="Overdue" on={Boolean(filter.overdue)} onClick={() => go({ overdue: filter.overdue ? null : "1" })} />
        </div>
        {navPending ? <Loader2 className="size-4 animate-spin text-muted" aria-label="Loading" /> : null}
        <div className="ml-auto">
          <React.Suspense fallback={null}>
            <SavedViewsMenu page="deals" />
          </React.Suspense>
        </div>
      </div>

      {/* Bulk bar / summary */}
      <div className="flex min-h-9 flex-wrap items-center gap-2">
        {count ? (
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border-strong bg-surface-2 px-2 py-1" role="toolbar" aria-label="Bulk actions">
            <span className="px-1 text-xs font-medium text-fg tabular">{count.toLocaleString("en-US")} selected</span>
            <StagePicker groups={stageGroups} onPick={(stage) => void openPreview({ verb: "move", filter: targetFilter, toStage: stage }, `bulk: move to ${stage}`)} />
            {canAssign ? <UserPicker users={users} onPick={(u) => void openPreview({ verb: "assign", filter: targetFilter, toUser: u.id }, `bulk: assign to ${u.name}`)} /> : null}
            <TagPicker onPick={(t) => void openPreview({ verb: "tag", filter: targetFilter, tag: t }, `bulk: tag ${t}`)} />
            <ClosePicker onPick={(d) => void openPreview({ verb: "close", filter: targetFilter, date: d }, `bulk: close date ${d}`)} />
            {canEnroll ? <SequencePicker count={count} onPick={(sq) => void openPreview({ verb: "enroll", filter: targetFilter, sequence: sq.id }, `bulk: enroll in ${sq.name}`)} /> : null}
            {canExport ? (
              <Button size="sm" variant="ghost" className="h-7" onClick={() => void runExport()} disabled={exporting}>
                {exporting ? <Loader2 className="animate-spin" /> : <Download />} Export
              </Button>
            ) : null}
            {/* QA MAJ-17: share the selection with a partner (server excludes restricted deals and says how many). */}
            {!allMatching ? <ShareDealsButton dealIds={[...selected]} defaultLabel="Partner status" /> : null}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Clear selection (Esc)"
              onClick={() => {
                setSelected(new Set());
                setAllMatching(false);
              }}
            >
              <X />
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted tabular">
            {total.toLocaleString("en-US")} deal{total === 1 ? "" : "s"} · weighted {fmtUsd(totals.weightedUsd, { compact: true })} of {fmtUsd(totals.grossUsd, { compact: true })} gross
          </p>
        )}
        {allOnPage && !allMatching && total > rows.length ? (
          total <= MAX_COMMAND_RECORDS ? (
            <button type="button" className="text-xs text-fg underline-offset-4 hover:underline" onClick={() => setAllMatching(true)}>
              Select all {total.toLocaleString("en-US")} matching
            </button>
          ) : (
            // QA MIN-34: commands act on at most 500 records — don't offer a selection that then dead-ends.
            <span className="text-xs text-muted">
              {total.toLocaleString("en-US")} match — narrow the filters to act on all of them (max {MAX_COMMAND_RECORDS} per command)
            </span>
          )
        ) : null}
        <p className="ml-auto hidden items-center gap-1 text-[11px] text-muted lg:flex">
          <CommandIcon className="size-3" aria-hidden /> K → “move selected to Nurture”, “assign these to Will”
        </p>
      </div>

      {/* Table (md+) */}
      {rows.length === 0 ? (
        <EmptyState title="No deals match" description="Clear a filter, switch the owner to Everyone, or create a deal." />
      ) : (
        <>
          <div className="hidden overflow-x-auto overscroll-x-contain rounded-lg border border-border md:block">
            <table className="w-full min-w-[900px] border-collapse text-[13px]">
              <thead className="bg-surface-1 text-[11px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="w-9 px-3">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      className="size-3.5 accent-white"
                      checked={allOnPage}
                      ref={(el) => {
                        if (el) el.indeterminate = !allOnPage && pageIds.some((id) => selected.has(id));
                      }}
                      onChange={() => {
                        setAllMatching(false);
                        setSelected(allOnPage ? new Set() : new Set(pageIds));
                      }}
                    />
                  </th>
                  <Th label="Deal" k="name" sort={sort} dir={dir} onSort={sortBy} />
                  <Th label="Stage" k="stage" sort={sort} dir={dir} onSort={sortBy} />
                  <Th label="Owner" k="owner" sort={sort} dir={dir} onSort={sortBy} />
                  <Th label="Next step" k="due" sort={sort} dir={dir} onSort={sortBy} />
                  <Th label="Idle" k="idle" sort={sort} dir={dir} onSort={sortBy} align="right" />
                  <Th label="Health" k="health" sort={sort} dir={dir} onSort={sortBy} align="right" />
                  <Th label="Weighted" k="weighted" sort={sort} dir={dir} onSort={sortBy} align="right" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const on = allMatching || selected.has(r.id);
                  return (
                    <tr key={r.id} className={cn("border-t border-border transition-colors duration-150", on ? "bg-surface-2" : "hover:bg-surface-1")}>
                      <td className="px-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.name}`}
                          className="size-3.5 accent-white"
                          checked={on}
                          onChange={() => {
                            if (allMatching) {
                              setAllMatching(false);
                              setSelected(new Set(pageIds.filter((id) => id !== r.id)));
                              return;
                            }
                            setSelected((prev) => {
                              const n = new Set(prev);
                              if (n.has(r.id)) n.delete(r.id);
                              else n.add(r.id);
                              return n;
                            });
                          }}
                        />
                      </td>
                      <td className="max-w-72 py-2 pr-3">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <ColorTick color={r.pipelineColor} />
                          <Link href={`/deals/${r.id}`} className="truncate font-medium text-fg hover:underline">
                            {r.name}
                          </Link>
                          {r.restricted ? <Lock className="size-3 shrink-0 text-secondary" aria-label="Restricted" /> : null}
                        </span>
                        {r.accountName && r.accountName !== r.name ? <span className="block truncate pl-2.5 text-[11px] text-muted">{r.accountName}</span> : null}
                      </td>
                      <td className="px-3 text-body">
                        <span className="text-[11px] text-muted">{r.pipelineKey}</span> {r.stageName}
                      </td>
                      <td className="px-3 text-body">{r.ownerName ?? <span className="text-muted">Unassigned</span>}</td>
                      <td className="max-w-64 px-3">
                        {r.nextStep ? (
                          <span className="block truncate text-body">{r.nextStep}</span>
                        ) : r.stageCategory === "open" ? (
                          <StatusBadge status="warning" label="No next step" />
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                        {r.nextStepDueAt ? <span className={cn("block text-[11px]", r.overdue ? "text-fg" : "text-muted")}>{r.overdue ? "Overdue · " : ""}{fmtDate(r.nextStepDueAt, "d MMM")}</span> : null}
                      </td>
                      <td className={cn("px-3 text-right tabular", r.idleDays > 30 ? "text-fg" : "text-muted")}>{r.idleDays}d</td>
                      <td className="px-3 text-right">{r.healthScore != null ? <StatusBadge status={healthStatus(r.healthScore)} label={String(r.healthScore)} className="tabular" /> : <span className="text-muted">—</span>}</td>
                      <td className="px-3 text-right text-fg tabular">{r.unit === "activation" ? "—" : fmtUsd(r.weightedUsd, { compact: true })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Cards (< md) */}
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border md:hidden" role="list">
            {rows.map((r) => {
              const on = allMatching || selected.has(r.id);
              return (
                <li key={r.id} className={cn("flex items-start gap-3 px-3 py-2.5", on ? "bg-surface-2" : "")}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.name}`}
                    className="mt-1 size-4 accent-white"
                    checked={on}
                    onChange={() => {
                      if (allMatching) {
                        setAllMatching(false);
                        setSelected(new Set(pageIds.filter((id) => id !== r.id)));
                        return;
                      }
                      setSelected((prev) => {
                        const n = new Set(prev);
                        if (n.has(r.id)) n.delete(r.id);
                        else n.add(r.id);
                        return n;
                      });
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <Link href={`/deals/${r.id}`} className="flex items-center gap-1.5 font-medium text-fg">
                      <ColorTick color={r.pipelineColor} />
                      <span className="truncate">{r.name}</span>
                    </Link>
                    <p className="truncate text-[11px] text-muted">
                      {[r.pipelineKey, r.stageName, r.ownerName ?? "Unassigned", `idle ${r.idleDays}d`].join(" · ")}
                    </p>
                    <p className={cn("truncate text-xs", r.overdue ? "text-fg" : "text-secondary")}>{r.nextStep ?? (r.stageCategory === "open" ? "No next step" : "")}</p>
                  </div>
                  <span className="shrink-0 text-sm text-fg tabular">{r.unit === "activation" ? "—" : fmtUsd(r.weightedUsd, { compact: true })}</span>
                </li>
              );
            })}
          </ul>

          {lastPage > 1 ? (
            <nav className="flex items-center justify-end gap-2 text-xs text-muted" aria-label="Pagination">
              <span className="tabular">
                {(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} of {total.toLocaleString("en-US")}
              </span>
              <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => go({ page: String(page - 1) })}>
                <ChevronLeft />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={page >= lastPage} onClick={() => go({ page: String(page + 1) })}>
                <ChevronRight />
              </Button>
            </nav>
          ) : null}
        </>
      )}

      <CommandPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        preview={preview}
        loading={previewLoading}
        error={previewError}
        onDone={() => {
          setSelected(new Set());
          setAllMatching(false);
        }}
      />
    </div>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn("touch-target h-9 rounded-md border px-3 text-xs transition-colors duration-150", on ? "border-white/70 bg-surface-2 text-fg" : "border-border text-secondary hover:text-fg")}
    >
      {label}
    </button>
  );
}

function Th({ label, k, sort, dir, onSort, align }: { label: string; k: DealSort; sort: DealSort; dir: "asc" | "desc"; onSort: (k: DealSort) => void; align?: "right" }) {
  const active = sort === k;
  return (
    <th className={cn("h-9 px-3 font-medium", align === "right" ? "text-right" : "text-left")} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => onSort(k)} className={cn("inline-flex items-center gap-1 uppercase tracking-wider hover:text-fg", active ? "text-fg" : "")}>
        {label}
        {active ? dir === "asc" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden /> : null}
      </button>
    </th>
  );
}

function StagePicker({ groups, onPick }: { groups: StageGroup[]; onPick: (stage: string) => void }) {
  return (
    <NativeSelect aria-label="Move selected to stage" className="h-7 w-auto text-xs" value="" onChange={(e) => e.target.value && onPick(e.target.value)}>
      <option value="">Move to stage…</option>
      {groups.map((g) => (
        <optgroup key={g.pipelineKey} label={g.pipelineName}>
          {g.stages.map((st) => (
            <option key={`${g.pipelineKey}:${st}`} value={st}>
              {st}
            </option>
          ))}
        </optgroup>
      ))}
    </NativeSelect>
  );
}

function UserPicker({ users, onPick }: { users: Opt[]; onPick: (u: Opt) => void }) {
  return (
    <span className="inline-flex items-center gap-1">
      <UserRound className="size-3.5 text-muted" aria-hidden />
      <NativeSelect
        aria-label="Assign selected to"
        className="h-7 w-auto text-xs"
        value=""
        onChange={(e) => {
          const u = users.find((x) => x.id === e.target.value);
          if (u) onPick(u);
        }}
      >
        <option value="">Assign to…</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </NativeSelect>
    </span>
  );
}

function TagPicker({ onPick }: { onPick: (tag: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [v, setV] = React.useState("");
  const submit = () => {
    const t = v.trim();
    if (!t) return;
    setOpen(false);
    setV("");
    onPick(t);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7">
          <Tag /> Tag
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex gap-2"
        >
          <Input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="e.g. q4-push" aria-label="Tag" className="h-8 text-xs" maxLength={40} />
          <Button type="submit" size="sm" variant="primary" disabled={!v.trim()}>
            Add
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function ClosePicker({ onPick }: { onPick: (date: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [v, setV] = React.useState("");
  const pick = (d: string) => {
    setOpen(false);
    setV("");
    onPick(d);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7">
          <CalendarClock /> Close date
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-2">
        <p className="text-xs text-muted">Expected close — puts deals in the forecast.</p>
        <div className="flex flex-wrap gap-1.5">
          {["end of quarter", "end of next quarter", "end of month"].map((p) => (
            <button key={p} type="button" onClick={() => pick(p)} className="h-7 rounded-md border border-border px-2 text-xs text-secondary transition-colors duration-150 hover:text-fg">
              {p}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (v) pick(v);
          }}
        >
          <Input type="date" aria-label="Close date" value={v} onChange={(e) => setV(e.target.value)} className="h-8 text-xs" />
          <Button type="submit" size="sm" variant="primary" disabled={!v}>
            Set
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function SequencePicker({ count, onPick }: { count: number; onPick: (sq: { id: string; name: string }) => void }) {
  const [open, setOpen] = React.useState(false);
  const [opts, setOpts] = React.useState<{ sequences: { id: string; name: string; stepCount: number }[]; gmailReady: boolean; connectHref: string } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open || opts) return;
    void getEnrollOptions({}).then((r) => (r.ok ? setOpts(r.data) : setErr(r.error)));
  }, [open, opts]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7">
          <Workflow /> Sequence
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1">
        {count > 100 ? <p className="px-2 py-1.5 text-xs text-muted">Enroll up to 100 deals at a time — narrow the selection.</p> : null}
        {err ? <p className="px-2 py-1.5 text-xs text-body">{err}</p> : null}
        {!opts && !err ? (
          <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted">
            <Loader2 className="size-3 animate-spin" /> Loading sequences…
          </p>
        ) : null}
        {opts && !opts.gmailReady ? (
          <p className="px-2 py-1.5 text-xs text-body">
            Connect Gmail to send sequences.{" "}
            <Link href={opts.connectHref} className="underline">
              Connect
            </Link>
          </p>
        ) : null}
        {opts && opts.gmailReady && !opts.sequences.length ? <p className="px-2 py-1.5 text-xs text-muted">No active sequences yet.</p> : null}
        {opts?.gmailReady
          ? opts.sequences.map((sq) => (
              <button
                key={sq.id}
                type="button"
                disabled={count > 100}
                onClick={() => {
                  setOpen(false);
                  onPick(sq);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-body hover:bg-surface-3 disabled:opacity-40"
              >
                <Send className="size-3.5 text-muted" aria-hidden /> <span className="truncate">{sq.name}</span>
                <span className="ml-auto text-[11px] text-muted">{sq.stepCount} steps</span>
              </button>
            ))
          : null}
      </PopoverContent>
    </Popover>
  );
}
