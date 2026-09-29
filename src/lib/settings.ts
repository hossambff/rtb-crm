import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";

export const getSetting = cache(async <T,>(key: string, fallback: T): Promise<T> => {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return (row?.value as T) ?? fallback;
});

export async function setSetting(key: string, value: unknown, userId: string) {
  await db
    .insert(appSettings)
    .values({ key, value: value as never, updatedBy: userId })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: value as never, updatedBy: userId } });
}
