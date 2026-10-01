import "server-only";
import { after } from "next/server";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db, outsideTransaction, type Tx } from "@/db";
import * as s from "@/db/schema";
import { deliverToSlack } from "@/lib/slack/deliver";
import { readPrefs } from "@/lib/integrations/core";
import { dayBounds, toWall } from "@/lib/alerts/time";
import { BUDGETED_KINDS, decideDelivery, isBudgetedKind, type DeliveryDecision, type Severity } from "./budget-core";

/**
 * "alert" and "system" are machine-generated and budgeted (B3). Everything else is a direct ask from a person and always
 * interrupts: "handoff" (someone is handing you a deal / withdrew it), "help" (exec help requests and answers),
 * "assignment" (someone made you the owner of a deal / record), "task" (a task was assigned to you), "mention",
 * "approval". Use "system" only for automation output nobody is waiting on.
 */
export type NotificationKind = "alert" | "mention" | "approval" | "digest" | "system" | "task" | "handoff" | "help" | "assignment";

export type NotifyInput = {
  kind: NotificationKind;
  title: string;
  body?: string | null;
  href?: string | null;
  /** Alerts: the (highest) severity. Critical always interrupts; others count against the user's alert budget (B3). */
  severity?: Severity | null;
  /**
   * MNPI hard guard: the notification concerns a restricted deal/account. Sensitive rows stay in-app (bell + digest for
   * the recipient) and are never relayed to Slack — not even as a neutral DM. Set it whenever the subject can be restricted
   * (see `mnpiSafe` in src/lib/deals/notice.ts, which sets it for you). Persisted on the row (notifications.sensitive):
   * the daily digest never names sensitive rows, and no channel other than in-app ever receives them.
   */
  sensitive?: boolean;
};

/**
 * THE in-app notification helper (PRD M20 NOT-1); the topbar bell counts unread interrupting rows.
 *
 * Alert budget (V2 §B3): budgeted kinds (alert, system) beyond the user's `alertBudgetPerDay` interrupting
 * notifications today (user's zone), below their "Alert me from" severity, are stored with `digestOnly = true` — no bell
 * count, no Slack — and bundled into the next daily digest. Interrupting rows are DM'd via `deliverToSlack` after the
 * response (fire-and-forget; quiet hours suppress Slack except for critical), and `deliveredVia` records the channels.
 *
 * Never throws: a failed notification must not break the business action that triggered it. This matters most after a
 * commit — an exception there shows "Something went wrong" for work that already succeeded, and a retry duplicates it.
 *
 * Inside a transaction pass `{ tx }`: reads and the insert then run on the same connection (the insert in a SAVEPOINT),
 * so it commits with the work, needs no second pooled connection, and a failure rolls back only the savepoint.
 */
export async function notify(userId: string | null | undefined, n: NotifyInput, opts: { tx?: Tx } = {}): Promise<void> {
  if (!userId) return;
  await notifyMany([userId], n, opts);
}

type Q = Tx | typeof db;

/** Per-recipient delivery decisions (one query per table, bounded). Falls back to "interrupt, in-app" on any error. */
async function planDelivery(q: Q, ids: string[], n: NotifyInput, now: Date): Promise<Map<string, DeliveryDecision>> {
  const plan = new Map<string, DeliveryDecision>();
  if (n.severity === "critical") {
    for (const id of ids) plan.set(id, { digestOnly: false, slack: true, reason: "critical" });
    return plan;
  }
  const budgeted = isBudgetedKind(n.kind);
  const [users, prefs, legacy, recent] = await Promise.all([
    q.select({ id: s.user.id, tz: s.user.timezone }).from(s.user).where(inArray(s.user.id, ids)),
    q.select({ userId: s.userPrefs.userId, budget: s.userPrefs.alertBudgetPerDay }).from(s.userPrefs).where(inArray(s.userPrefs.userId, ids)),
    q
      .select({ userId: s.integrationConnections.userId, config: s.integrationConnections.config })
      .from(s.integrationConnections)
      .where(and(eq(s.integrationConnections.provider, "prefs"), inArray(s.integrationConnections.userId, ids))),
    budgeted
      ? q
          .select({ userId: s.notifications.userId, createdAt: s.notifications.createdAt })
          .from(s.notifications)
          .where(
            and(
              inArray(s.notifications.userId, ids),
              eq(s.notifications.digestOnly, false),
              inArray(s.notifications.kind, [...BUDGETED_KINDS]),
              sql`coalesce(${s.notifications.severity}, '') <> 'critical'`,
              gte(s.notifications.createdAt, new Date(now.getTime() - 26 * 3_600_000)),
            ),
          )
      : Promise.resolve([] as { userId: string; createdAt: Date }[]),
  ]);
  const tzOf = new Map(users.map((u) => [u.id, u.tz ?? "America/New_York"]));
  const budgetOf = new Map(prefs.map((p) => [p.userId, p.budget]));
  const notifOf = new Map(legacy.map((l) => [l.userId, readPrefs(l.config).notifications]));
  for (const id of ids) {
    const tz = tzOf.get(id) ?? "America/New_York";
    const { start } = dayBounds(now, tz);
    const np = notifOf.get(id);
    plan.set(
      id,
      decideDelivery({
        kind: n.kind,
        severity: n.severity ?? null,
        sentToday: budgeted ? recent.filter((r) => r.userId === id && r.createdAt >= start).length : 0,
        budget: budgetOf.get(id) ?? 3,
        minSeverity: np?.minSeverity ?? null,
        localHour: toWall(now, tz).getUTCHours(),
        quietStart: np?.quietHoursStart ?? null,
        quietEnd: np?.quietHoursEnd ?? null,
      }),
    );
  }
  return plan;
}

