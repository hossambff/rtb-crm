import "server-only";
import { and, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { dealAccessWhere, type AppUser } from "@/lib/rbac/server";
import { safeTz } from "@/lib/time";
import { CATEGORY_LABELS, forecastWeekOf, isCategory, overrideNeedsReason, type ForecastCategory } from "./core";
import { buildForecast, pendingConfirmations } from "./service";

export type ConfirmItem = { dealId: string; category: ForecastCategory; note?: string };
export type ConfirmResult = { confirmed: number; overridden: number; skipped: { dealId: string; reason: string }[] };

/**
 * Record the rep's call for this week (confirm = accept the suggestion; override = another category, with a reason
 * when it moves a deal into or out of Commit). Requires edit access to each deal (dealAccessWhere "edit" — includes the
 * MNPI access list). The entry must exist (generated when the forecast was viewed). Audited per batch and per override.
 * Never changes the deal's probability (DEAL-4 overrides remain their own approval-gated path).
 */
export async function confirmForecastEntries(user: AppUser, items: ConfirmItem[], now = new Date()): Promise<ConfirmResult> {
  if (items.length > 500) throw new UserError("Confirm at most 500 deals at once.");
  const ids = Array.from(new Set(items.map((i) => i.dealId)));
  const editWhere = await dealAccessWhere(user, "edit");
  const owner = alias(s.user, "fc_owner");
  const deals = ids.length
    ? await db
        .select({ id: s.deals.id, name: s.deals.name, tz: owner.timezone })
        .from(s.deals)
        .leftJoin(owner, eq(owner.id, s.deals.ownerId))
        .where(and(inArray(s.deals.id, ids), editWhere))
    : [];
  const dealBy = new Map(deals.map((d) => [d.id, d]));
  const weekBy = new Map(deals.map((d) => [d.id, forecastWeekOf(now, safeTz(d.tz ?? user.timezone))]));
  const entries = deals.length
    ? await db
        .select({ id: s.forecastEntries.id, dealId: s.forecastEntries.dealId, weekOf: s.forecastEntries.weekOf, suggested: s.forecastEntries.suggestedCategory, category: s.forecastEntries.category })
        .from(s.forecastEntries)
        .where(and(inArray(s.forecastEntries.dealId, deals.map((d) => d.id)), inArray(s.forecastEntries.weekOf, Array.from(new Set(weekBy.values())))))
    : [];
  const entryBy = new Map(entries.filter((e) => weekBy.get(e.dealId) === e.weekOf).map((e) => [e.dealId, e]));
  // Previous decision per deal (the latest confirmation before this week).
  const minWeek = Array.from(weekBy.values()).sort()[0];
  const prior = deals.length && minWeek
    ? await db
        .selectDistinctOn([s.forecastEntries.dealId], { dealId: s.forecastEntries.dealId, category: s.forecastEntries.category, weekOf: s.forecastEntries.weekOf })
        .from(s.forecastEntries)
        .where(and(inArray(s.forecastEntries.dealId, deals.map((d) => d.id)), isNotNull(s.forecastEntries.category), lt(s.forecastEntries.weekOf, minWeek)))
        .orderBy(s.forecastEntries.dealId, desc(s.forecastEntries.weekOf))
    : [];
  const priorBy = new Map(prior.map((p) => [p.dealId, isCategory(p.category) ? p.category : null]));

  const skipped: ConfirmResult["skipped"] = [];
  const groups = new Map<string, { category: ForecastCategory; note: string | null; entryIds: string[] }>();
  const overrides: { dealId: string; name: string; from: string; to: ForecastCategory; note: string | null }[] = [];
  const confirmedLog: { dealId: string; category: ForecastCategory; suggested: string }[] = [];
  for (const it of items) {
    const d = dealBy.get(it.dealId);
    if (!d) {
      skipped.push({ dealId: it.dealId, reason: "You can't edit this deal." });
      continue;
    }
    const e = entryBy.get(it.dealId);
    if (!e) {
      skipped.push({ dealId: it.dealId, reason: "Not in this week's forecast — reload the page." });
      continue;
    }
    const suggested = isCategory(e.suggested) ? e.suggested : "pipeline";
    const previous = priorBy.get(it.dealId) ?? null;
    const note = it.note?.trim() || null;
    if (overrideNeedsReason({ chosen: it.category, suggested, previous }) && (!note || note.length < 5)) {
      throw new UserError(`${d.name}: add a short reason for ${it.category === "commit" ? "calling it Commit" : `moving it out of Commit to ${CATEGORY_LABELS[it.category]}`}.`);
    }
    const key = `${it.category}|${note ?? ""}`;
    (groups.get(key) ?? groups.set(key, { category: it.category, note, entryIds: [] }).get(key)!).entryIds.push(e.id);
    confirmedLog.push({ dealId: it.dealId, category: it.category, suggested });
    if (it.category !== suggested) overrides.push({ dealId: it.dealId, name: d.name, from: suggested, to: it.category, note });
  }

  for (const g of groups.values()) {
    for (let i = 0; i < g.entryIds.length; i += 200) {
      await db
        .update(s.forecastEntries)
        .set({ category: g.category, note: g.note, confirmedBy: user.id, confirmedAt: now })
        .where(inArray(s.forecastEntries.id, g.entryIds.slice(i, i + 200)));
    }
  }
  if (confirmedLog.length) {
    await audit({ actorId: user.id, action: "forecast.confirm", entity: "forecast", after: { count: confirmedLog.length, overrides: overrides.length, items: confirmedLog.slice(0, 500) } });
  }
  for (const o of overrides) {
    await audit({ actorId: user.id, action: "forecast.override", entity: "deal", entityId: o.dealId, before: { suggested: o.from }, after: { category: o.to, reason: o.note } });
  }
  return { confirmed: confirmedLog.length, overridden: overrides.length, skipped };
}

/** Accept every suggestion on the user's own deals that still needs a decision this week (Today "Confirm all"). */
export async function confirmAllSuggestions(user: AppUser): Promise<ConfirmResult> {
  const f = await buildForecast(user, "mine", { persist: true });
  const pending = pendingConfirmations(f);
  if (!pending.length) throw new UserError("Nothing left to confirm this week.");
  return confirmForecastEntries(
    user,
    pending.map((d) => ({ dealId: d.dealId, category: d.suggested })),
  );
}
