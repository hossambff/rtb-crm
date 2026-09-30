import "server-only";
import { and, asc, count, desc, eq, gte, ilike, inArray, lt, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import type { AppUser } from "@/lib/rbac/server";
import type { AuditFilters } from "./audit-core";

export const AUDIT_PAGE_SIZE = 50;

function where(f: AuditFilters): SQL {
  const parts: SQL[] = [];
  if (f.actor) parts.push(f.actor === "system" ? sql`${s.auditLog.actorId} is null` : eq(s.auditLog.actorId, f.actor));
  if (f.entity) parts.push(eq(s.auditLog.entity, f.entity));
  if (f.action) parts.push(ilike(s.auditLog.action, `%${f.action.replace(/[%_\\]/g, (c) => `\\${c}`)}%`));
  if (f.from) parts.push(gte(s.auditLog.createdAt, new Date(`${f.from}T00:00:00Z`)));
  if (f.to) parts.push(lt(s.auditLog.createdAt, new Date(new Date(`${f.to}T00:00:00Z`).getTime() + 86_400_000)));
  return parts.length ? and(...parts)! : sql`true`;
}

export type AuditRow = {
  id: number;
  actorId: string | null;
  actorName: string | null;
  actorKind: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: Date;
  redacted: boolean;
};

/**
 * Restricted (MNPI) records: before/after payloads of audit rows about restricted deals/accounts are redacted unless
 * the viewer is a super admin or on the record's access list (PRD AUD-3).
 */
async function redact(user: AppUser, rows: Omit<AuditRow, "redacted">[]): Promise<AuditRow[]> {
  if (user.role === "super_admin") return rows.map((r) => ({ ...r, redacted: false }));
  const ids = (entity: string) => rows.filter((r) => r.entity === entity && r.entityId && /^[0-9a-f-]{36}$/i.test(r.entityId)).map((r) => r.entityId!);
  const dealIds = ids("deal");
  const accountIds = ids("account");
  const [rDeals, rAccounts, access] = [
    dealIds.length ? await db.select({ id: s.deals.id }).from(s.deals).where(and(inArray(s.deals.id, dealIds), eq(s.deals.restricted, true))) : [],
    accountIds.length ? await db.select({ id: s.accounts.id }).from(s.accounts).where(and(inArray(s.accounts.id, accountIds), eq(s.accounts.restricted, true))) : [],
    await db.select({ entityId: s.restrictedAccess.entityId }).from(s.restrictedAccess).where(eq(s.restrictedAccess.userId, user.id)),
  ];
  const allowed = new Set(access.map((a) => a.entityId));
  const hidden = new Set([...rDeals, ...rAccounts].map((r) => r.id).filter((id) => !allowed.has(id)));
  return rows.map((r) =>
    r.entityId && hidden.has(r.entityId) ? { ...r, before: null, after: null, redacted: true } : { ...r, redacted: false },
  );
}

export async function listAudit(user: AppUser, f: AuditFilters) {
  const w = where(f);
  const [[total], rows] = [
    await db.select({ n: count() }).from(s.auditLog).where(w),
    await db
      .select({
        id: s.auditLog.id,
        actorId: s.auditLog.actorId,
        actorName: s.user.name,
        actorKind: s.auditLog.actorKind,
        action: s.auditLog.action,
        entity: s.auditLog.entity,
        entityId: s.auditLog.entityId,
        before: s.auditLog.before,
        after: s.auditLog.after,
        ip: s.auditLog.ip,
        createdAt: s.auditLog.createdAt,
      })
      .from(s.auditLog)
      .leftJoin(s.user, eq(s.auditLog.actorId, s.user.id))
      .where(w)
      .orderBy(desc(s.auditLog.createdAt), desc(s.auditLog.id))
      .limit(AUDIT_PAGE_SIZE)
      .offset((f.page - 1) * AUDIT_PAGE_SIZE),
  ];
  return { total: Number(total?.n ?? 0), rows: await redact(user, rows) };
}

/** Export: capped at 10k rows per file (narrow the filters for more). */
export async function exportAudit(user: AppUser, f: AuditFilters, cap = 10_000) {
  const rows = await db
    .select({
      id: s.auditLog.id,
      actorId: s.auditLog.actorId,
      actorName: s.user.name,
      actorKind: s.auditLog.actorKind,
      action: s.auditLog.action,
      entity: s.auditLog.entity,
      entityId: s.auditLog.entityId,
      before: s.auditLog.before,
      after: s.auditLog.after,
      ip: s.auditLog.ip,
      createdAt: s.auditLog.createdAt,
    })
    .from(s.auditLog)
    .leftJoin(s.user, eq(s.auditLog.actorId, s.user.id))
    .where(where(f))
    .orderBy(desc(s.auditLog.createdAt), desc(s.auditLog.id))
    .limit(cap);
  return redact(user, rows);
}

export async function auditFacets() {
  const [actors, entities] = [
    await db
      .selectDistinct({ id: s.auditLog.actorId, name: s.user.name })
      .from(s.auditLog)
      .leftJoin(s.user, eq(s.auditLog.actorId, s.user.id))
      .orderBy(asc(s.user.name))
      .limit(500),
    await db.selectDistinct({ entity: s.auditLog.entity }).from(s.auditLog).orderBy(asc(s.auditLog.entity)).limit(200),
  ];
  return {
    actors: actors.filter((a) => a.id).map((a) => ({ id: a.id!, name: a.name ?? a.id! })),
    hasSystem: actors.some((a) => !a.id),
    entities: entities.map((e) => e.entity).filter((e): e is string => Boolean(e)),
  };
}
