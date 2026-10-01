import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { fmtNumber, fmtRelative } from "@/lib/format";
import { VIZ } from "@/lib/palette";
import { cn } from "@/lib/utils";
import { RunStatusBadge, usd } from "./bits";

export const SCOUT_TABS = [
  { key: "queue", label: "Review queue" },
  { key: "outreach", label: "Outreach" },
  { key: "searches", label: "Searches" },
  { key: "runs", label: "Enrichment runs" },
  { key: "budget", label: "Budget" },
  { key: "settings", label: "Settings" },
] as const;
export type ScoutTab = (typeof SCOUT_TABS)[number]["key"];

/** Link-based tabs (server-rendered; only the active tab's data is loaded). */
export function ScoutTabNav({ active, showSettings, queueCount, showOutreach = true }: { active: ScoutTab; showSettings: boolean; queueCount: number; showOutreach?: boolean }) {
  return (
    <nav aria-label="Lead Scout sections" className="mb-5 flex gap-1 overflow-x-auto border-b border-border">
      {SCOUT_TABS.filter((t) => (t.key !== "settings" || showSettings) && (t.key !== "outreach" || showOutreach)).map((t) => (
        <Link
          key={t.key}
          href={`/scout?tab=${t.key}`}
          aria-current={active === t.key ? "page" : undefined}
          className={cn(
            "-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted transition-colors duration-150 hover:text-fg",
            active === t.key && "border-white text-fg",
          )}
        >
          {t.label}
          {t.key === "queue" && queueCount > 0 ? <span className="ml-1.5 tabular text-xs text-secondary">{queueCount}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

export type RunListRow = {
  id: string;
  kind: string;
  status: string;
  costCents: number;
  estimatedCostCents: number;
  resultsCount: number;
  verifiedCount: number;
  error: string | null;
  createdAt: Date;
  requester: string | null;
  target: string;
};

export function RunsTable({ rows, empty }: { rows: RunListRow[]; empty: string }) {
  if (!rows.length) return <EmptyState title="No runs yet" description={empty} />;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[820px] text-sm">
        <thead className="bg-surface-1 text-left text-xs font-medium text-muted">
          <tr className="border-b border-border">
            <th className="px-4 py-2">Target</th>
            <th className="px-3 py-2">Kind</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Requested by</th>
            <th className="px-3 py-2 text-right">Results</th>
            <th className="px-3 py-2 text-right">Cost</th>
            <th className="px-3 py-2">When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-2/60">
              <td className="px-4 py-2.5">
                <Link href={`/scout/runs/${r.id}`} className="font-medium text-fg hover:underline">
                  {r.target}
                </Link>
                {r.error ? <p className="max-w-md truncate text-xs text-muted">{r.error}</p> : null}
              </td>
              <td className="px-3 py-2.5">
                <Badge>{r.kind === "enrich" ? "Enrichment" : "Scout"}</Badge>
              </td>
              <td className="px-3 py-2.5">
                <RunStatusBadge status={r.status} />
              </td>
              <td className="px-3 py-2.5 text-secondary">{r.requester ?? "—"}</td>
              <td className="px-3 py-2.5 text-right tabular text-secondary">
                {r.kind === "enrich" ? `${r.resultsCount} · ${r.verifiedCount} valid` : fmtNumber(r.resultsCount)}
              </td>
              <td className="px-3 py-2.5 text-right tabular">
                {usd(r.costCents)}
                {r.status === "blocked" ? <span className="block text-[11px] text-muted">est. {usd(r.estimatedCostCents)}</span> : null}
              </td>
              <td className="px-3 py-2.5 text-xs text-muted">{fmtRelative(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Spend vs cap: a single thin bar (data viz → pastel blue), with the cap marked. */
export function SpendBar({ spentCents, capCents, label }: { spentCents: number; capCents: number; label: string }) {
  const pct = capCents > 0 ? Math.min(100, (spentCents / capCents) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-secondary">{label}</span>
        <span className="tabular text-sm text-body">
          {usd(spentCents)} <span className="text-muted">of {usd(capCents)}</span>
        </span>
      </div>
      <div className="mt-2 h-2 rounded bg-surface-3" role="meter" aria-valuemin={0} aria-valuemax={capCents} aria-valuenow={spentCents} aria-label={label}>
        <div className="h-2 rounded" style={{ width: `${pct}%`, background: VIZ[0] }} />
      </div>
    </div>
  );
}

export function Funnel({ steps }: { steps: { label: string; value: number }[] }) {
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <ol className="space-y-2.5">
      {steps.map((s, i) => (
        <li key={s.label} className="grid grid-cols-[110px_1fr_64px] items-center gap-3 text-sm">
          <span className="text-secondary">{s.label}</span>
          <span className="h-2 rounded bg-surface-3" aria-hidden>
            <span className="block h-2 rounded" style={{ width: `${(s.value / max) * 100}%`, background: VIZ[0] }} />
          </span>
          <span className="tabular text-right text-body">
            {fmtNumber(s.value)}
            {i > 0 && steps[i - 1]!.value > 0 ? <span className="block text-[11px] text-muted">{Math.round((s.value / steps[i - 1]!.value) * 100)}%</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
