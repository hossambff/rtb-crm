/**
 * Forecast autopilot core (docs/V2_SPEC.md A9, PRD §14.4, P5). Pure — no server deps; unit tested.
 *
 * - `forecastWeekOf`  → the Monday (YYYY-MM-DD) of the week containing an instant, in a time zone.
 * - `quarterKey`      → "2026-Q4" for a date-only close date (stored at 17:00 local, same UTC day — see src/lib/time.ts).
 * - `suggestForecast` → commit / best / pipeline / omitted with human-readable reasons, from stage probability, health,
 *                       activity recency, pending deal signals, close-date slips and next-step hygiene.
 * - `effectiveCategory`, `overrideNeedsReason`, `rollUp`, `weekOverWeek` → the rules the UI and roll-ups share.
 *
 * Forecast categories never change a deal's probability (DEAL-4 overrides stay a separate, approval-gated path).
 */
import { localDateKey, toWall } from "@/lib/alerts/time";

export const CATEGORIES = ["commit", "best", "pipeline", "omitted"] as const;
export type ForecastCategory = (typeof CATEGORIES)[number];
export const CATEGORY_LABELS: Record<ForecastCategory, string> = { commit: "Commit", best: "Best case", pipeline: "Pipeline", omitted: "Omitted" };
const RANK: Record<ForecastCategory, number> = { commit: 3, best: 2, pipeline: 1, omitted: 0 };
const BY_RANK: ForecastCategory[] = ["omitted", "pipeline", "best", "commit"];

export function isCategory(v: unknown): v is ForecastCategory {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

/* ───────────── Calendar ───────────── */

const DAY = 86_400_000;

/** Monday (YYYY-MM-DD) of the local week containing `now` in `tz`. */
export function forecastWeekOf(now: Date, tz: string): string {
  const wall = toWall(now, tz);
  const dow = (wall.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()) - dow * DAY);
  return monday.toISOString().slice(0, 10);
}

/** The Monday one week before `weekOf`. */
export function previousWeek(weekOf: string): string {
  return new Date(Date.parse(`${weekOf}T00:00:00Z`) - 7 * DAY).toISOString().slice(0, 10);
}

