import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { isAuthorizedCron } from "@/lib/alerts/cron";
import { resumeRun } from "@/lib/scout/dispatch";
import { startScoutRunFor } from "@/lib/scout/service";

export const maxDuration = 300;

const MAX_SEARCHES_PER_TICK = 5;

/**
 * Scheduled scouting (SCOUT-4): re-runs weekly searches whose last run is ≥ 7 days old. Only new candidates are
 * added (the pipeline dedupes against the search's existing candidates, rejections and the CRM filters).
 * Also resumes stalled runs (e.g. async Apify steps whose webhook never arrived). Budget caps apply to the owner.
 * Auth: Authorization: Bearer ${CRON_SECRET}.
 */
export async function GET(req: NextRequest) {
  // SEC L-1: constant-time secret comparison, fail closed when CRON_SECRET is unset (shared helper).
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const now = Date.now();
  const weekAgo = new Date(now - 7 * 86_400_000);
  const due = await db
    .select({ id: s.scoutSearches.id, name: s.scoutSearches.name, ownerId: s.scoutSearches.ownerId, role: s.user.role, banned: s.user.banned })
    .from(s.scoutSearches)
    .innerJoin(s.user, eq(s.user.id, s.scoutSearches.ownerId))
    .where(and(eq(s.scoutSearches.schedule, "weekly"), or(isNull(s.scoutSearches.lastRunAt), lt(s.scoutSearches.lastRunAt, weekAgo))))
    .limit(MAX_SEARCHES_PER_TICK);

  const results: { searchId: string; runId: string | null; blocked: boolean; message: string }[] = [];
  for (const d of due) {
    if (!d.ownerId || d.banned || d.role === "pending") continue;
    try {
      const r = await startScoutRunFor({ id: d.ownerId, role: d.role }, d.id);
      // stamp lastRunAt even when blocked so a blocked search doesn't retry every tick
      if (r.blocked) await db.update(s.scoutSearches).set({ lastRunAt: new Date() }).where(eq(s.scoutSearches.id, d.id));
      else if (r.runId) await resumeRun(r.runId);
      results.push({ searchId: d.id, runId: r.runId, blocked: r.blocked, message: r.message });
      await audit({ actorId: null, actorKind: "system", action: r.blocked ? "scout_run.blocked" : "scout_run.scheduled", entity: "scout_search", entityId: d.id, after: { runId: r.runId, message: r.message } });
    } catch (e) {
      results.push({ searchId: d.id, runId: null, blocked: true, message: e instanceof Error ? e.message.slice(0, 200) : "failed" });
    }
  }

  // resume stalled runs from the last 2 days (finished steps are skipped; waiting steps poll Apify)
  const stalled = await db
    .select({ id: s.enrichmentRuns.id })
    .from(s.enrichmentRuns)
    .where(and(inArray(s.enrichmentRuns.status, ["queued", "running"]), gte(s.enrichmentRuns.createdAt, new Date(now - 2 * 86_400_000)), lt(s.enrichmentRuns.createdAt, new Date(now - 5 * 60_000))))
    .limit(10);
  for (const r of stalled) await resumeRun(r.id);

  return NextResponse.json({ ok: true, scheduled: results, resumed: stalled.length });
}
