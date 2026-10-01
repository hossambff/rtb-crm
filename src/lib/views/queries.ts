import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import type { AppUser } from "@/lib/rbac/server";
import { PAGE_KEY, pickEntryParams, sanitizeParams, smartOwnerParams, toQueryString } from "./core";

export type SavedView = { id: string; name: string; params: Record<string, string>; isDefault: boolean };

/** Named views of the user for a page (the auto-remembered "last" row is not listed). */
export async function listSavedViews(userId: string, page: string): Promise<SavedView[]> {
  if (!PAGE_KEY.test(page)) return [];
  const rows = await db
    .select()
    .from(s.savedViews)
    .where(and(eq(s.savedViews.userId, userId), eq(s.savedViews.page, page), eq(s.savedViews.isLast, false)))
    .orderBy(asc(s.savedViews.name));
  return rows.map((r) => ({ id: r.id, name: r.name, params: r.params, isDefault: r.isDefault }));
}

/**
 * Smart defaults for list pages (V2 §B8). Call at the top of a list page:
 *
 *   const qs = await resolveListView(user, "accounts", sp);
 *   if (qs) redirect(`/accounts${qs}`);
 *
 * Returns a query string to redirect to only when the page was opened WITHOUT params: the user's default view, else
 * their last-used filters, else "Mine" (`owner=me`) — or "My team" for leaders when the page supports `teamValue`.
 * Never throws (returns null on any error, so the page just renders unfiltered).
 */
export async function resolveListView(
  user: AppUser,
  page: string,
  searchParams: Record<string, string | string[] | undefined>,
  opts: { ownerParam?: string; teamValue?: string | null } = {},
): Promise<string | null> {
  try {
    if (!PAGE_KEY.test(page)) return null;
    if (Object.values(searchParams).some((v) => v !== undefined && v !== "")) return null;
    const rows = await db
      .select({ params: s.savedViews.params, isDefault: s.savedViews.isDefault, isLast: s.savedViews.isLast })
      .from(s.savedViews)
      .where(and(eq(s.savedViews.userId, user.id), eq(s.savedViews.page, page)));
    const params = pickEntryParams(
      rows.map((r) => ({ ...r, params: sanitizeParams(r.params) })),
      smartOwnerParams(user.role, opts.ownerParam ?? "owner", opts.teamValue ?? null, user.teamMemberIds.filter((id) => id !== user.id).length > 0),
    );
    return params ? toQueryString(params) || null : null;
  } catch (e) {
    console.error("[views] resolve failed", (e as Error).message?.slice(0, 120));
    return null;
  }
}
