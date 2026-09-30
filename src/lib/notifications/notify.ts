import "server-only";
import { db, type Tx } from "@/db";
import { notifications } from "@/db/schema";

export type NotificationKind = "alert" | "mention" | "approval" | "digest" | "system" | "task";

export type NotifyInput = { kind: NotificationKind; title: string; body?: string | null; href?: string | null };

/**
 * THE in-app notification helper (PRD M20 NOT-1); the topbar bell counts unread rows. Email/Slack delivery hooks in here later.
 *
 * Never throws: a failed notification must not break the business action that triggered it. This matters most after a
 * commit — an exception there shows "Something went wrong" for work that already succeeded, and a retry duplicates it
 * (e.g. a second deal).
 *
 * Inside a transaction pass `{ tx }`: the insert then runs in a SAVEPOINT on the same connection, so it commits with the
 * work, needs no second pooled connection, and a failure rolls back only the savepoint (the outer transaction stays usable).
 */
export async function notify(userId: string | null | undefined, n: NotifyInput, opts: { tx?: Tx } = {}): Promise<void> {
  if (!userId) return;
  await notifyMany([userId], n, opts);
}

export async function notifyMany(userIds: (string | null | undefined)[], n: NotifyInput, opts: { tx?: Tx } = {}): Promise<void> {
  const ids = Array.from(new Set(userIds.filter((x): x is string => Boolean(x))));
  if (!ids.length) return;
  const rows = ids.map((userId) => ({
    userId,
    kind: n.kind,
    title: n.title.slice(0, 300),
    body: n.body?.slice(0, 2000) ?? null,
    href: n.href ?? null,
  }));
  try {
    if (opts.tx) await opts.tx.transaction(async (sp) => void (await sp.insert(notifications).values(rows)));
    else await db.insert(notifications).values(rows);
  } catch (e) {
    console.error("[notify] failed", (e as Error).message?.split("\nparams:")[0]?.slice(0, 200));
  }
}
