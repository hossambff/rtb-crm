import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealValue } from "@/lib/pipeline-math";
import { dealAccessWhere, scopeFor, type AppUser } from "@/lib/rbac/server";
import { safeTz } from "@/lib/time";
import { sumUnscheduled } from "./unscheduled";
import {
  CATEGORY_LABELS,
  effectiveCategory,
  forecastWeekOf,
  forecastWindow,
  isCategory,
  needsConfirmation,
  previousWeek,
  quarterDiff,
  quarterKey,
  quarterLabel,
  reasonShape,
  stageOnlySuggestion,
  suggestForecast,
  weekOverWeek,
  type EntryState,
  type ForecastCategory,
  type SignalKind,
  type WowChange,
} from "./core";

/**
 * Forecast autopilot (V2 A9) — server side. ONE loader feeds /forecast (all three views), the deal badge and the Today
 * provider, so every number is computed the same way:
 *
 * - Universe = the OPEN deals the user may view (dealAccessWhere incl. the MNPI access list) on ACTIVE pipelines,
 *   narrowed to the requested owners. That is exactly the set the Pipelines overview totals (pipelineOverview), so the
 *   forecast reconciles to it: in-window + close passed + beyond window + no close date = open pipeline.
 * - Values come from pipeline-math `dealValue` (MUU × $/MUU, approved overrides honored) — weighted GROSS basis, which
 *   is what the Pipelines overview shows as "Weighted". Net is never computed here (rev share is a hidden field for some roles).
 * - Weekly entries (rso.forecast_entries, unique deal+week) are written lazily and idempotently on the first view of
 *   the week (`persist: true`), and refreshed when the suggestion or values change. A rep's confirmation is never
 *   overwritten by the system.
 */

export type ForecastScope = "mine" | "team" | "company";

export type ForecastDeal = {
  dealId: string;
  name: string;
  accountName: string | null;
  pipelineKey: string;
  pipelineName: string;
  pipelineColor: string;
  unit: "muu" | "usd" | "activation";
  stageName: string;
  ownerId: string | null;
  ownerName: string | null;
  closeDate: string; // ISO
  period: string;
  weekOf: string;
  probability: number;
  overridden: boolean;
  muu: number;
  grossUsd: number;
  weightedUsd: number;
  healthScore: number | null;
  restricted: boolean;
  suggested: ForecastCategory;
  reasons: string[];
  headline: string;
  engine: "heuristic" | "stage";
  category: ForecastCategory | null; // confirmed this week
  note: string | null;
  confirmedAt: string | null;
  /** QA POL-16: who made this week's call when it wasn't the owner (a manager's save), else null. */
  confirmedByName: string | null;
  lastConfirmed: ForecastCategory | null;
  lastConfirmedWeek: string | null;
  effective: ForecastCategory;
  state: EntryState;
  needsConfirmation: boolean;
  canEdit: boolean;
  change: WowChange | null;
};

export type ReconBucket = { deals: number; grossUsd: number; weightedUsd: number };
export type Reconciliation = {
  /** All open deals in scope = the Pipelines overview universe. */
  open: ReconBucket;
  inWindow: ReconBucket;
  closePassed: ReconBucket;
  beyondWindow: ReconBucket;
  noCloseDate: ReconBucket;
  byMotion: { key: string; name: string; color: string; open: ReconBucket; inWindow: ReconBucket }[];
  /**
   * "Unscheduled" (open deals without an expected close date) per `${pipelineKey}|${ownerId ?? ""}` so the page can show
   * the bucket under any motion / owner filter. Never part of commit / best totals.
   */
  unscheduledBy: Record<string, ReconBucket>;
};

export type ForecastResult = {
  scope: ForecastScope;
  weekOf: string; // viewer's week
  window: { current: string; next: string };
  deals: ForecastDeal[];
  removed: { dealId: string; name: string; ownerId: string | null; pipelineKey: string; change: WowChange }[];
  hasLastWeek: boolean;
  recon: Reconciliation;
  owners: { id: string; name: string }[];
  generatedAt: string;
  /** More than MAX_DEALS open deals matched — the forecast covers the first MAX_DEALS (by id). */
  truncated: boolean;
};

const MAX_DEALS = 6000;

