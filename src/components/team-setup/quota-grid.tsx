"use client";
import { useState } from "react";
import { Check, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorTick, StatusBadge } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { AdminTable, Td, Th, useAction } from "@/components/admin/form";
import { cn } from "@/lib/utils";
import { formatTarget, fromStoredTarget, METRIC_LABELS, metricsForMotion, periodLabel, type QuotaMetric } from "@/lib/quotas/core";
import { clearQuota, confirmQuota, setQuota } from "@/lib/team-setup/actions";
import type { QuotaCell, QuotaPerson } from "@/lib/team-setup/queries";

type Motion = { key: string; name: string; color: string };

function CellEditor({ person, period, line, cell }: { person: QuotaPerson; period: string; line: { pipelineKey: string; metric: QuotaMetric }; cell: QuotaCell | undefined }) {
  const [editing, setEditing] = useState(false);
  const [metric, setMetric] = useState<QuotaMetric>(cell?.metric ?? line.metric);
  const [value, setValue] = useState(cell ? String(fromStoredTarget(cell.metric, cell.target)) : "");
  const save = useAction(setQuota, { success: "Quota saved.", onSuccess: () => setEditing(false) });
  const confirm = useAction(confirmQuota, { success: "Confirmed." });
  const clear = useAction(clearQuota, { success: "Cleared.", onSuccess: () => setEditing(false) });
  const pending = save.pending || confirm.pending || clear.pending;
  const label = `${person.name}, ${line.pipelineKey || "all motions"}, ${periodLabel(period)}`;

  if (editing)
    return (
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run({ userId: person.id, period, pipelineKey: line.pipelineKey, metric, target: Number(value) || 0 });
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setEditing(false);
        }}
      >
        <NativeSelect aria-label={`Metric for ${label}`} className="h-8 w-32" value={metric} onChange={(e) => setMetric(e.target.value as QuotaMetric)}>
          {metricsForMotion(line.pipelineKey).map((m) => (
            <option key={m} value={m}>
              {METRIC_LABELS[m]}
            </option>
          ))}
        </NativeSelect>
        <Input
          aria-label={`Target for ${label}${metric === "revenue_usd" ? " in US dollars" : ""}`}
          autoFocus
          inputMode="numeric"
          className="h-8 w-28 text-right tabular"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))}
          placeholder={metric === "revenue_usd" ? "$" : "0"}
        />
        <Button type="submit" size="icon-sm" variant="primary" aria-label="Save" disabled={pending || !(Number(value) > 0)}>
          <Check />
        </Button>
        {cell ? (
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => clear.run({ id: cell.id })}>
            Clear
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </form>
    );

  return (
    <div className="flex items-center gap-2">
      {cell ? <span className={cn("whitespace-nowrap tabular", cell.status === "proposed" ? "text-secondary" : "text-fg")}>{formatTarget(cell.metric, cell.target)}</span> : <span className="text-muted">—</span>}
      {cell?.status === "proposed" ? <StatusBadge status="progress" label="Proposed" /> : null}
      {person.editable ? (
        <span className="ml-auto flex items-center gap-1">
          {cell?.status === "proposed" ? (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => confirm.run({ id: cell.id })}>
              Confirm
            </Button>
          ) : null}
          <Button size="icon-sm" variant="ghost" aria-label={`Edit ${label}`} onClick={() => setEditing(true)}>
            <Pencil />
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/** People × current/next quarter × metric. Leaders confirm or adjust what reps proposed; every change is audited. */
export function QuotaGrid({ data }: { data: { current: string; next: string; rows: QuotaPerson[]; motions: Motion[]; proposed: number } }) {
  const [onlyProposed, setOnlyProposed] = useState(false);
  const periods = [data.current, data.next];
  const motion = (k: string) => data.motions.find((m) => m.key === k);
  const rows = onlyProposed ? data.rows.filter((r) => Object.values(r.cells).some((c) => c.status === "proposed")) : data.rows;
  if (!data.rows.length) return <EmptyState title="No sellers in scope" description="Quotas are for AEs, SDRs, interns, commission reps and sales leaders." />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          Revenue in US dollars, audiences in MUU. {data.proposed ? `${data.proposed} proposed by reps — confirm or adjust.` : "Reps can propose targets during setup."}
        </p>
        {data.proposed ? (
          <Button size="sm" variant={onlyProposed ? "primary" : "secondary"} aria-pressed={onlyProposed} onClick={() => setOnlyProposed((v) => !v)}>
            Proposed only
          </Button>
        ) : null}
      </div>
      {/* Wide quarter × motion grid: deliberate horizontal scroller with the person column pinned. */}
      <AdminTable stickyFirst>
        <thead>
          <tr>
            <Th>Person</Th>
            <Th>Motion</Th>
            {periods.map((p) => (
              <Th key={p}>
                {periodLabel(p)}
                {p === data.current ? " · now" : ""}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((person) =>
            person.lines.map((line, i) => {
              const m = motion(line.pipelineKey);
              return (
                <tr key={`${person.id}-${line.pipelineKey}`}>
                  {i === 0 ? (
                    <Td className="align-top">
                      <p className="text-sm text-fg">{person.name}</p>
                      <p className="text-xs text-muted">
                        {person.roleLabel}
                        {!person.editable ? " · set by your leader" : ""}
                      </p>
                    </Td>
                  ) : (
                    <Td>
                      <span className="sr-only">{person.name}</span>
                    </Td>
                  )}
                  <Td className="whitespace-nowrap text-xs">
                    <span className="inline-flex items-center gap-1.5">
                      {m ? <ColorTick color={m.color} /> : null}
                      {m?.name ?? (line.pipelineKey || "All motions")}
                    </span>
                  </Td>
                  {periods.map((p) => (
                    <Td key={p} className="min-w-52">
                      <CellEditor person={person} period={p} line={line} cell={person.cells[`${p}|${line.pipelineKey}`]} />
                    </Td>
                  ))}
                </tr>
              );
            }),
          )}
        </tbody>
      </AdminTable>
    </div>
  );
}
