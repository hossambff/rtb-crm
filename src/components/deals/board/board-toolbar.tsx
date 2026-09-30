"use client";
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Columns3, Download, Loader2, Rows3, Search, X } from "lucide-react";
import { Input, NativeSelect } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { activeFilterCount, withParam } from "@/lib/deals/filters";
import { PRIORITY_LABELS, type BoardFilters, type BoardView, type Lane, type UserLite } from "@/lib/deals/types";
import { cn } from "@/lib/utils";

/** Filters + swimlanes + view toggle, persisted in the URL (KAN-3/4). */
export function BoardToolbar({
  filters,
  lane,
  view,
  users,
  categories,
  canExport,
  onExport,
  exporting,
  right,
}: {
  filters: BoardFilters;
  lane: Lane;
  view: BoardView;
  users: UserLite[];
  categories: string[];
  canExport: boolean;
  onExport: () => void;
  exporting: boolean;
  right?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = React.useTransition();
  const [q, setQ] = React.useState(filters.q ?? "");

  const go = React.useCallback(
    (key: string, value: string | null | undefined) => {
      const qs = withParam(new URLSearchParams(sp.toString()), key, value);
      startTransition(() => router.replace(`${pathname}${qs === "?" ? "" : qs}`, { scroll: false }));
    },
    [pathname, router, sp],
  );

  // debounce search → URL
  React.useEffect(() => {
    if ((filters.q ?? "") === q.trim()) return;
    const t = setTimeout(() => go("q", q.trim() || null), 300);
    return () => clearTimeout(t);
  }, [q, filters.q, go]);

  const n = activeFilterCount(filters);

  // QA-15: owners/categories can repeat (split owners, case variants) → duplicate React keys. Dedupe once.
  const uniqueUsers = [...new Map(users.map((u) => [u.id, u])).values()];
  const uniqueCategories = [...new Set(categories)];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-56">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input className="h-8 pl-8 text-[13px]" placeholder="Search deals, accounts…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search deals" />
      </div>
      <FilterSelect label="Owner" value={filters.owner ?? ""} onChange={(v) => go("owner", v)}>
        <option value="">All owners</option>
        <option value="me">Me</option>
        <option value="none">Unassigned</option>
        {uniqueUsers.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect label="Priority" value={filters.priority ?? ""} onChange={(v) => go("priority", v)}>
        <option value="">Any priority</option>
        {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
        <option value="none">No priority</option>
      </FilterSelect>
      {categories.length ? (
        <FilterSelect label="Category" value={filters.category ?? ""} onChange={(v) => go("category", v)}>
          <option value="">All categories</option>
          {uniqueCategories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </FilterSelect>
      ) : null}
      <FilterSelect label="Status" value={filters.status ?? ""} onChange={(v) => go("status", v)}>
        <option value="">Any status</option>
        <option value="open">Open</option>
        <option value="won">Won</option>
        <option value="hold">On hold</option>
        <option value="lost">Lost</option>
      </FilterSelect>
      <Button
        variant={filters.overdue ? "primary" : "secondary"}
        size="sm"
        aria-pressed={!!filters.overdue}
        onClick={() => go("overdue", filters.overdue ? null : "1")}
      >
        Overdue
      </Button>
      {n > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setQ("");
            const keep = new URLSearchParams();
            for (const k of ["lane", "view"]) {
              const v = sp.get(k);
              if (v) keep.set(k, v);
            }
            const s = keep.toString();
            startTransition(() => router.replace(`${pathname}${s ? `?${s}` : ""}`, { scroll: false }));
          }}
        >
          <X /> Clear ({n})
        </Button>
      ) : null}
      {pending ? <Loader2 className="size-4 animate-spin text-muted" aria-label="Updating" /> : null}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {view === "board" ? (
          <FilterSelect label="Swimlanes" value={lane === "none" ? "" : lane} onChange={(v) => go("lane", v)}>
            <option value="">No swimlanes</option>
            <option value="owner">Lanes: owner</option>
            <option value="priority">Lanes: priority</option>
          </FilterSelect>
        ) : null}
        <div className="flex rounded-md border border-border-strong p-0.5" role="group" aria-label="View">
          <ViewButton active={view === "board"} onClick={() => go("view", null)} label="Board">
            <Columns3 />
          </ViewButton>
          <ViewButton active={view === "list"} onClick={() => go("view", "list")} label="List">
            <Rows3 />
          </ViewButton>
        </div>
        {canExport ? (
          <Button variant="secondary" size="sm" onClick={onExport} disabled={exporting} aria-label="Export CSV">
            {exporting ? <Loader2 className="animate-spin" /> : <Download />} CSV
          </Button>
        ) : null}
        {right}
      </div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string | null) => void; children: React.ReactNode }) {
  return (
    <NativeSelect
      aria-label={label}
      className={cn("h-8 w-auto max-w-44 text-[13px]", value ? "border-border-strong text-fg" : "text-secondary")}
      value={value}
      onChange={(e) => onChange(e.target.value || null)}
    >
      {children}
    </NativeSelect>
  );
}

function ViewButton({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors [&_svg]:size-3.5",
        active ? "bg-white text-black" : "text-secondary hover:text-fg",
      )}
    >
      {children}
      {label}
    </button>
  );
}
