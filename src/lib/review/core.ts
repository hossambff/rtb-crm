/**
 * Pipeline review mode (docs/V2_SPEC.md §C5) — pure, client-safe, unit-tested core:
 * exception detection, ranking, value-change reconstruction and the recap text.
 */
import { dealValue, type DealValueInput } from "@/lib/pipeline-math";
import { fmtUsd } from "@/lib/format";

const DAY = 86_400_000;

export const EXCEPTION_KINDS = ["stalled", "slipped_close", "no_next_step", "overdue_next_step", "low_health", "value_change", "pending_override"] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/** Label + weight (how much it pulls a deal up the walk-through order). */
export const EXCEPTION_META: Record<ExceptionKind, { label: string; weight: number; tone: "warning" | "serious" | "critical" | "info" }> = {
  stalled: { label: "Stalled past SLA", weight: 3, tone: "serious" },
  slipped_close: { label: "Close date slipped", weight: 3, tone: "serious" },
  no_next_step: { label: "No next step", weight: 3, tone: "warning" },
  overdue_next_step: { label: "Next step overdue", weight: 2, tone: "warning" },
  low_health: { label: "Health < 40", weight: 4, tone: "critical" },
  value_change: { label: "Big value change", weight: 2, tone: "info" },
  pending_override: { label: "Override pending", weight: 2, tone: "info" },
};

export const LOW_HEALTH = 40;
/** A value change is "big" at ≥ 25 % and ≥ $10k, or ≥ $250k on its own. */
export const VALUE_CHANGE = { pct: 0.25, minUsd: 10_000, absUsd: 250_000 } as const;
/** "This week" = the trailing 7 days. */
export const WINDOW_DAYS = 7;

export type CloseDatePush = { from: Date | null; to: Date | null; at: Date };

export type ReviewDealInput = {
  stageCategory: "open" | "won" | "lost" | "hold";
  stageEnteredAt: Date;
  slaDays: number | null;
  expectedCloseDate: Date | null;
  nextStep: string | null;
  nextStepDueAt: Date | null;
  nextStepWaitingReason: string | null;
  healthScore: number | null;
  overrideStatus: string | null;
  valueUsd: number;
  /** Close-date edits inside the window (from the audit log), any order. */
  closeDatePushes?: CloseDatePush[];
  /** Gross value at the start of the window when value fields changed inside it; null = unchanged. */
  valueBeforeUsd?: number | null;
};

export type DealException = { kind: ExceptionKind; label: string; detail: string };

const days = (ms: number) => Math.floor(ms / DAY);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** All exceptions for one deal, in a stable order (EXCEPTION_KINDS). Closed deals have none. */
export function detectExceptions(d: ReviewDealInput, now: Date): DealException[] {
  if (d.stageCategory !== "open") return [];
  const out: DealException[] = [];
  const add = (kind: ExceptionKind, detail: string) => out.push({ kind, label: EXCEPTION_META[kind].label, detail });

  if (d.slaDays && d.slaDays > 0) {
    const inStage = days(now.getTime() - d.stageEnteredAt.getTime());
    if (inStage > d.slaDays) add("stalled", `${plural(inStage, "day")} in stage (SLA ${d.slaDays})`);
  }

  const pushes = (d.closeDatePushes ?? []).filter((p) => p.from && p.to && p.to.getTime() > p.from.getTime());
  if (d.expectedCloseDate && d.expectedCloseDate.getTime() < now.getTime()) {
    add("slipped_close", `Close date passed ${plural(Math.max(1, days(now.getTime() - d.expectedCloseDate.getTime())), "day")} ago`);
  } else if (pushes.length) {
    const sorted = [...pushes].sort((a, b) => a.at.getTime() - b.at.getTime());
    const first = sorted[0]!.from!;
    const last = sorted[sorted.length - 1]!.to!;
    const by = Math.max(1, days(last.getTime() - first.getTime()));
    add("slipped_close", `Pushed ${pushes.length > 1 ? `${pushes.length}× ` : ""}this week (+${plural(by, "day")})`);
  }

  const hasNext = Boolean(d.nextStep?.trim()) && d.nextStepDueAt != null;
  if (!hasNext && !d.nextStepWaitingReason?.trim()) add("no_next_step", d.nextStep?.trim() ? "Next step has no due date" : "Nothing planned");
  else if (hasNext && d.nextStepDueAt!.getTime() < now.getTime()) {
    add("overdue_next_step", `Due ${plural(Math.max(1, days(now.getTime() - d.nextStepDueAt!.getTime())), "day")} ago`);
  }

  if (d.healthScore != null && d.healthScore < LOW_HEALTH) add("low_health", `Health ${d.healthScore}`);

  const change = valueChange(d.valueBeforeUsd ?? null, d.valueUsd);
  if (change) add("value_change", change);

  if (d.overrideStatus === "pending") add("pending_override", "Probability override awaiting approval");
  return out;
}

