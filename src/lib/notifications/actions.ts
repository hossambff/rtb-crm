"use server";
import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { action } from "@/lib/actions";

export const markNotificationRead = action(z.object({ id: z.string().uuid(), read: z.boolean().default(true) }), async ({ id, read }, user) => {
  await db
    .update(notifications)
    .set({ readAt: read ? new Date() : null })
    .where(and(eq(notifications.id, id), eq(notifications.userId, user.id)));
  revalidatePath("/tasks");
  return { id };
});

export const markAllNotificationsRead = action(z.object({}), async (_i, user) => {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  revalidatePath("/tasks");
  return { count: rows.length };
});
