import "server-only";
import { and, eq, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { logServerError } from "@/lib/errors";
import { notify } from "@/lib/notifications/notify";
import { isSensitive } from "@/lib/notifications/sensitive";
import { handoffEscalatedKey, handoffEscalationNotice, shouldEscalate } from "./core";

/**
 * Tick job (QA MIN-17): a handoff pending ≥ 2 business days (receiver's zone) notifies the receiver's manager ONCE.
 * The once-only stamp is an app_settings row `handoff.escalated:<id>` claimed atomically before notifying (overlapping
 * ticks can't double-notify). Audited; MNPI-safe (restricted → neutral text, sensitive flag). Bounded; never throws.
 */
export async function escalateStaleHandoffs(opts: { now?: Date; deadlineMs?: number; limit?: number } = {}): Promise<{ escalated: number }> {
  const now = opts.now ?? new Date();
  const deadline = opts.deadlineMs ?? Date.now() + 60_000;
  let escalated = 0;
  try {
    const to = alias(s.user, "to_user");
    const from = alias(s.user, "from_user");
    // ≥ 2 business days implies ≥ 2 calendar days: cheap SQL pre-filter, exact check below in the receiver's zone.
    const rows = await db
      .select({
        id: s.handoffs.id,
        dealId: s.handoffs.dealId,
        kind: s.handoffs.kind,
        createdAt: s.handoffs.createdAt,
        toUserId: s.handoffs.toUserId,
        toName: to.name,
        toTz: to.timezone,
        managerId: to.managerId,
        fromName: from.name,
        dealName: s.deals.name,
      })
      .from(s.handoffs)
      .innerJoin(s.deals, eq(s.deals.id, s.handoffs.dealId))
      .innerJoin(to, eq(to.id, s.handoffs.toUserId))
      .leftJoin(from, eq(from.id, s.handoffs.fromUserId))
      .where(
        and(
          eq(s.handoffs.status, "pending"),
          lt(s.handoffs.createdAt, new Date(now.getTime() - 2 * 86_400_000)),
          sql`${to.managerId} is not null`,
          sql`${s.deals.deletedAt} is null`,
          sql`not exists (select 1 from ${s.appSettings} k where k.key = 'handoff.escalated:' || ${s.handoffs.id}::text)`,
        ),
      )
      .orderBy(s.handoffs.createdAt)
      .limit(opts.limit ?? 50);
    for (const h of rows) {
      if (Date.now() > deadline) break;
      if (!h.managerId || h.managerId === h.toUserId || !shouldEscalate(h.createdAt, now, h.toTz ?? "UTC")) continue;
      try {
        const claimed = await db
          .insert(s.appSettings)
          .values({ key: handoffEscalatedKey(h.id), value: { at: now.toISOString(), managerId: h.managerId } as never, updatedBy: null })
          .onConflictDoNothing()
          .returning({ key: s.appSettings.key });
        if (!claimed.length) continue;
        const restricted = await isSensitive({ dealId: h.dealId });
        const n = handoffEscalationNotice(h, restricted);
        await notify(h.managerId, { kind: "handoff", title: n.title, body: n.body, href: `/deals/${h.dealId}`, sensitive: n.sensitive });
        await audit({
          actorId: null,
          actorKind: "system",
          action: "handoff.escalated",
          entity: "handoff",
          entityId: h.id,
          after: { dealId: h.dealId, toUserId: h.toUserId, managerId: h.managerId, pendingSince: h.createdAt, escalatedAt: now },
        });
        escalated++;
      } catch (e) {
        logServerError("handoffs.escalate_one", e);
      }
    }
  } catch (e) {
    logServerError("handoffs.escalate", e);
  }
  return { escalated };
}
