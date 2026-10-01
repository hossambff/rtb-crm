"use client";
import * as React from "react";
import Link from "next/link";
import { Lock, Search, X } from "lucide-react";
import { createColumnHelper } from "@tanstack/react-table";
import { Badge, ColorTick } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { ACCOUNT_TYPES, LIFECYCLES, MUU_RANGES, PRIORITIES, labelOf } from "@/lib/accounts/constants";
import { PIPELINE_COLORS } from "@/lib/palette";
import { RelativeTime } from "@/components/ui/relative-time";
import { MuuValue } from "./muu-value";
import { Pager, ServerTable, type ColumnUi, type ListFeatures } from "./server-table";
import { useQueryParams } from "./use-query-params";

export type AccountRowDto = {
  id: string;
  name: string;
  domain: string | null;
  type: string;
  category: string | null;
  lifecycle: string;
  priority: string | null;
  muu: number | null;
  muuSource: string | null;
  muuConfidence: string | null;
  ownerName: string | null;
  restricted: boolean;
  openDeals: number;
  pipelines: string[];
  updatedAt: string;
};

const h = createColumnHelper<ListFeatures, AccountRowDto>();
const columns = h.columns([
  h.accessor("name", {
    header: "Account",
    cell: (c) => {
      const r = c.row.original;
      return (
        <div className="flex min-w-0 items-center gap-2">
          <Link href={`/accounts/${r.id}`} className="truncate font-medium text-fg hover:underline">
            {r.name}
          </Link>
          {r.restricted ? <Lock className="size-3 shrink-0 text-muted" aria-label="Restricted" /> : null}
          {r.domain ? <span className="hidden truncate text-xs text-muted lg:inline">{r.domain}</span> : null}
        </div>
      );
    },
  }),
  h.accessor("type", { header: "Type", cell: (c) => <span className="text-secondary">{labelOf(ACCOUNT_TYPES, c.getValue())}</span> }),
  h.accessor("category", { header: "Category", cell: (c) => <span className="text-secondary">{c.getValue() ?? "—"}</span> }),
  h.accessor("lifecycle", { header: "Lifecycle", cell: (c) => <Badge>{labelOf(LIFECYCLES, c.getValue())}</Badge> }),
  h.accessor("priority", { header: "Priority", cell: (c) => (c.getValue() ? <span className="text-secondary">{labelOf(PRIORITIES, c.getValue())}</span> : <span className="text-muted">—</span>) }),
  h.accessor("muu", { header: "MUU", cell: (c) => <MuuValue value={c.getValue()} confidence={c.row.original.muuConfidence} source={c.row.original.muuSource} /> }),
  h.accessor("openDeals", {
    header: "Deals",
    cell: (c) => {
      const r = c.row.original;
      if (!r.pipelines.length) return <span className="text-muted">—</span>;
      return (
        <span className="inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-1" aria-label={`Pipelines: ${r.pipelines.join(", ")}`}>
            {r.pipelines.map((p) => (
              <span key={p} className="inline-flex items-center gap-0.5 text-[11px] text-secondary">
                <ColorTick color={PIPELINE_COLORS[p] ?? "#828282"} />
                {p}
              </span>
            ))}
          </span>
          <span className="tabular text-xs text-muted">{r.openDeals}</span>
        </span>
      );
    },
  }),
  h.accessor("ownerName", { header: "Owner", cell: (c) => <span className="truncate text-secondary">{c.getValue() ?? "—"}</span> }),
  h.accessor("updatedAt", { header: "Updated", cell: (c) => <RelativeTime value={c.getValue()} className="whitespace-nowrap text-xs text-muted" /> }),
]);

const UI: Record<string, ColumnUi> = {
  name: { sortKey: "name", className: "max-w-[340px]" },
  type: { hideOnMobile: true },
  category: { hideOnMobile: true, className: "max-w-[180px] truncate" },
  lifecycle: { sortKey: "lifecycle" },
  priority: { sortKey: "priority", hideOnMobile: true },
  muu: { sortKey: "muu", align: "right" },
  openDeals: {},
  ownerName: { hideOnMobile: true },
  updatedAt: { sortKey: "updated", hideOnMobile: true },
};

export function AccountsList({
  rows,
  total,
  page,
  pageSize,
  categories,
  owners,
  toolbarExtra,
}: {
  rows: AccountRowDto[];
  total: number;
  page: number;
  pageSize: number;
  categories: string[];
  owners: { id: string; name: string }[];
  toolbarExtra?: React.ReactNode;
}) {
  const { get, set, pending } = useQueryParams();
  const [q, setQ] = React.useState(get("q"));
  const debounce = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const sort = get("sort") || "name";
  const dir = (get("dir") || (["muu", "updated"].includes(sort) ? "desc" : "asc")) as "asc" | "desc";
  const filters = ["type", "category", "lifecycle", "priority", "owner", "openDeal", "muu"];
  const activeFilters = filters.filter((f) => get(f));

  const onSearch = (v: string) => {
    setQ(v);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => set({ q: v.trim() || null }), 250);
  };

  const select = (key: string, label: string, options: { value: string; label: string }[]) => (
    <NativeSelect aria-label={label} value={get(key)} onChange={(e) => set({ [key]: e.target.value || null })} className={`h-8 w-auto min-w-28 text-xs ${get(key) ? "border-border-strong text-fg" : "text-secondary"}`}>
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </NativeSelect>
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input value={q} onChange={(e) => onSearch(e.target.value)} placeholder="Search name or domain…" aria-label="Search accounts" className="h-8 pl-8 text-sm" />
        </div>
        {select("type", "Type", ACCOUNT_TYPES.map((t) => ({ value: t.key, label: t.label })))}
        {select("category", "Category", categories.map((c) => ({ value: c, label: c })))}
        {select("lifecycle", "Lifecycle", LIFECYCLES.map((t) => ({ value: t.key, label: t.label })))}
        {select("priority", "Priority", PRIORITIES.map((t) => ({ value: t.key, label: t.label })))}
        {select("owner", "Owner", [{ value: "me", label: "Me" }, { value: "team", label: "My team" }, { value: "none", label: "Unassigned" }, ...owners.map((o) => ({ value: o.id, label: o.name }))])}
        {select("openDeal", "Open deal", [
          { value: "yes", label: "Has open deal" },
          { value: "no", label: "No open deal" },
        ])}
        {select("muu", "MUU", MUU_RANGES.map((r) => ({ value: r.key, label: r.label })))}
        {activeFilters.length ? (
          <Button size="sm" variant="ghost" onClick={() => set(Object.fromEntries(activeFilters.map((f) => [f, null])))}>
            <X /> Clear
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-2">{toolbarExtra}</div>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          title={activeFilters.length || q ? "No accounts match" : "No accounts yet"}
          description={activeFilters.length || q ? "Try a different search or clear the filters." : "Create an account or import a spreadsheet to get started."}
        />
      ) : (
        <>
          <ServerTable
            columns={columns}
            ui={UI}
            data={rows}
            sort={sort}
            dir={dir}
            pending={pending}
            rowHref={(r) => `/accounts/${r.id}`}
            onSort={(key) => set({ sort: key, dir: sort === key ? (dir === "asc" ? "desc" : "asc") : ["muu", "updated"].includes(key) ? "desc" : "asc" })}
          />
          <Pager page={page} pageSize={pageSize} total={total} onPage={(p) => set({ page: String(p) }, { resetPage: false })} onSize={(n) => set({ size: String(n) })} />
        </>
      )}
    </div>
  );
}
