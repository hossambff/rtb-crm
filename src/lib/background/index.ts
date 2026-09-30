import "server-only";
import { after } from "next/server";
import { and, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";

/**
 * In-app fallback for crons that Vercel Hobby can only run daily (docs/DEPLOY.md §7): when a user opens My Day we
 * kick off, after the response is sent (next/server `after`, non-blocking), the Nothing Slips sweep if the last one
 * is > 60 min old and that user's own Gmail / Calendar / Granola sync if it is > 15 min old.
 *
 * Concurrency: each job is claimed with a conditional upsert on rso.app_settings (only one request across all
 * instances wins the claim for a window) plus an in-process guard. Failures are logged without message content.
 */

export const LAST_SWEEP_KEY = "alerts.last_sweep_at";
const SWEEP_EVERY_MIN = 60;
const USER_SYNC_EVERY_MIN = 15;
const running = new Set<string>();

/** Atomically claim `key` if its timestamp is missing or older than `minutes`. Returns true for the winner. */
async function claim(key: string, minutes: number): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await db.execute(sql`
    insert into rso.app_settings (key, value, updated_by)
    values (${key}, to_jsonb(${now}::text), null)
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where (rso.app_settings.value #>> '{}')::timestamptz < now() - make_interval(mins => ${minutes})
    returning key`);
  return rows.length > 0;
}

/** Record a completed sweep (cron, admin "Run sweep now", in-app fallback). */
export async function recordSweep(at = new Date()) {
  await db
    .insert(s.appSettings)
    .values({ key: LAST_SWEEP_KEY, value: at.toISOString() as never, updatedBy: null })
    .onConflictDoUpdate({ target: s.appSettings.key, set: { value: at.toISOString() as never } });
}

async function runGuarded(tag: string, fn: () => Promise<unknown>) {
  if (running.has(tag)) return;
  running.add(tag);
  try {
    await fn();
  } catch (e) {
    console.error(`[background] ${tag.split(":")[0]} failed`, e instanceof Error ? e.message.slice(0, 200) : "error");
  } finally {
    running.delete(tag);
  }
}

/** Anything to sync for this user (Google mail/calendar grant or a Granola key) and nothing synced in the window? */
async function userSyncDue(userId: string): Promise<boolean> {
  const [recent] = await db
    .select({ id: s.integrationConnections.id })
    .from(s.integrationConnections)
    .where(
      and(
        eq(s.integrationConnections.userId, userId),
        inArray(s.integrationConnections.provider, ["gmail", "granola"]),
        gt(s.integrationConnections.lastSyncAt, new Date(Date.now() - USER_SYNC_EVERY_MIN * 60_000)),
      ),
    )
    .limit(1);
  if (recent) return false;
  const [g] = await db
    .select({ id: s.account.id })
    .from(s.account)
    .where(and(eq(s.account.userId, userId), eq(s.account.providerId, "google"), or(ilike(s.account.scope, "%gmail.readonly%"), ilike(s.account.scope, "%calendar.readonly%"))))
    .limit(1);
  if (g) return true;
  const [gr] = await db
    .select({ id: s.integrationConnections.id })
    .from(s.integrationConnections)
    .where(and(eq(s.integrationConnections.userId, userId), eq(s.integrationConnections.provider, "granola"), inArray(s.integrationConnections.status, ["connected", "error"])))
    .limit(1);
  return Boolean(gr);
}

/** Schedule the stale-sweep / stale-sync catch-up for `userId` after the current response. Never throws. */
export function scheduleHomeCatchUp(userId: string) {
  after(async () => {
    if (!running.has("sweep") && (await claim(LAST_SWEEP_KEY, SWEEP_EVERY_MIN).catch(() => false))) {
      await runGuarded("sweep", async () => {
        const { runSweep } = await import("@/lib/alerts/engine");
        await runSweep();
        await recordSweep();
      });
    }
    const tag = `sync:${userId}`;
    if (!running.has(tag) && (await userSyncDue(userId).catch(() => false)) && (await claim(`integrations.home_sync_at.${userId}`, USER_SYNC_EVERY_MIN).catch(() => false))) {
      await runGuarded(tag, async () => {
        const { runUserSync } = await import("@/lib/integrations/sync-runner");
        await runUserSync(userId, { respectBackoff: true, analyzeLimit: 10 });
      });
    }
  });
}
