"use client";
import { useMemo, useState } from "react";
import { BellRing, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Avatar, EmptyState } from "@/components/ui/misc";
import { RelativeTime } from "@/components/ui/relative-time";
import { AdminTable, Td, Th, useAction } from "@/components/admin/form";
import { cn } from "@/lib/utils";
import { STATUS_LABELS } from "@/lib/team-setup/core";
import { nudgeMember } from "@/lib/team-setup/actions";
import type { BoardRow } from "@/lib/team-setup/queries";

type Filter = "all" | BoardRow["status"] | "gaps";
const BADGE: Record<BoardRow["status"], "info" | "progress" | "good" | "warning"> = { not_started: "info", in_progress: "progress", done: "good", deferred: "warning" };

function Progress({ done, total }: { done: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-16 overflow-hidden rounded-full bg-border" aria-hidden>
        <div className="h-full rounded-full bg-fg transition-[width] duration-200" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
      <span className="text-xs text-muted tabular">
        {done}/{total}
      </span>
    </div>
  );
}

function NudgeButton({ row, readOnly }: { row: BoardRow; readOnly: boolean }) {
  const { run, pending } = useAction(nudgeMember, { success: (d) => `Nudged ${d.nudged}.`, refresh: false });
  if (!row.canNudge || row.status === "done" || readOnly) return null;
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => run({ userId: row.id })} aria-label={`Nudge ${row.name}`}>
      <BellRing /> <span className="md:hidden xl:inline">Nudge</span>
    </Button>
  );
}

/** Everyone in scope with their onboarding status, gaps to chase and a Nudge button. */
export function ProgressBoard({ rows, readOnly }: { rows: BoardRow[]; readOnly: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length, gaps: rows.filter((r) => r.gaps.length).length };
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);
  const shown = rows.filter((r) => {
    if (filter === "gaps" ? !r.gaps.length : filter !== "all" && r.status !== filter) return false;
    const needle = q.trim().toLowerCase();
    return !needle || r.name.toLowerCase().includes(needle) || (r.teamName ?? "").toLowerCase().includes(needle) || r.roleLabel.toLowerCase().includes(needle);
  });
  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "Everyone" },
    { key: "not_started", label: STATUS_LABELS.not_started },
    { key: "in_progress", label: STATUS_LABELS.in_progress },
    { key: "deferred", label: STATUS_LABELS.deferred },
    { key: "done", label: STATUS_LABELS.done },
    { key: "gaps", label: "Has gaps" },
  ];
  const doneN = counts.done ?? 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <p className="font-display text-[32px] leading-10 text-fg tabular">
          {doneN}
          <span className="text-muted">/{rows.length}</span>
        </p>
        <p className="text-sm text-muted">set up · {counts.not_started ?? 0} not started · {counts.gaps} with gaps</p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="group" aria-label="Filter by status" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "h-7 shrink-0 rounded-full border px-3 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
                filter === f.key ? "border-fg bg-fg text-accent-inverse" : "border-border-strong text-secondary hover:text-fg",
              )}
            >
              {f.label} <span className="tabular opacity-70">{counts[f.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="relative sm:w-56">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" aria-hidden />
          <Input aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="pl-8" />
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState title={rows.length ? "Nobody matches" : "No one here yet"} description={rows.length ? "Try another filter." : "Invite your team to get started."} />
      ) : (
        <>
          {/* Phones: one card per person. */}
          <ul className="divide-y divide-border rounded-lg border border-border md:hidden">
            {shown.map((r) => (
              <li key={r.id} className="space-y-2 px-3 py-3">
                <div className="flex items-center gap-2.5">
                  <Avatar name={r.name} src={r.image} size={28} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-fg">{r.name}</p>
                    <p className="truncate text-xs text-muted">
                      {r.roleLabel}
                      {r.teamName ? ` · ${r.teamName}` : ""}
                    </p>
                  </div>
                  <StatusBadge status={BADGE[r.status]} label={STATUS_LABELS[r.status]} className="whitespace-nowrap" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Progress done={r.done} total={r.total} />
                  {r.gaps.map((g) => (
                    <Badge key={g}>{g}</Badge>
                  ))}
                  <span className="ml-auto">
                    <NudgeButton row={r} readOnly={readOnly} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <AdminTable className="hidden md:block">
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Status</Th>
                <Th>Progress</Th>
                <Th>Gaps</Th>
                <Th>Last active</Th>
                <Th className="w-24">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={r.name} src={r.image} size={28} />
                      <div className="min-w-0">
                        <p className="truncate text-sm text-fg">{r.name}</p>
                        <p className="truncate text-xs text-muted">
                          {r.roleLabel}
                          {r.teamName ? ` · ${r.teamName}` : ""}
                          {r.managerName ? ` · reports to ${r.managerName}` : ""}
                        </p>
                      </div>
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <StatusBadge status={BADGE[r.status]} label={STATUS_LABELS[r.status]} className="whitespace-nowrap" />
                  </Td>
                  <Td>
                    <Progress done={r.done} total={r.total} />
                  </Td>
                  <Td>
                    <div className="flex min-w-36 max-w-xs flex-wrap gap-1">
                      {r.gaps.length ? r.gaps.map((g) => <Badge key={g}>{g}</Badge>) : <span className="text-xs text-muted">—</span>}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-muted">
                    <RelativeTime value={r.lastActiveAt} />
                  </Td>
                  <Td className="text-right">
                    <NudgeButton row={r} readOnly={readOnly} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        </>
      )}
    </div>
  );
}