/** "Value ↑ 40% this week ($1.2M → $1.7M)" when the change is big enough, else null. */
export function valueChange(before: number | null, after: number): string | null {
  if (before == null || !Number.isFinite(before) || !Number.isFinite(after)) return null;
  const delta = after - before;
  const abs = Math.abs(delta);
  if (abs === 0) return null;
  const pct = before > 0 ? abs / before : Infinity;
  const big = abs >= VALUE_CHANGE.absUsd || (pct >= VALUE_CHANGE.pct && abs >= VALUE_CHANGE.minUsd);
  if (!big) return null;
  const arrow = delta > 0 ? "↑" : "↓";
  const pctText = Number.isFinite(pct) ? ` ${Math.round(pct * 100)}%` : "";
  return `Value ${arrow}${pctText} this week (${fmtUsd(before, { compact: true })} → ${fmtUsd(after, { compact: true })})`;
}

/** Gross value before the window, given the current value inputs and the earliest "before" of each changed field. */
export function valueBeforeFromAudit(current: DealValueInput, earliestBefore: Record<string, unknown>): number | null {
  const keys = ["muu", "usdPerMuu", "contractValueCents", "annualizedValueCents"] as const;
  if (!keys.some((k) => k in earliestBefore)) return null;
  const prev: DealValueInput = { ...current };
  for (const k of keys) {
    if (!(k in earliestBefore)) continue;
    const raw = earliestBefore[k];
    const n = raw == null ? null : Number(raw);
    (prev as Record<string, unknown>)[k] = n != null && Number.isFinite(n) ? n : null;
  }
  return dealValue(prev).grossUsd;
}

/** Walk-through priority: more/heavier exceptions first, then bigger deals; stable by name. */
export function reviewScore(exceptions: DealException[], valueUsd: number): number {
  const w = exceptions.reduce((a, e) => a + EXCEPTION_META[e.kind].weight, 0);
  return w * (1 + Math.log10(1 + Math.max(0, valueUsd) / 10_000));
}

export function rankForReview<T extends { name: string; valueUsd: number; exceptions: DealException[] }>(rows: T[]): T[] {
  return rows
    .filter((r) => r.exceptions.length > 0)
    .map((r) => ({ r, score: reviewScore(r.exceptions, r.valueUsd) }))
    .sort((a, b) => b.score - a.score || a.r.name.localeCompare(b.r.name))
    .map((x) => x.r);
}

/** Count deals per exception kind (for the summary chips). */
export function exceptionCounts(rows: { exceptions: DealException[] }[]): Record<ExceptionKind, number> {
  const out = Object.fromEntries(EXCEPTION_KINDS.map((k) => [k, 0])) as Record<ExceptionKind, number>;
  for (const r of rows) for (const e of r.exceptions) out[e.kind]++;
  return out;
}

/* ───────────── Decisions & recap ───────────── */

