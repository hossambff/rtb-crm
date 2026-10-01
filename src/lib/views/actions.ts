"use server";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { listSavedViews } from "./queries";
import { MAX_VIEWS_PER_PAGE, PAGE_KEY, sanitizeParams } from "./core";

const Page = z.string().regex(PAGE_KEY, "Unknown page");
const Params = z.record(z.string().max(40), z.string().max(400)).transform((p) => sanitizeParams(p));

/** Saved views are personal UI state (not business data): scoped to the signed-in user, not audited. */
export const listViews = action(z.object({ page: Page }), async ({ page }, user) => listSavedViews(user.id, page));

/** Remember the filters last used on a page (one `isLast` row per user+page; an empty set means "show everything"). */
export const rememberView = action(z.object({ page: Page, params: Params }), async ({ page, params }, user) => {
  const updated = await db
    .update(s.savedViews)
    .set({ params })
    .where(and(eq(s.savedViews.userId, user.id), eq(s.savedViews.page, page), eq(s.savedViews.isLast, true)))
    .returning({ id: s.savedViews.id });
  if (!updated.length)
    await db
      .insert(s.savedViews)
      .values({ userId: user.id, page, name: "Last used", params, isLast: true })
      .onConflictDoNothing();
  return { ok: true };
});

export const saveView = action(
  z.object({ page: Page, name: z.string().trim().min(1, "Give it a name").max(60), params: Params, isDefault: z.boolean().default(false) }),
  async ({ page, name, params, isDefault }, user) => {
    const mine = and(eq(s.savedViews.userId, user.id), eq(s.savedViews.page, page), eq(s.savedViews.isLast, false));
    const [{ n }] = await db.select({ n: count() }).from(s.savedViews).where(mine);
    const [existing] = await db.select({ id: s.savedViews.id }).from(s.savedViews).where(and(mine, eq(s.savedViews.name, name)));
    if (!existing && n >= MAX_VIEWS_PER_PAGE) throw new UserError(`You can keep up to ${MAX_VIEWS_PER_PAGE} views per page.`);
    if (isDefault) await db.update(s.savedViews).set({ isDefault: false }).where(mine);
    let id: string;
    if (existing) {
      await db.update(s.savedViews).set({ params, ...(isDefault ? { isDefault } : {}) }).where(eq(s.savedViews.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await db.insert(s.savedViews).values({ userId: user.id, page, name, params, isDefault }).returning({ id: s.savedViews.id });
      id = row!.id;
    }
    return { id, views: await listSavedViews(user.id, page) };
  },
);

export const setDefaultView = action(z.object({ page: Page, id: z.string().uuid().nullable() }), async ({ page, id }, user) => {
  const mine = and(eq(s.savedViews.userId, user.id), eq(s.savedViews.page, page), eq(s.savedViews.isLast, false));
  await db.update(s.savedViews).set({ isDefault: false }).where(mine);
  if (id) {
    const r = await db.update(s.savedViews).set({ isDefault: true }).where(and(mine, eq(s.savedViews.id, id))).returning({ id: s.savedViews.id });
    if (!r.length) throw new UserError("View not found.");
  }
  return { views: await listSavedViews(user.id, page) };
});

export const deleteView = action(z.object({ page: Page, id: z.string().uuid() }), async ({ page, id }, user) => {
  await db
    .delete(s.savedViews)
    .where(and(eq(s.savedViews.userId, user.id), eq(s.savedViews.page, page), eq(s.savedViews.id, id), eq(s.savedViews.isLast, false)));
  return { views: await listSavedViews(user.id, page) };
});
