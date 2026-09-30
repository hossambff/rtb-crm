import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { isPlaceholderEmail, USER_KEYED_TABLES, USER_REF_COLUMNS, type ClaimSummary } from "./claim-plan";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function rowCount(res: unknown): number {
  const r = res as { count?: number; length?: number };
  return Number(r.count ?? r.length ?? 0);
}

/**
 * Claim a placeholder user into a real user (single transaction):
 * 1. re-point every ownership/attribution column (USER_REF_COLUMNS) from placeholder → target;
 * 2. move user-keyed rows (deal splits, commission assignments, restricted access), merging on conflict;
 * 3. copy team/manager onto the target when the target has none;
 * 4. ban the placeholder (kept for the audit trail — never deleted, audit_log keeps pointing at it).
 * Returns per-table counts for the audit entry.
 */
export async function claimPlaceholder(placeholderId: string, targetId: string): Promise<ClaimSummary> {
  if (placeholderId === targetId) throw new UserError("Choose a different user to claim into.");
  const [ph] = await db.select().from(s.user).where(eq(s.user.id, placeholderId));
  const [target] = await db.select().from(s.user).where(eq(s.user.id, targetId));
  if (!ph || !isPlaceholderEmail(ph.email)) throw new UserError("That user is not an import placeholder.");
  if ((ph.banReason ?? "").startsWith("Claimed by")) throw new UserError("That placeholder was already claimed.");
  if (!target || target.banned) throw new UserError("Choose an active user to claim into.");
  if (isPlaceholderEmail(target.email)) throw new UserError("Claim into a real user, not another placeholder.");

  return db.transaction(async (tx: Tx) => {
    const counts: ClaimSummary = {};
    // deal splits: merge percentages where the target already has a split on the same deal
    const merged = await tx.execute(sql`
      update ${s.dealSplits} t set pct = least(100, round((t.pct + p.pct)::numeric, 2))::float8
      from ${s.dealSplits} p
      where p.deal_id = t.deal_id and p.user_id = ${placeholderId} and t.user_id = ${targetId}`);
    counts.deal_splits_merged = rowCount(merged);
    for (const k of USER_KEYED_TABLES) {
      const table = sql.identifier(k.table);
      const key = sql.identifier(k.key);
      const col = sql.identifier(k.column);
      if (k.table === "restricted_access") {
        await tx.execute(sql`
          delete from rso.${table} p where p.${col} = ${placeholderId}
          and exists (select 1 from rso.${table} t where t.${col} = ${targetId} and t.${key} = p.${key} and t.entity = p.entity)`);
      } else {
        await tx.execute(sql`
          delete from rso.${table} p where p.${col} = ${placeholderId}
          and exists (select 1 from rso.${table} t where t.${col} = ${targetId} and t.${key} = p.${key})`);
      }
      const moved = await tx.execute(sql`update rso.${table} set ${col} = ${targetId} where ${col} = ${placeholderId}`);
      counts[k.table] = rowCount(moved);
    }
    for (const r of USER_REF_COLUMNS) {
      const res = await tx.execute(
        sql`update rso.${sql.identifier(r.table)} set ${sql.identifier(r.column)} = ${targetId} where ${sql.identifier(r.column)} = ${placeholderId}`,
      );
      const n = rowCount(res);
      if (n) counts[`${r.table}.${r.column}`] = n;
    }
    await tx
      .update(s.user)
      .set({
        teamId: target.teamId ?? ph.teamId,
        // the loop above may have made the target its own manager (target reported to the placeholder)
        managerId:
          target.managerId && target.managerId !== placeholderId ? target.managerId : ph.managerId && ph.managerId !== targetId ? ph.managerId : null,
      })
      .where(eq(s.user.id, targetId));
    await tx
      .update(s.user)
      .set({ banned: true, banReason: `Claimed by ${target.email}` })
      .where(eq(s.user.id, placeholderId));
    await tx.delete(s.session).where(eq(s.session.userId, placeholderId));
    return counts;
  });
}
