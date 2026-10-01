import "server-only";
import { revalidatePath } from "next/cache";
import { and, eq, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { logServerError } from "@/lib/errors";
import type { AppUser } from "@/lib/rbac/server";
import { filterRecipientsForDeal } from "@/lib/deals/service";
import { HANDOFF_KIND_LABEL, shouldEscalate, type HandoffKind } from "@/lib/handoffs/core";
import { respondHandoff } from "@/lib/handoffs/service";
import type { QueueItem, QueueServerHandler } from "../types";

/**
 * Today queue — structured handoffs (V2 §C3):
 *  - receiver: every pending handoff to me ("Review" + one-click "Accept"; declining needs a note → on the deal page);
 *  - manager: handoffs to my direct reports pending ≥ 2 business days (receiver's zone) → nudge/reassign.
 * Restricted deals are only named to people on the access list. Never throws.
 */
export async function load(user: AppUser): Promise<QueueItem[]> {
  try {
    const from = alias(s.user, "from_user");
    const to = alias(s.user, "to_user");
    // A fresh builder per query: drizzle builders are mutable, so a shared one would leak .where() between the two.
    const base = () =>
      db
      .select({
        id: s.handoffs.id,
        dealId: s.handoffs.dealId,
        kind: s.handoffs.kind,
        createdAt: s.handoffs.createdAt,
        context: s.handoffs.brief,
        toUserId: s.handoffs.toUserId,
        toName: to.name,
        toTz: to.timezone,
        toManager: to.managerId,
        fromName: from.name,
        dealName: s.deals.name,
        restricted: s.deals.restricted,
        accountName: s.accounts.name,
      })
      .from(s.handoffs)
      .innerJoin(s.deals, eq(s.deals.id, s.handoffs.dealId))
      .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
      .innerJoin(to, eq(to.id, s.handoffs.toUserId))
      .leftJoin(from, eq(from.id, s.handoffs.fromUserId));
    // Perf: ONE query for both "handed to me" and "handed to my direct reports" (was 2–3 round trips).
    const rows = await base()
      .where(and(eq(s.handoffs.status, "pending"), or(eq(s.handoffs.toUserId, user.id), eq(to.managerId, user.id))))
      .limit(80);
    const mine = rows.filter((h) => h.toUserId === user.id).slice(0, 30);
    const reports = rows.filter((h) => h.toUserId !== user.id);
    const now = new Date();
    const items: QueueItem[] = [];
    for (const h of mine) {
      const overdue = shouldEscalate(h.createdAt, now, h.toTz ?? user.timezone);
      items.push({
        key: `handoff:${h.id}`,
        kind: "handoff",
        title: `${h.fromName ?? "Someone"} is handing you ${h.dealName}`,
        detail: `${HANDOFF_KIND_LABEL[h.kind as HandoffKind] ?? "Handoff"} · ${h.context.context.slice(0, 140)}`,
        context: h.accountName ?? h.dealName,
        href: `/deals/${h.dealId}?handoff=${h.id}`,
        dueAt: h.createdAt.toISOString(),
        urgency: overdue ? 80 : 65,
        severity: overdue ? "warning" : null,
        actions: [
          { kind: "link", label: "Review", href: `/deals/${h.dealId}?handoff=${h.id}` },
          { kind: "server", label: "Accept", actionId: "handoffs.accept", payload: { handoffId: h.id }, primary: true },
          { kind: "snooze" },
        ],
      });
    }
    const stale = reports.filter((h) => h.toManager === user.id && shouldEscalate(h.createdAt, now, h.toTz ?? user.timezone));
    for (const h of stale) {
      const allowed = (await filterRecipientsForDeal({ id: h.dealId, restricted: h.restricted }, [user.id])).includes(user.id);
      if (!allowed) continue; // MNPI: no deal name, no item for people off the access list
      items.push({
        key: `handoff:${h.id}:escalated`,
        kind: "handoff",
        title: `${h.toName} hasn't picked up ${h.dealName}`,
        detail: `Handoff from ${h.fromName ?? "a teammate"} waiting since ${h.createdAt.toISOString().slice(0, 10)} — nudge or reassign.`,
        context: h.accountName ?? h.dealName,
        href: `/deals/${h.dealId}`,
        dueAt: h.createdAt.toISOString(),
        urgency: 60,
        severity: "warning",
        actions: [{ kind: "link", label: "Open deal", href: `/deals/${h.dealId}` }, { kind: "done" }, { kind: "snooze" }],
      });
    }
    return items;
  } catch (e) {
    logServerError("queue.handoffs", e);
    return [];
  }
}

/** Server handlers referenced as "handoffs.<name>" (dispatched by src/lib/queue/actions.ts). */
export const actions: Record<string, QueueServerHandler> = {
  accept: async (user, payload) => {
    const res = await respondHandoff(user, { handoffId: String(payload.handoffId ?? ""), accept: true });
    revalidatePath(`/deals/${res.dealId}`);
    return { message: res.accepted ? "Handoff accepted — the deal is yours" : undefined };
  },
};