/** Views the user may open. Team = leaders or anyone with direct reports/teammates; Company = org-wide analytics. */
export async function forecastScopes(user: AppUser): Promise<ForecastScope[]> {
  const out: ForecastScope[] = ["mine"];
  const leaderRole = ["sales_leader", "executive", "admin", "super_admin"].includes(user.role);
  if (leaderRole || user.teamMemberIds.length > 1) out.push("team");
  const analytics = await scopeFor(user, "analytics", "view");
  if (analytics === "all" && ["executive", "admin", "super_admin", "finance"].includes(user.role)) out.push("company");
  return out;
}

function ownerFilter(user: AppUser, scope: ForecastScope): SQL | undefined {
  if (scope === "mine") return eq(s.deals.ownerId, user.id);
  if (scope === "team") return inArray(s.deals.ownerId, user.teamMemberIds.length ? user.teamMemberIds : [user.id]);
  return undefined;
}

const emptyBucket = (): ReconBucket => ({ deals: 0, grossUsd: 0, weightedUsd: 0 });
const unscheduledKey = (pipelineKey: string, ownerId: string | null) => `${pipelineKey}|${ownerId ?? ""}`;

/** The Unscheduled bucket under the page's motion / owner filters (null filter = all). */
export function unscheduledFor(recon: Reconciliation, motion: string | null, ownerId: string | null): ReconBucket {
  return sumUnscheduled(recon.unscheduledBy, motion, ownerId);
}
const addB = (b: ReconBucket, g: number, w: number) => {
  b.deals++;
  b.grossUsd += g;
  b.weightedUsd += w;
};

/**
 * Build the forecast for a scope (optionally a single deal). With `persist`, writes this week's entries (missing or
 * changed suggestions/values) — idempotent via the (deal, week) unique index.
 */
