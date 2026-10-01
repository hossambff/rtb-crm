import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { loadAppUserById } from "@/lib/rbac/server";
import { buildForecast } from "./service";

/**
 * Nightly pre-generation of this week's forecast entries (V2 §A9 "by the snapshot cron path"): for every user who owns
 * an open deal, build their "mine" forecast with `persist` (idempotent via the deal+week unique index; confirmations are
 * never overwritten). Runs as the owner (session-equivalent AppUser — banned / pending / expired owners are skipped), so
 * the entries are exactly what that rep would get on first view. Bounded by `limit` and `deadlineMs`; never throws.
 */
export async function pregenerateForecasts(opts: { limit?: number; deadlineMs?: number; now?: Date } = {}): Promise<{ users: number; failed: number }> {
  const deadline = opts.deadlineMs ?? Date.now() + 45_000;
  let users = 0;
  let failed = 0;
  try {
    const owners = await db
      .selectDistinct({ id: s.deals.ownerId })
      .from(s.deals)
      .where(and(eq(s.deals.status, "open"), isNull(s.deals.deletedAt)))
      .limit(opts.limit ?? 200);
    for (const o of owners) {
      if (!o.id) continue;
      if (Date.now() > deadline) break;
      try {
        const user = await loadAppUserById(o.id);
        if (!user) continue;
        await buildForecast(user, "mine", { persist: true, lite: true, now: opts.now });
        users++;
      } catch (e) {
        failed++;
        console.error("[forecast] pregenerate failed for a user", (e as Error).message?.split("\nparams:")[0]?.slice(0, 160));
      }
    }
  } catch (e) {
    console.error("[forecast] pregenerate failed", (e as Error).message?.split("\nparams:")[0]?.slice(0, 160));
  }
  return { users, failed };
}
