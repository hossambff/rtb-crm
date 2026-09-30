import "server-only";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import type { AppUser } from "@/lib/rbac/server";

export type NotificationView = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  read: boolean;
  createdAt: string;
};

export async function listNotifications(user: AppUser, limit = 100): Promise<NotificationView[]> {
  const rows = await db.select().from(notifications).where(eq(notifications.userId, user.id)).orderBy(desc(notifications.createdAt)).limit(limit);
  return rows.map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    href: n.href,
    read: Boolean(n.readAt),
    createdAt: n.createdAt.toISOString(),
  }));
}

export async function unreadCount(user: AppUser): Promise<number> {
  const [r] = await db.select({ n: count() }).from(notifications).where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)));
  return r?.n ?? 0;
}