export async function buildForecast(
  user: AppUser,
  scope: ForecastScope,
  opts: { persist?: boolean; dealId?: string; now?: Date; /** Skip the week-over-week "left the forecast" query (Today provider, badge). */ lite?: boolean } = {},
): Promise<ForecastResult> {
  const now = opts.now ?? new Date();
  const viewerTz = safeTz(user.timezone);
  const access = await dealAccessWhere(user, "view");
  const editAccess = await dealAccessWhere(user, "edit");
  const owner = alias(s.user, "fc_owner");
  const conds: SQL[] = [access, eq(s.pipelines.active, true), eq(s.stages.category, "open")];
  const of = ownerFilter(user, scope);
  if (of) conds.push(of);
  if (opts.dealId) conds.push(eq(s.deals.id, opts.dealId));
  const where = and(...conds)!;

  const rows = await db
    .select({
      id: s.deals.id,
      name: s.deals.name,
      ownerId: s.deals.ownerId,
      ownerName: owner.name,
      ownerTz: owner.timezone,
      accountName: s.accounts.name,
      pipelineKey: s.pipelines.key,
      pipelineName: s.pipelines.name,
      pipelineColor: s.pipelines.color,
      pipelineSort: s.pipelines.sortOrder,
      unit: s.pipelines.unit,
      pipelineUsdPerMuu: s.pipelines.usdPerMuu,
      pipelineRevSharePct: s.pipelines.defaultRevSharePct,
      stageName: s.stages.name,
      stageProbability: s.stages.probability,
      muu: s.deals.muu,
      usdPerMuu: s.deals.usdPerMuu,
      revSharePct: s.deals.revSharePct,
      contractValueCents: s.deals.contractValueCents,
      annualizedValueCents: s.deals.annualizedValueCents,
      probabilityOverride: s.deals.probabilityOverride,
      overrideStatus: s.deals.overrideStatus,
      expectedCloseDate: s.deals.expectedCloseDate,
      healthScore: s.deals.healthScore,
      lastActivityAt: s.deals.lastActivityAt,
      createdAt: s.deals.createdAt,
      nextStep: s.deals.nextStep,
      nextStepDueAt: s.deals.nextStepDueAt,
      nextStepWaitingReason: s.deals.nextStepWaitingReason,
      restricted: s.deals.restricted,
      autopilot: s.userPrefs.autopilot,
      canEdit: sql<boolean>`(${editAccess})`,
    })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .leftJoin(owner, eq(owner.id, s.deals.ownerId))
    .leftJoin(s.userPrefs, eq(s.userPrefs.userId, s.deals.ownerId))
    .where(where)
    .orderBy(s.deals.id) // deterministic truncation (CR L9)
    .limit(MAX_DEALS + 1);
  const truncated = rows.length > MAX_DEALS;
  if (truncated) rows.length = MAX_DEALS;

  // ── Partition (reconciliation) + window per owner's zone
  const recon: Reconciliation = { open: emptyBucket(), inWindow: emptyBucket(), closePassed: emptyBucket(), beyondWindow: emptyBucket(), noCloseDate: emptyBucket(), byMotion: [], unscheduledBy: {} };
  const motions = new Map<string, Reconciliation["byMotion"][number] & { sort: number }>();
  type Row = (typeof rows)[number] & { tz: string; weekOf: string; period: string; window: { current: string; next: string }; v: ReturnType<typeof dealValue> };
  const inWindow: Row[] = [];
  for (const r of rows) {
    const v = dealValue({
      unit: r.unit,
      muu: r.muu,
      usdPerMuu: r.usdPerMuu,
      pipelineUsdPerMuu: r.pipelineUsdPerMuu,
      revSharePct: r.revSharePct,
      pipelineRevSharePct: r.pipelineRevSharePct,
      contractValueCents: r.contractValueCents,
      annualizedValueCents: r.annualizedValueCents,
      stageProbability: r.stageProbability,
      probabilityOverride: r.probabilityOverride,
      overrideStatus: r.overrideStatus,
    });
    const m = motions.get(r.pipelineKey) ?? motions.set(r.pipelineKey, { key: r.pipelineKey, name: r.pipelineName, color: r.pipelineColor, sort: r.pipelineSort, open: emptyBucket(), inWindow: emptyBucket() }).get(r.pipelineKey)!;
    addB(recon.open, v.grossUsd, v.weightedGrossUsd);
    addB(m.open, v.grossUsd, v.weightedGrossUsd);
    if (!r.expectedCloseDate) {
      addB(recon.noCloseDate, v.grossUsd, v.weightedGrossUsd);
      const k = unscheduledKey(r.pipelineKey, r.ownerId);
      addB((recon.unscheduledBy[k] ??= emptyBucket()), v.grossUsd, v.weightedGrossUsd);
      continue;
    }
    const tz = safeTz(r.ownerTz ?? viewerTz);
    const window = forecastWindow(now, tz);
    const period = quarterKey(r.expectedCloseDate);
    const d = quarterDiff(window.current, period);
    if (d < 0) {
      addB(recon.closePassed, v.grossUsd, v.weightedGrossUsd);
      continue;
    }
    if (d > 1) {
      addB(recon.beyondWindow, v.grossUsd, v.weightedGrossUsd);
      continue;
    }
    addB(recon.inWindow, v.grossUsd, v.weightedGrossUsd);
    addB(m.inWindow, v.grossUsd, v.weightedGrossUsd);
    inWindow.push({ ...r, tz, weekOf: forecastWeekOf(now, tz), period, window, v });
  }
  recon.byMotion = [...motions.values()].sort((a, b) => a.sort - b.sort).map(({ sort, ...rest }) => (void sort, rest));

  // ── History: entries of the last 14 weeks for these deals (this week, last week, first forecast quarter) and the
  // latest confirmation before this week (no age limit).
  const viewerWeek = forecastWeekOf(now, viewerTz);
  const since = new Date(Date.parse(`${viewerWeek}T00:00:00Z`) - 14 * 7 * 86_400_000).toISOString().slice(0, 10);
  const histConds = and(where, gte(s.forecastEntries.weekOf, since))!;
  const histCols = {
    dealId: s.forecastEntries.dealId,
    weekOf: s.forecastEntries.weekOf,
    period: s.forecastEntries.period,
    suggested: s.forecastEntries.suggestedCategory,
    reason: s.forecastEntries.suggestedReason,
    category: s.forecastEntries.category,
    note: s.forecastEntries.note,
    confirmedAt: s.forecastEntries.confirmedAt,
    confirmedBy: s.forecastEntries.confirmedBy,
    weightedCents: s.forecastEntries.weightedCents,
    grossCents: s.forecastEntries.grossCents,
    ownerId: s.forecastEntries.ownerId,
  };
  // Single deal (deal-page badge, perf H-4): the row above already passed the access filter, so read ALL of its entries
  // in one plain indexed lookup (covers the 14-week window AND the latest older confirmation — no second query).
  const single = opts.dealId && inWindow.length === 1 ? opts.dealId : null;
  const singleHist = single
    ? await db.select(histCols).from(s.forecastEntries).where(eq(s.forecastEntries.dealId, single)).orderBy(desc(s.forecastEntries.weekOf)).limit(260)
    : null;
  const hist = singleHist
    ? singleHist.filter((h) => h.weekOf >= since)
    : inWindow.length
      ? await db
          .select(histCols)
          .from(s.forecastEntries)
          .innerJoin(s.deals, eq(s.deals.id, s.forecastEntries.dealId))
          .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
          .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
          .where(histConds)
          .orderBy(desc(s.forecastEntries.weekOf))
      : [];
  const histBy = new Map<string, typeof hist>();
  for (const h of hist) (histBy.get(h.dealId) ?? histBy.set(h.dealId, []).get(h.dealId)!).push(h);
  // Names of people who confirmed on someone else's deal (manager saves), for the "Set by" marker.
  const ownerOf = new Map(inWindow.map((r) => [r.id, r.ownerId]));
  const setByIds = Array.from(new Set(hist.filter((h) => h.confirmedBy && h.category && h.confirmedBy !== ownerOf.get(h.dealId)).map((h) => h.confirmedBy!)));
  const setByName = new Map(
    setByIds.length ? (await db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(inArray(s.user.id, setByIds))).map((u) => [u.id, u.name]) : [],
  );
  // Latest confirmation older than the 14-week window (rare; carried decisions must still count).
  const oldConfirmed = new Map<string, { category: string; weekOf: string }>();
  if (singleHist) {
    const old = singleHist.find((h) => h.weekOf < since && h.category);
    if (old?.category) oldConfirmed.set(old.dealId, { category: old.category, weekOf: old.weekOf });
  }
  const needOld = !singleHist && inWindow.filter((r) => !(histBy.get(r.id) ?? []).some((h) => h.category && h.weekOf < r.weekOf)).length > 0;
  if (needOld && inWindow.length) {
    const rowsOld = await db
      .selectDistinctOn([s.forecastEntries.dealId], { dealId: s.forecastEntries.dealId, category: s.forecastEntries.category, weekOf: s.forecastEntries.weekOf })
      .from(s.forecastEntries)
      .innerJoin(s.deals, eq(s.deals.id, s.forecastEntries.dealId))
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
      .where(and(where, lt(s.forecastEntries.weekOf, since), isNotNull(s.forecastEntries.category)))
      .orderBy(s.forecastEntries.dealId, desc(s.forecastEntries.weekOf));
    for (const o of rowsOld) if (o.category) oldConfirmed.set(o.dealId, { category: o.category, weekOf: o.weekOf });
  }

  // Badge fast path: this week's entry already carries the system suggestion (written by /forecast or the Monday job) —
  // reuse it instead of recomputing (which needs the pending-signals query). Read-only callers only.
  const storedSuggestion = (r: (typeof inWindow)[number]) => {
    if (!single || opts.persist) return null;
    const e = (histBy.get(r.id) ?? []).find((x) => x.weekOf === r.weekOf);
    if (!e || !isCategory(e.suggested)) return null;
    const reasons = (e.reason ?? "").split("\n").filter(Boolean);
    return { category: e.suggested as ForecastCategory, reasons, headline: reasons[0] ?? CATEGORY_LABELS[e.suggested as ForecastCategory] };
  };
  const reuse = inWindow.length === 1 && storedSuggestion(inWindow[0]!) != null;

  // ── Pending signals
  const signals = inWindow.length && !reuse
    ? await db
        .select({ dealId: s.dealSignals.dealId, kind: s.dealSignals.kind, quote: s.dealSignals.quote })
        .from(s.dealSignals)
        .innerJoin(s.deals, eq(s.deals.id, s.dealSignals.dealId))
        .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
        .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
        .where(and(where, eq(s.dealSignals.status, "pending")))
        .orderBy(desc(s.dealSignals.createdAt))
    : [];
  const sigBy = new Map<string, { kind: SignalKind; quote: string | null }[]>();
  for (const g of signals) (sigBy.get(g.dealId) ?? sigBy.set(g.dealId, []).get(g.dealId)!).push({ kind: g.kind as SignalKind, quote: g.quote });

  // ── Suggest + assemble
  const deals: ForecastDeal[] = [];
  const writes: (typeof s.forecastEntries.$inferInsert)[] = [];
  for (const r of inWindow) {
    const h = histBy.get(r.id) ?? [];
    const thisWeek = h.find((x) => x.weekOf === r.weekOf) ?? null;
    const prevWeekKey = previousWeek(r.weekOf);
    const lastWeek = h.find((x) => x.weekOf === prevWeekKey) ?? null;
    const confirmedBefore = h.find((x) => x.weekOf < r.weekOf && isCategory(x.category));
    const lastConf = confirmedBefore ? { category: confirmedBefore.category as ForecastCategory, weekOf: confirmedBefore.weekOf } : oldConfirmed.has(r.id) && isCategory(oldConfirmed.get(r.id)!.category) ? { category: oldConfirmed.get(r.id)!.category as ForecastCategory, weekOf: oldConfirmed.get(r.id)!.weekOf } : null;
    const firstQ = h.length ? h.reduce((min, x) => (quarterDiff(x.period, min) > 0 ? x.period : min), h[0]!.period) : null;
    const suggestOn = r.autopilot?.forecastSuggest !== false;
    const sug = (suggestOn ? storedSuggestion(r) : null) ?? (suggestOn
      ? suggestForecast({
          now,
          probability: r.v.probability,
          stageName: r.stageName,
          overridden: r.v.overridden,
          healthScore: r.healthScore,
          lastActivityAt: r.lastActivityAt,
          createdAt: r.createdAt,
          expectedCloseDate: r.expectedCloseDate!,
          currentQuarter: r.window.current,
          nextStep: r.nextStep,
          nextStepDueAt: r.nextStepDueAt,
          nextStepWaitingReason: r.nextStepWaitingReason,
          signals: sigBy.get(r.id) ?? [],
          firstForecastQuarter: firstQ,
          lastWeekQuarter: lastWeek?.period ?? null,
        })
      : stageOnlySuggestion(r.v.probability, r.stageName));
    const confirmed = thisWeek && isCategory(thisWeek.category) ? (thisWeek.category as ForecastCategory) : null;
    const eff = effectiveCategory({ category: confirmed, lastConfirmed: lastConf?.category ?? null, suggested: sug.category });
    const weightedCents = Math.round(r.v.weightedGrossUsd * 100);
    const grossCents = Math.round(r.v.grossUsd * 100);
    const reasonText = sug.reasons.join("\n");
    if (
      opts.persist &&
      (!thisWeek ||
        thisWeek.suggested !== sug.category ||
        // CR L9: day counts in the reasons ("No activity for 8 days") change daily — don't rewrite every row on the
        // first view of each day for that; only a material change of the reasons (numbers ignored) counts.
        reasonShape(thisWeek.reason) !== reasonShape(reasonText) ||
        thisWeek.period !== r.period ||
        Number(thisWeek.weightedCents) !== weightedCents ||
        Number(thisWeek.grossCents) !== grossCents ||
        thisWeek.ownerId !== r.ownerId)
    ) {
      writes.push({ dealId: r.id, weekOf: r.weekOf, period: r.period, ownerId: r.ownerId, suggestedCategory: sug.category, suggestedReason: reasonText, weightedCents, grossCents });
    }
    // Last week's effective call (confirmation that week → confirmation before it → its suggestion).
    let prev: Parameters<typeof weekOverWeek>[0] = null;
    if (lastWeek) {
      const lastWeekLastConf = h.find((x) => x.weekOf < prevWeekKey && isCategory(x.category));
      const prevCat = isCategory(lastWeek.category) ? lastWeek.category : lastWeekLastConf?.category && isCategory(lastWeekLastConf.category) ? lastWeekLastConf.category : (lastWeek.suggested as ForecastCategory);
      if (isCategory(prevCat)) prev = { category: prevCat, weightedUsd: Number(lastWeek.weightedCents) / 100, period: lastWeek.period };
    }
    const change = weekOverWeek(prev, { category: eff.category, weightedUsd: weightedCents / 100, period: r.period, note: thisWeek?.note ?? null });
    deals.push({
      dealId: r.id,
      name: r.name,
      accountName: r.accountName,
      pipelineKey: r.pipelineKey,
      pipelineName: r.pipelineName,
      pipelineColor: r.pipelineColor,
      unit: r.unit,
      stageName: r.stageName,
      ownerId: r.ownerId,
      ownerName: r.ownerName,
      closeDate: r.expectedCloseDate!.toISOString(),
      period: r.period,
      weekOf: r.weekOf,
      probability: r.v.probability,
      overridden: r.v.overridden,
      muu: r.v.muu,
      grossUsd: r.v.grossUsd,
      weightedUsd: r.v.weightedGrossUsd,
      healthScore: r.healthScore,
      restricted: r.restricted,
      suggested: sug.category,
      reasons: sug.reasons,
      headline: sug.headline,
      engine: suggestOn ? "heuristic" : "stage",
      category: confirmed,
      note: thisWeek?.note ?? null,
      confirmedAt: thisWeek?.confirmedAt?.toISOString() ?? null,
      confirmedByName: thisWeek?.category && thisWeek.confirmedBy && thisWeek.confirmedBy !== r.ownerId ? (setByName.get(thisWeek.confirmedBy) ?? "a manager") : null,
      lastConfirmed: lastConf?.category ?? null,
      lastConfirmedWeek: lastConf?.weekOf ?? null,
      effective: eff.category,
      state: eff.state,
      needsConfirmation: needsConfirmation({ category: confirmed, lastConfirmed: lastConf?.category ?? null, suggested: sug.category }),
      canEdit: Boolean(r.canEdit),
      change,
    });
  }

  if (writes.length) {
    for (let i = 0; i < writes.length; i += 200) {
      await db
        .insert(s.forecastEntries)
        .values(writes.slice(i, i + 200))
        .onConflictDoUpdate({
          target: [s.forecastEntries.dealId, s.forecastEntries.weekOf],
          // Never touch the rep's decision (category / note / confirmedBy / confirmedAt).
          set: {
            period: sql`excluded.period`,
            ownerId: sql`excluded.owner_id`,
            suggestedCategory: sql`excluded.suggested_category`,
            suggestedReason: sql`excluded.suggested_reason`,
            weightedCents: sql`excluded.weighted_cents`,
            grossCents: sql`excluded.gross_cents`,
            updatedAt: sql`now()`,
          },
        });
    }
  }

  // ── Deals that were in last week's forecast but left it (won / lost / hold / date moved / owner changed).
  const removed: ForecastResult["removed"] = [];
  let hasLastWeek = deals.some((d) => d.change == null || d.change.kind !== "added");
  if (!opts.dealId && !opts.lite) {
    const lastWeekKeys = Array.from(new Set(inWindow.map((r) => previousWeek(r.weekOf)).concat(previousWeek(viewerWeek))));
    const exitConds: SQL[] = [access, inArray(s.forecastEntries.weekOf, lastWeekKeys)];
    // Owner scope applies to who owned it LAST WEEK (a reassigned deal leaves this rep's forecast with a reason).
    if (scope === "mine") exitConds.push(eq(s.forecastEntries.ownerId, user.id));
    else if (scope === "team") exitConds.push(inArray(s.forecastEntries.ownerId, user.teamMemberIds.length ? user.teamMemberIds : [user.id]));
    const prevRows = await db
      .select({
        dealId: s.forecastEntries.dealId,
        name: s.deals.name,
        status: s.deals.status,
        ownerId: s.deals.ownerId,
        prevOwnerId: s.forecastEntries.ownerId,
        pipelineKey: s.pipelines.key,
        category: s.forecastEntries.category,
        suggested: s.forecastEntries.suggestedCategory,
        weightedCents: s.forecastEntries.weightedCents,
        period: s.forecastEntries.period,
        closeDate: s.deals.expectedCloseDate,
      })
      .from(s.forecastEntries)
      .innerJoin(s.deals, eq(s.deals.id, s.forecastEntries.dealId))
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .where(and(...exitConds))
      .limit(MAX_DEALS);
    if (prevRows.length) hasLastWeek = true;
    const present = new Set(deals.map((d) => d.dealId));
    for (const p of prevRows) {
      if (present.has(p.dealId)) continue;
      const cat = isCategory(p.category) ? p.category : isCategory(p.suggested) ? p.suggested : null;
      if (!cat) continue;
      let exit = "Left the forecast window";
      if (p.status === "won") exit = "Closed won";
      else if (p.status === "lost") exit = "Closed lost";
      else if (p.status === "hold") exit = "Put on hold";
      else if (p.ownerId !== p.prevOwnerId && scope !== "company") exit = "Reassigned to another owner";
      else if (!p.closeDate) exit = "Close date removed";
      else {
        const q = quarterKey(p.closeDate);
        exit = quarterDiff(p.period, q) > 0 ? `Close date moved to ${quarterLabel(q)}` : "Close date passed without an update";
      }
      const change = weekOverWeek({ category: cat, weightedUsd: Number(p.weightedCents) / 100, period: p.period }, null, exit);
      if (change) removed.push({ dealId: p.dealId, name: p.name, ownerId: p.prevOwnerId, pipelineKey: p.pipelineKey, change });
    }
  }
  if (!hasLastWeek) for (const d of deals) d.change = null; // first recorded week: nothing to compare against

  const ownerMap = new Map<string, string>();
  for (const d of deals) if (d.ownerId) ownerMap.set(d.ownerId, d.ownerName ?? "Unknown");
  return {
    scope,
    weekOf: viewerWeek,
    window: forecastWindow(now, viewerTz),
    deals,
    removed,
    hasLastWeek,
    recon,
    owners: [...ownerMap].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    generatedAt: now.toISOString(),
    truncated,
  };
}

