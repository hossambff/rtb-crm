import * as React from "react";
import { CheckCircle2, AlertTriangle, AlertOctagon, XCircle, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { STATUS_COLORS } from "@/lib/palette";
import { FIT_FACTOR_LABELS, FIT_FACTORS, fitStatus, type FitFactor } from "@/lib/scout/fit";
import { cn } from "@/lib/utils";

const ICONS = { good: CheckCircle2, warning: AlertTriangle, serious: AlertOctagon, critical: XCircle } as const;
const LABEL = { good: "Strong fit", warning: "Fair fit", serious: "Weak fit", critical: "Poor fit" } as const;

/** Fit Score: number in the status color + icon + accessible label (color never alone). */
export function FitScore({ score, size = "md" }: { score: number | null; size?: "md" | "lg" }) {
  const st = fitStatus(score);
  const Icon = ICONS[st];
  return (
    <span className="inline-flex items-center gap-1.5" aria-label={`Fit Score ${score ?? "unknown"} — ${LABEL[st]}`}>
      <Icon className={size === "lg" ? "size-4" : "size-3.5"} style={{ color: STATUS_COLORS[st] }} aria-hidden />
      <span className={cn("tabular font-semibold", size === "lg" ? "font-display text-2xl" : "text-sm")} style={{ color: STATUS_COLORS[st] }}>
        {score ?? "—"}
      </span>
    </span>
  );
}

/** Monochrome factor bars: filled share = points / weight. */
export function FactorBars({ factors, weights, compact = false }: { factors: Record<string, number>; weights?: Record<string, number>; compact?: boolean }) {
  return (
    <div className={cn("grid gap-1", compact ? "w-40" : "w-full")}>
      {FIT_FACTORS.map((f: FitFactor) => {
        const pts = factors[f] ?? 0;
        const max = weights?.[f] ?? DEFAULT_MAX[f];
        const pct = max > 0 ? Math.max(0, Math.min(100, (pts / max) * 100)) : 0;
        return (
          <div key={f} className="grid grid-cols-[88px_1fr_30px] items-center gap-2 text-[11px]" title={`${FIT_FACTOR_LABELS[f]}: ${pts.toFixed(1)} of ${max.toFixed(0)}`}>
            <span className="truncate text-muted">{SHORT[f]}</span>
            <span className="h-1.5 rounded-full bg-surface-3" aria-hidden>
              <span className="block h-1.5 rounded-full bg-secondary" style={{ width: `${pct}%` }} />
            </span>
            <span className="tabular text-right text-secondary">{pts.toFixed(0)}</span>
          </div>
        );
      })}
    </div>
  );
}

const DEFAULT_MAX: Record<FitFactor, number> = { audience: 25, vertical: 15, ownership: 15, pain: 15, stack: 10, lookalike: 10, geo: 5, relationship: 5 };
const SHORT: Record<FitFactor, string> = { audience: "Audience", vertical: "Vertical", ownership: "Ownership", pain: "Pain", stack: "Stack", lookalike: "Lookalike", geo: "Geo", relationship: "Relationship" };

/** MUU confidence badge (SCOUT-7: every estimate is labeled). */
export function ConfidenceBadge({ confidence }: { confidence: string | null | undefined }) {
  const label = confidence === "verified" ? "Verified" : confidence === "reported" ? "Reported" : confidence === "estimate" ? "Estimate" : "Unknown";
  return <Badge className={cn(confidence === "verified" && "border-secondary text-fg", (!confidence || confidence === "unknown") && "border-dashed text-muted")}>{label}</Badge>;
}

export function Trend({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return <span className="text-muted">—</span>;
  const v = Math.round(pct * 100);
  const Icon = v <= -5 ? TrendingDown : v >= 5 ? TrendingUp : Minus;
  return (
    <span className="inline-flex items-center gap-1 tabular text-secondary">
      <Icon className="size-3.5 text-muted" aria-hidden />
      {v > 0 ? `+${v}` : v}%
    </span>
  );
}

/** Tiny monochrome sparkline of monthly visits. */
export function Sparkline({ series }: { series: number[] }) {
  if (!series || series.length < 2) return null;
  const w = 56;
  const h = 16;
  const max = Math.max(...series);
  const min = Math.min(...series);
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * w},${h - ((v - min) / (max - min || 1)) * (h - 2) - 1}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="shrink-0">
      <polyline points={pts} fill="none" stroke="#5C98D5" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

export function RunStatusBadge({ status }: { status: string }) {
  const map: Record<string, { st: keyof typeof STATUS_COLORS; label: string }> = {
    succeeded: { st: "good", label: "Done" },
    running: { st: "warning", label: "Running" },
    queued: { st: "warning", label: "Queued" },
    waiting: { st: "warning", label: "Waiting on Apify" },
    blocked: { st: "serious", label: "Blocked by budget" },
    failed: { st: "critical", label: "Failed" },
    skipped: { st: "warning", label: "Skipped" },
    pending: { st: "warning", label: "Pending" },
  };
  const m = map[status] ?? { st: "warning" as const, label: status };
  const Icon = ICONS[m.st];
  return (
    <Badge>
      <Icon className="size-3" style={{ color: STATUS_COLORS[m.st] }} aria-hidden />
      {m.label}
    </Badge>
  );
}

export function VerificationBadge({ v }: { v: string }) {
  const map: Record<string, { st: keyof typeof STATUS_COLORS; label: string }> = {
    valid: { st: "good", label: "Valid" },
    risky: { st: "warning", label: "Risky / catch-all" },
    invalid: { st: "critical", label: "Invalid" },
    unknown: { st: "serious", label: "Unverified" },
  };
  const m = map[v] ?? map.unknown!;
  const Icon = ICONS[m.st];
  return (
    <Badge>
      <Icon className="size-3" style={{ color: STATUS_COLORS[m.st] }} aria-hidden />
      {m.label}
    </Badge>
  );
}

export function usd(cents: number | null | undefined, digits = 2) {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(digits)}`;
}
