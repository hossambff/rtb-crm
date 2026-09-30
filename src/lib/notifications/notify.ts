import "server-only";
import { db } from "@/db";
import { notifications } from "@/db/schema";

export type NotificationKind = "alert" | "mention" | "approval" | "digest" | "system" | "task";

export type NotifyInput = { kind: NotificationKind; title: string; body?: string | null; href?: string | null };

/**
 * In-app notification (PRD M20 NOT-1). The topbar bell counts unread rows. Email/Slack delivery hooks in here later.
 * Never throws — a failed notification must not break the business action that triggered it.
 */
export async function notify(userId: string | null | undefined, n: NotifyInput): Promise<void> {
  if (!userId) return;
  await notifyMany([userId], n);
}

export async function notifyMany(userIds: (string | null | undefined)[], n: NotifyInput): Promise<void> {
  const ids = Array.from(new Set(userIds.filter((x): x is string => Boolean(x))));
  if (!ids.length) return;
  try {
    await db.insert(notifications).values(
      ids.map((userId) => ({
        userId,
        kind: n.kind,
        title: n.title.slice(0, 300),
        body: n.body?.slice(0, 2000) ?? null,
        href: n.href ?? null,
      })),
    );
  } catch (e) {
    console.error("[notify] failed", (e as Error).message);
  }
}