export const OUTCOMES = ["keep", "push", "update", "escalate", "close_lost"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OUTCOME_LABELS: Record<Outcome, string> = {
  keep: "Keep",
  push: "Push date",
  update: "Update next step",
  escalate: "Escalate",
  close_lost: "Close lost",
};
export const OUTCOME_PAST: Record<Outcome, string> = {
  keep: "Kept as is",
  push: "Close date pushed",
  update: "Next step updated",
  escalate: "Escalated",
  close_lost: "Closed lost",
};
/** Keyboard digits for the outcome buttons (1–5). */
export const OUTCOME_KEYS: Record<Outcome, string> = { keep: "1", push: "2", update: "3", escalate: "4", close_lost: "5" };

export type Decision = { dealId: string; outcome: Outcome; note?: string; taskId?: string | null; at: string };

/** Latest decision per deal (a deal can be revisited; the last call wins for the recap). */
export function latestDecisions(decisions: Decision[]): Map<string, Decision> {
  const out = new Map<string, Decision>();
  for (const d of [...decisions].sort((a, b) => a.at.localeCompare(b.at))) out.set(d.dealId, d);
  return out;
}

export function outcomeCounts(decisions: Decision[]): Record<Outcome, number> {
  const out = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  for (const d of latestDecisions(decisions).values()) out[d.outcome]++;
  return out;
}

/**
 * Recap post for the team feed / Slack. `names` maps dealId → display name; deals missing from it (restricted / not
 * visible to the whole team) are never named — they're only counted.
 */
export function recapText(input: { title: string; dealCount: number; decisions: Decision[]; names: Map<string, string> }): { title: string; body: string } {
  const latest = [...latestDecisions(input.decisions).values()];
  const counts = outcomeCounts(input.decisions);
  const tasks = input.decisions.filter((d) => d.taskId).length;
  const lines: string[] = [];
  const summary = OUTCOMES.filter((o) => counts[o] > 0).map((o) => `${counts[o]} ${OUTCOME_PAST[o].toLowerCase()}`);
  lines.push(
    `Reviewed ${latest.length} of ${plural(input.dealCount, "deal")}${summary.length ? ` — ${summary.join(", ")}` : ""}.${tasks ? ` ${plural(tasks, "task")} created.` : ""}`,
  );
  let hidden = 0;
  for (const o of OUTCOMES) {
    if (o === "keep") continue;
    const named = latest.filter((d) => d.outcome === o && input.names.has(d.dealId));
    hidden += latest.filter((d) => d.outcome === o && !input.names.has(d.dealId)).length;
    if (!named.length) continue;
    lines.push("");
    lines.push(`${OUTCOME_PAST[o]}:`);
    for (const d of named.slice(0, 15)) lines.push(`• ${input.names.get(d.dealId)}${d.note ? ` — ${d.note.slice(0, 160)}` : ""}`);
    if (named.length > 15) lines.push(`• +${named.length - 15} more`);
  }
  if (hidden) lines.push("", `${plural(hidden, "restricted deal")} not listed.`);
  return { title: input.title, body: lines.join("\n") };
}

/**
 * QA MAJ-21: a bulk-imported override (one approval covering many deals) is ONE decision, made in Approvals — not N
 * review rows. Removes the `pending_override` exception from deals covered by a bulk approval, drops rows left with
 * no exception, and reports how many deals each bulk approval accounted for (shown as a single card).
 */
export function foldBulkOverrides<R extends { id: string; exceptions: DealException[] }>(
  rows: R[],
  bulkByDeal: ReadonlyMap<string, string>,
): { rows: R[]; bulk: { approvalId: string; deals: number }[] } {
  const counts = new Map<string, number>();
  const out: R[] = [];
  for (const r of rows) {
    const approvalId = bulkByDeal.get(r.id);
    if (!approvalId || !r.exceptions.some((e) => e.kind === "pending_override")) {
      out.push(r);
      continue;
    }
    counts.set(approvalId, (counts.get(approvalId) ?? 0) + 1);
    const rest = r.exceptions.filter((e) => e.kind !== "pending_override");
    if (rest.length) out.push({ ...r, exceptions: rest });
  }
  return { rows: out, bulk: [...counts].map(([approvalId, deals]) => ({ approvalId, deals })) };
}
