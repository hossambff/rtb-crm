/**
 * Close open alerts that point at soft-deleted deals/accounts (resolution "Record deleted"), so the alerts tab and
 * bell counts stop showing them. Called right after a soft-delete (import rollback) and on every sweep for records
 * deleted by any other path. Takes the drizzle client (or a transaction) and has no server-only imports, because the
 * import engine is shared with scripts/.
 */
import { and, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as s from "../../db/schema";

export const RECORD_DELETED_RESOLUTION = "Record deleted";
const OPEN = ["open", "acknowledged", "snoozed", "escalated"] as const;

type Db = Pick<PostgresJsDatabase<typeof s>, "update">;

/** Resolve the open alerts of these just-deleted records. Returns the number of alerts closed. */
export async function resolveAlertsForDeleted(d: Db, entity: "deal" | "account", ids: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = await d
      .update(s.alerts)
      .set({ state: "resolved", resolvedAt: new Date(), resolution: RECORD_DELETED_RESOLUTION })
      .where(and(sql`${s.alerts.entity} = ${entity}`, inArray(s.alerts.entityId, part), inArray(s.alerts.state, [...OPEN])))
      .returning({ id: s.alerts.id });
    n += rows.length;
  }
  return n;
}

/** Sweep step: resolve every open deal/account alert whose record is soft-deleted. Returns the number closed. */
export async function resolveAlertsOnDeletedRecords(d: Db): Promise<number> {
  const rows = await d
    .update(s.alerts)
    .set({ state: "resolved", resolvedAt: new Date(), resolution: RECORD_DELETED_RESOLUTION })
    .where(
      and(
        inArray(s.alerts.state, [...OPEN]),
        sql`(
          (${s.alerts.entity} = 'deal' and exists (select 1 from ${s.deals} x where x.id::text = ${s.alerts.entityId} and x.deleted_at is not null))
          or (${s.alerts.entity} = 'account' and exists (select 1 from ${s.accounts} x where x.id::text = ${s.alerts.entityId} and x.deleted_at is not null))
        )`,
      ),
    )
    .returning({ id: s.alerts.id });
  return rows.length;
}
