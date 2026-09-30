import "server-only";
import { and, asc, ne, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";

/**
 * Shared owner lists (QA-20). Two different questions:
 *  - who can be given a record (pickers)            → active people only
 *  - who can a list be filtered by (owner filters)  → active people + deactivated/placeholder users who still own
 *    records (so imported "Erik (placeholder)" deals stay filterable), never empty junk placeholders ("News", "Politics").
 */
export type OwnerOption = { id: string; name: string; email: string };

/** Not pending, not deactivated (banned) and access not expired. */
export const activeUserWhere: SQL = and(
  ne(s.user.role, "pending"),
  sql`coalesce(${s.user.banned}, false) = false`,
  sql`(${s.user.accessExpiresAt} is null or ${s.user.accessExpiresAt} > now())`,
)!;

const ownsRecords = sql`(
  exists (select 1 from rso.deals d where d.owner_id = ${s.user.id} and d.deleted_at is null)
  or exists (select 1 from rso.accounts a where a.owner_id = ${s.user.id} and a.deleted_at is null)
  or exists (select 1 from rso.contacts c where c.owner_id = ${s.user.id} and c.deleted_at is null)
  or exists (select 1 from rso.deal_splits x join rso.deals d2 on d2.id = x.deal_id where x.user_id = ${s.user.id} and d2.deleted_at is null)
)`;

/** People a record can be assigned to (owner pickers, create dialogs). */
export async function activeOwnerOptions(): Promise<OwnerOption[]> {
  return db.select({ id: s.user.id, name: s.user.name, email: s.user.email }).from(s.user).where(activeUserWhere).orderBy(asc(s.user.name));
}

/** Owner filter options: active people plus inactive/placeholder users that still own something. */
export async function ownerFilterOptions(): Promise<OwnerOption[]> {
  return db
    .select({ id: s.user.id, name: s.user.name, email: s.user.email })
    .from(s.user)
    .where(and(ne(s.user.role, "pending"), sql`(${activeUserWhere} or ${ownsRecords})`))
    .orderBy(asc(s.user.name));
}
