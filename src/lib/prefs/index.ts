import "server-only";
import { cache } from "react";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { userPrefs } from "@/db/schema";
import { dealModule, getMatrix, type AppUser } from "@/lib/rbac/server";
import { resolveMotions } from "./core";

/** V2 per-user preferences (docs/V2_SPEC.md §Shared contracts). Owner: WS-A. Read-only helpers usable by every module. */
export type UserPrefs = typeof userPrefs.$inferSelect;

export const DEFAULT_PREFS: Omit<UserPrefs, "userId" | "updatedAt"> = {
  navHidden: [],
  pipelineKeys: [],
  alertBudgetPerDay: 3,
  autopilot: { postCall: "review", meetingBriefs: true, emailSignals: true, forecastSuggest: true },
  slackUserId: null,
  slackDm: false,
  checklist: {},
};

/** Prefs for a user, merged over defaults (a missing row = defaults). Cached per request. */
export const getPrefs = cache(async (userId: string): Promise<UserPrefs> => {
  const [row] = await db.select().from(userPrefs).where(eq(userPrefs.userId, userId));
  const base = { userId, updatedAt: new Date(0), ...DEFAULT_PREFS };
  if (!row) return base;
  return { ...base, ...row, autopilot: { ...DEFAULT_PREFS.autopilot, ...row.autopilot } };
});

/** Upsert a partial prefs patch (callers must authorize: a user edits only their own prefs; admins may set defaults). */
export async function patchPrefs(userId: string, patch: Partial<Omit<UserPrefs, "userId" | "updatedAt">>) {
  await db
    .insert(userPrefs)
    .values({ userId, ...patch })
    .onConflictDoUpdate({ target: userPrefs.userId, set: { ...patch } });
}

export type MotionOption = { key: string; name: string; color: string; unit: "muu" | "usd" | "activation" };

/** Active pipelines the user's role may view, in admin sort order. Cached per request. */
export const permittedMotions = cache(async (user: AppUser): Promise<MotionOption[]> => {
  const [matrix, pipes] = await Promise.all([
    getMatrix(user.role),
    db
      .select({ key: s.pipelines.key, name: s.pipelines.name, color: s.pipelines.color, unit: s.pipelines.unit })
      .from(s.pipelines)
      .where(eq(s.pipelines.active, true))
      .orderBy(asc(s.pipelines.sortOrder), asc(s.pipelines.name)),
  ]);
  return pipes.filter((p) => (matrix[dealModule(p.key)]?.view ?? "none") !== "none");
});

/**
 * "Motions I sell" (V2 §B2) — the pipeline keys pickers and the Pipelines overview should lead with:
 * explicit prefs (∩ permitted) → motions where the user owns open deals → all permitted. Cached per request.
 */
export const getMyMotions = cache(async (user: AppUser): Promise<{ keys: string[]; permitted: MotionOption[]; source: "prefs" | "owned" | "all" }> => {
  const [prefs, permitted] = await Promise.all([getPrefs(user.id), permittedMotions(user)]);
  let owned: string[] = [];
  if (!prefs.pipelineKeys.length) {
    const rows = await db
      .selectDistinct({ key: s.pipelines.key })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .where(and(eq(s.deals.ownerId, user.id), eq(s.deals.status, "open"), isNull(s.deals.deletedAt)));
    owned = rows.map((r) => r.key);
  }
  const r = resolveMotions(prefs.pipelineKeys, permitted.map((p) => p.key), owned);
  return { ...r, permitted };
});