export async function notifyMany(userIds: (string | null | undefined)[], n: NotifyInput, opts: { tx?: Tx } = {}): Promise<void> {
  const ids = Array.from(new Set(userIds.filter((x): x is string => Boolean(x))));
  if (!ids.length) return;
  const q: Q = opts.tx ?? db;
  const now = new Date();
  let plan: Map<string, DeliveryDecision>;
  try {
    plan = await planDelivery(q, ids, n, now);
  } catch (e) {
    console.error("[notify] budget check failed — delivering normally", (e as Error).message?.split("\nparams:")[0]?.slice(0, 200));
    plan = new Map(ids.map((id) => [id, { digestOnly: false, slack: true, reason: "within_budget" } as DeliveryDecision]));
  }
  const rows = ids.map((userId) => {
    const d = plan.get(userId)!;
    return {
      userId,
      kind: n.kind,
      title: n.title.slice(0, 300),
      body: n.body?.slice(0, 2000) ?? null,
      href: n.href ?? null,
      severity: n.severity ?? null,
      digestOnly: d.digestOnly,
      sensitive: Boolean(n.sensitive),
      deliveredVia: d.digestOnly ? [] : ["in_app"],
    };
  });
  let inserted: { id: string; userId: string }[] = [];
  try {
    if (opts.tx)
      await opts.tx.transaction(async (sp) => {
        inserted = await sp.insert(s.notifications).values(rows).returning({ id: s.notifications.id, userId: s.notifications.userId });
      });
    else inserted = await db.insert(s.notifications).values(rows).returning({ id: s.notifications.id, userId: s.notifications.userId });
  } catch (e) {
    console.error("[notify] failed", (e as Error).message?.split("\nparams:")[0]?.slice(0, 200));
    return;
  }
  if (n.sensitive) return; // MNPI: never to Slack
  const targets = inserted.filter((r) => plan.get(r.userId)?.slack && !plan.get(r.userId)?.digestOnly);
  if (targets.length) scheduleSlack(targets, n);
}

/** DM interrupting rows on Slack after the response (and after any surrounding transaction committed). Never throws. */
function scheduleSlack(targets: { id: string; userId: string }[], n: NotifyInput) {
  const send = async () => {
    try {
      const res: unknown = await deliverToSlack(
        targets.map((t) => t.userId),
        { kind: n.kind, title: n.title, body: n.sensitive ? null : (n.body ?? null), href: n.href ?? null, severity: n.severity ?? null, sensitive: n.sensitive ?? false },
      );
      const delivered = new Set(((res as { delivered?: string[] } | undefined)?.delivered ?? []).filter((x) => typeof x === "string"));
      const ids = targets.filter((t) => delivered.has(t.userId)).map((t) => t.id);
      if (ids.length)
        await db
          .update(s.notifications)
          .set({ deliveredVia: sql`array_append(${s.notifications.deliveredVia}, 'slack')` })
          .where(inArray(s.notifications.id, ids));
    } catch (e) {
      console.error("[notify] slack delivery failed", (e as Error).message?.slice(0, 160));
    }
  };
  // CR L1: notify() is often called with a tx — the Slack step must not inherit the "in transaction" context.
  try {
    after(() => outsideTransaction(send));
  } catch {
    // outside a request scope (scripts): best effort
    void outsideTransaction(send);
  }
}