/** "YYYY-Qn" for a YYYY-MM-DD date. */
export function quarterOfDateKey(dateKey: string): string {
  const y = Number(dateKey.slice(0, 4));
  const m = Number(dateKey.slice(5, 7));
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** Quarter of a stored close date. Date-only values keep their calendar day in UTC (dateOnlyToInstant). */
export function quarterKey(d: Date): string {
  return quarterOfDateKey(d.toISOString().slice(0, 10));
}

export function nextQuarter(q: string): string {
  const y = Number(q.slice(0, 4));
  const n = Number(q.slice(6));
  return n === 4 ? `${y + 1}-Q1` : `${y}-Q${n + 1}`;
}

/** Quarters between two keys (b − a), e.g. 2026-Q4 → 2027-Q1 = 1. */
export function quarterDiff(a: string, b: string): number {
  const idx = (q: string) => Number(q.slice(0, 4)) * 4 + Number(q.slice(6)) - 1;
  return idx(b) - idx(a);
}

/** The forecast window: the current quarter (in `tz`) and the next one. */
export function forecastWindow(now: Date, tz: string): { current: string; next: string } {
  const current = quarterOfDateKey(localDateKey(now, tz));
  return { current, next: nextQuarter(current) };
}

export function quarterLabel(q: string): string {
  return `Q${q.slice(6)} ${q.slice(0, 4)}`;
}

/* ───────────── Suggestion ───────────── */

export type SignalKind = "advance" | "close_date" | "stall" | "risk" | "won" | "lost";

export type SuggestInput = {
  now: Date;
  /** Effective probability 0..1 (approved override, else stage). */
  probability: number;
  stageName: string;
  /** True when the probability comes from an approved manual override (flagged in the reasons, P5). */
  overridden?: boolean;
  healthScore: number | null;
  lastActivityAt: Date | null;
  createdAt: Date;
  expectedCloseDate: Date;
  /** Current-quarter key in the owner's zone (from forecastWindow). */
  currentQuarter: string;
  nextStep: string | null;
  nextStepDueAt: Date | null;
  nextStepWaitingReason?: string | null;
  /** Pending (undecided) deal signals from email / transcripts. */
  signals: { kind: SignalKind; quote?: string | null }[];
  /** Earliest close quarter this deal was ever forecast in (slip detection); null = first time. */
  firstForecastQuarter: string | null;
  /** Close quarter in last week's forecast entry, if any. */
  lastWeekQuarter?: string | null;
};

/** `headline` = the reason that decided the category (last change), else the stage baseline. */
export type Suggestion = { category: ForecastCategory; reasons: string[]; headline: string };

const pct = (p: number) => `${Math.round(p * 100)}%`;

function capAt(cur: ForecastCategory, max: ForecastCategory): ForecastCategory {
  return RANK[cur] > RANK[max] ? max : cur;
}
function down(cur: ForecastCategory, steps = 1): ForecastCategory {
  return BY_RANK[Math.max(0, RANK[cur] - steps)]!;
}
function up(cur: ForecastCategory): ForecastCategory {
  return BY_RANK[Math.min(3, RANK[cur] + 1)]!;
}

function quoteOf(q: string | null | undefined): string {
  if (!q) return "";
  const t = q.replace(/\s+/g, " ").trim();
  return t ? ` (“${t.length > 60 ? `${t.slice(0, 57)}…` : t}”)` : "";
}

/**
 * Weekly category suggestion with the reasons that produced it (first reason = the baseline, then each adjustment).
 * Deterministic and explainable: reps see exactly why, and the suggestion never silently changes a confirmed number.
 */
export function suggestForecast(i: SuggestInput): Suggestion {
  const reasons: string[] = [];
  const p = Math.min(1, Math.max(0, Number.isFinite(i.probability) ? i.probability : 0));
  let cat: ForecastCategory = p >= 0.9 ? "commit" : p >= 0.5 ? "best" : p >= 0.1 ? "pipeline" : "omitted";
  let seen = cat;
  let headline = "";
  const push = (r: string) => {
    reasons.push(r);
    if (cat !== seen || !headline) headline = r;
    seen = cat;
  };
  push(`${i.stageName} at ${pct(p)}${i.overridden ? " (approved override)" : ""} → ${CATEGORY_LABELS[cat]}`);

  // Signals: an explicit lost signal outweighs everything; won/advance lift one level; stall/risk drop one.
  const kinds = new Set(i.signals.map((s) => s.kind));
  const first = (k: SignalKind) => i.signals.find((s) => s.kind === k);
  if (kinds.has("lost")) {
    cat = "omitted";
    push(`Lost signal${quoteOf(first("lost")?.quote)} — omit until reviewed`);
  } else {
    if (kinds.has("won") || kinds.has("advance")) {
      const k = kinds.has("won") ? "won" : "advance";
      const before = cat;
      cat = up(cat);
      if (cat !== before) push(`${k === "won" ? "Won" : "Advance"} signal${quoteOf(first(k)?.quote)} → up to ${CATEGORY_LABELS[cat]}`);
    }
    if (kinds.has("stall") || kinds.has("risk")) {
      const k = kinds.has("risk") ? "risk" : "stall";
      const before = cat;
      cat = down(cat);
      if (cat !== before) push(`${k === "risk" ? "Risk" : "Stall"} signal${quoteOf(first(k)?.quote)} → down to ${CATEGORY_LABELS[cat]}`);
    }
    if (kinds.has("close_date")) push(`Close-date signal${quoteOf(first("close_date")?.quote)} — check the date`);
  }

  // Health
  if (i.healthScore != null) {
    if (i.healthScore < 25 && RANK[cat] > RANK.pipeline) {
      cat = "pipeline";
      push(`Health ${i.healthScore} (critical) → at most Pipeline`);
    } else if (i.healthScore < 45 && cat === "commit") {
      cat = "best";
      push(`Health ${i.healthScore} (at risk) → Best case, not Commit`);
    }
  }

  // Activity recency
  const last = i.lastActivityAt ?? null;
  const idleDays = Math.floor((i.now.getTime() - (last ?? i.createdAt).getTime()) / DAY);
  if (idleDays > 60 && RANK[cat] > RANK.pipeline) {
    cat = "pipeline";
    push(`No activity for ${idleDays} days → at most Pipeline`);
  } else if (idleDays > 21 && cat === "commit") {
    cat = "best";
    push(`No activity for ${idleDays} days → Best case, not Commit`);
  } else if (last && idleDays <= 7 && cat !== "omitted") {
    push(`Active: last touch ${idleDays === 0 ? "today" : `${idleDays} day${idleDays === 1 ? "" : "s"} ago`}`);
  }

  // Close date
  const closeQ = quarterKey(i.expectedCloseDate);
  if (i.expectedCloseDate.getTime() < i.now.getTime() - DAY) {
    if (cat === "commit") cat = "best";
    push(`Expected close date has passed — update it${cat === "best" ? " (Best case until then)" : ""}`);
  }
  if (i.lastWeekQuarter && quarterDiff(i.lastWeekQuarter, closeQ) > 0) {
    push(`Close date slipped from ${quarterLabel(i.lastWeekQuarter)} to ${quarterLabel(closeQ)} this week`);
  }
  const slips = i.firstForecastQuarter ? Math.max(0, quarterDiff(i.firstForecastQuarter, closeQ)) : 0;
  if (slips >= 2 && RANK[cat] > RANK.pipeline) {
    cat = down(cat);
    push(`Close date slipped ${slips} quarters since first forecast → down to ${CATEGORY_LABELS[cat]}`);
  } else if (slips === 1 && cat === "commit") {
    cat = "best";
    push(`Close date slipped a quarter since first forecast → Best case, not Commit`);
  }

  // Next-step hygiene (DEAL-3): Commit needs a live next step.
  const overdueNext = i.nextStepDueAt != null && i.nextStepDueAt.getTime() < i.now.getTime();
  if (!i.nextStep && !i.nextStepWaitingReason) {
    if (cat === "commit") cat = "best";
    push(`No next step${RANK[cat] >= RANK.best ? " — Commit needs one" : ""}`);
  } else if (overdueNext && cat === "commit") {
    cat = "best";
    push("Next step overdue → Best case, not Commit");
  }

  // Close date beyond the current quarter: commit is for this quarter only.
  if (cat === "commit" && quarterDiff(i.currentQuarter, closeQ) > 0) {
    cat = "best";
    push(`Closes ${quarterLabel(closeQ)} → Best case (Commit is for this quarter)`);
  }

  return { category: capAt(cat, "commit"), reasons, headline };
}

/** Stage-probability-only suggestion (autopilot.forecastSuggest = off). */
export function stageOnlySuggestion(probability: number, stageName: string): Suggestion {
  const p = Math.min(1, Math.max(0, probability || 0));
  const cat: ForecastCategory = p >= 0.9 ? "commit" : p >= 0.5 ? "best" : p >= 0.1 ? "pipeline" : "omitted";
  const r = `${stageName} at ${pct(p)} → ${CATEGORY_LABELS[cat]} (stage probability only — suggestions are off)`;
  return { category: cat, reasons: [r], headline: r };
}

/* ───────────── Decisions ───────────── */

export type EntryState = "confirmed" | "carried" | "unconfirmed";

/**
 * The category that counts in roll-ups. A human decision stands until a human changes it (PRD §14.4: the system never
 * replaces it silently): this week's confirmation → the last confirmation → the suggestion (flagged unconfirmed).
 */
export function effectiveCategory(e: { category: ForecastCategory | null; lastConfirmed: ForecastCategory | null; suggested: ForecastCategory }): {
  category: ForecastCategory;
  state: EntryState;
} {
  if (e.category) return { category: e.category, state: "confirmed" };
  if (e.lastConfirmed) return { category: e.lastConfirmed, state: "carried" };
  return { category: e.suggested, state: "unconfirmed" };
}

/** Needs the rep's attention this week: never confirmed, or the suggestion disagrees with the last confirmation. */
export function needsConfirmation(e: { category: ForecastCategory | null; lastConfirmed: ForecastCategory | null; suggested: ForecastCategory }): boolean {
  if (e.category) return false;
  return e.lastConfirmed == null || e.lastConfirmed !== e.suggested;
}

/**
 * Overriding the suggestion needs a reason when it moves a deal into Commit, or out of Commit (the suggestion or the
 * previous call was Commit). Accepting the suggestion never does — its reasons are recorded with it.
 */
export function overrideNeedsReason(o: { chosen: ForecastCategory; suggested: ForecastCategory; previous: ForecastCategory | null }): boolean {
  if (o.chosen === o.suggested) return false;
  return o.chosen === "commit" || o.suggested === "commit" || o.previous === "commit";
}

/* ───────────── Roll-ups ───────────── */

export type RollupRow = {
  dealId: string;
  ownerId: string | null;
  pipelineKey: string;
  period: string;
  category: ForecastCategory;
  state: EntryState;
  grossUsd: number;
  weightedUsd: number;
};

export type Bucket = { deals: number; grossUsd: number; weightedUsd: number; unconfirmed: number };
export type Rollup = Record<ForecastCategory, Bucket> & { total: Bucket };

export function emptyRollup(): Rollup {
  const b = (): Bucket => ({ deals: 0, grossUsd: 0, weightedUsd: 0, unconfirmed: 0 });
  return { commit: b(), best: b(), pipeline: b(), omitted: b(), total: b() };
}

export function addToRollup(r: Rollup, row: Pick<RollupRow, "category" | "state" | "grossUsd" | "weightedUsd">): Rollup {
  for (const b of [r[row.category], r.total]) {
    b.deals++;
    b.grossUsd += row.grossUsd;
    b.weightedUsd += row.weightedUsd;
    if (row.state === "unconfirmed") b.unconfirmed++;
  }
  return r;
}

/** Group rows by a key (rep, motion, quarter, "quarter|motion") into roll-ups. */
export function rollUpBy(rows: RollupRow[], key: (r: RollupRow) => string): Map<string, Rollup> {
  const out = new Map<string, Rollup>();
  for (const r of rows) {
    const k = key(r);
    addToRollup(out.get(k) ?? out.set(k, emptyRollup()).get(k)!, r);
  }
  return out;
}

/* ───────────── Week over week ───────────── */

export type WowPrev = { category: ForecastCategory; weightedUsd: number; period: string } | null;
export type WowCurr = { category: ForecastCategory; weightedUsd: number; period: string; note?: string | null } | null;
export type WowChange = {
  kind: "added" | "removed" | "upgraded" | "downgraded" | "value" | "slipped" | "pulled_in";
  from: ForecastCategory | null;
  to: ForecastCategory | null;
  deltaWeightedUsd: number;
  reason: string;
};

/**
 * What changed for one deal since last week, with a reason. `exit` explains why a deal left the forecast
 * (won / lost / close date moved out / deleted). Returns null when nothing material changed (< $1 and same category).
 */
export function weekOverWeek(prev: WowPrev, curr: WowCurr, exit?: string | null): WowChange | null {
  if (!prev && !curr) return null;
  if (!prev && curr) {
    return { kind: "added", from: null, to: curr.category, deltaWeightedUsd: curr.weightedUsd, reason: `New in forecast as ${CATEGORY_LABELS[curr.category]} (${quarterLabel(curr.period)})` };
  }
  if (prev && !curr) {
    return { kind: "removed", from: prev.category, to: null, deltaWeightedUsd: -prev.weightedUsd, reason: exit ?? "Left the forecast window" };
  }
  const p = prev!;
  const c = curr!;
  const delta = c.weightedUsd - p.weightedUsd;
  const note = c.note ? ` — “${c.note}”` : "";
  if (p.category !== c.category) {
    const kind = RANK[c.category] > RANK[p.category] ? "upgraded" : "downgraded";
    return { kind, from: p.category, to: c.category, deltaWeightedUsd: delta, reason: `${CATEGORY_LABELS[p.category]} → ${CATEGORY_LABELS[c.category]}${note}` };
  }
  const qd = quarterDiff(p.period, c.period);
  if (qd !== 0) {
    return {
      kind: qd > 0 ? "slipped" : "pulled_in",
      from: p.category,
      to: c.category,
      deltaWeightedUsd: delta,
      reason: `Close moved ${qd > 0 ? "out" : "in"}: ${quarterLabel(p.period)} → ${quarterLabel(c.period)}`,
    };
  }
  if (Math.abs(delta) >= 1) {
    return { kind: "value", from: p.category, to: c.category, deltaWeightedUsd: delta, reason: `Weighted value ${delta > 0 ? "up" : "down"} (value or probability changed)` };
  }
  return null;
}

/** Reason text with numbers masked — used to decide whether a stored suggestion changed materially (CR L9). */
export function reasonShape(t: string | null | undefined): string {
  return (t ?? "").replace(/\d+([.,]\d+)?/g, "#");
}