/** This week's forecast line for one deal (deal page badge). Read-only; null when the deal isn't in the window. */
export async function forecastForDeal(user: AppUser, dealId: string): Promise<ForecastDeal | null> {
  const r = await buildForecast(user, "company", { dealId, lite: true });
  return r.deals[0] ?? null;
}

/** Ids of this user's own entries this week that still need a confirmation (Today provider count). */
export function pendingConfirmations(f: ForecastResult): ForecastDeal[] {
  return f.deals.filter((d) => d.needsConfirmation && d.canEdit && d.ownerId != null);
}


/**
 * Today provider fast path (QA MAJ-05 / perf): how many of the user's OWN in-window deals still need a confirmation this
 * week, from this week's stored entries (written nightly by pregenerateForecasts and by /forecast) — ONE aggregate query
 * instead of a full forecast build on every /home load. Returns null when some in-window deal has no entry yet (first
 * load of a week before pre-generation): the caller then falls back to buildForecast.
 */
export async function pendingConfirmationCount(user: AppUser, now = new Date()): Promise<{ weekOf: string; pending: number; commit: number } | null> {
  const tz = safeTz(user.timezone);
  const weekOf = forecastWeekOf(now, tz);
  const win = forecastWindow(now, tz);
  const qStart = (q: string) => new Date(Date.UTC(Number(q.slice(0, 4)), (Number(q.slice(6)) - 1) * 3, 1));
  const from = qStart(win.current);
  const until = qStart(nextQuarterKey(win.next)); // exclusive
  const edit = await dealAccessWhere(user, "edit");
  const prev = sql`(select p.category from rso.forecast_entries p where p.deal_id = ${s.deals.id} and p.week_of < ${weekOf} and p.category is not null order by p.week_of desc limit 1)`;
  const needs = sql`${s.forecastEntries.dealId} is not null and ${s.forecastEntries.category} is null and (${prev} is null or ${prev} <> ${s.forecastEntries.suggestedCategory})`;
  const [r] = await db
    .select({
      inWindow: sql<number>`count(*)::int`,
      withEntry: sql<number>`count(${s.forecastEntries.dealId})::int`,
      pending: sql<number>`(count(*) filter (where ${needs}))::int`,
      commit: sql<number>`(count(*) filter (where ${needs} and ${s.forecastEntries.suggestedCategory} = 'commit'))::int`,
    })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .leftJoin(s.forecastEntries, and(eq(s.forecastEntries.dealId, s.deals.id), eq(s.forecastEntries.weekOf, weekOf)))
    .where(
      and(
        edit,
        eq(s.deals.ownerId, user.id),
        eq(s.pipelines.active, true),
        eq(s.stages.category, "open"),
        gte(s.deals.expectedCloseDate, from),
        lt(s.deals.expectedCloseDate, until),
      ),
    );
  if (!r) return { weekOf, pending: 0, commit: 0 };
  if (r.withEntry < r.inWindow) return null;
  return { weekOf, pending: r.pending, commit: r.commit };
}

function nextQuarterKey(q: string): string {
  const y = Number(q.slice(0, 4));
  const n = Number(q.slice(6));
  return n === 4 ? `${y + 1}-Q1` : `${y}-Q${n + 1}`;
}
