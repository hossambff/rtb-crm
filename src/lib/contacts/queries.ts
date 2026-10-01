import "server-only";
import { and, asc, desc, eq, exists, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealAccessWhere, ownedEntityWhere, scopeFor, inScope, type AppUser } from "@/lib/rbac/server";

/** Contacts the user may see: RBAC scope, soft delete, and never contacts of restricted accounts they can't see. */
export async function contactVisibilityWhere(user: AppUser, action: "view" | "edit" = "view"): Promise<SQL> {
  const owned = await ownedEntityWhere(user, "contacts", action, s.contacts.ownerId);
  const accountOk =
    user.role === "super_admin"
      ? sql`true`
      : or(
          isNull(s.contacts.accountId),
          exists(
            db
              .select({ x: sql`1` })
              .from(s.accounts)
              .where(
                and(
                  eq(s.accounts.id, s.contacts.accountId),
                  or(
                    eq(s.accounts.restricted, false),
                    exists(
                      db
                        .select({ y: sql`1` })
                        .from(s.restrictedAccess)
                        .where(and(eq(s.restrictedAccess.entity, "account"), eq(s.restrictedAccess.entityId, s.accounts.id), eq(s.restrictedAccess.userId, user.id))),
                    ),
                  ),
                ),
              ),
          ),
        )!;
  return and(isNull(s.contacts.deletedAt), owned, accountOk)!;
}

export type ContactListParams = { q?: string; status?: string; owner?: string; dnc?: string; sort?: string; dir?: string; page: number; pageSize: number };

export function parseContactListParams(sp: Record<string, string | string[] | undefined>): ContactListParams {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  return {
    q: one("q")?.slice(0, 100),
    status: one("status"),
    owner: one("owner"),
    dnc: one("dnc"),
    sort: one("sort"),
    dir: one("dir"),
    page: Math.max(1, Number(one("page") ?? 1) || 1),
    pageSize: [25, 50, 100].includes(Number(one("size"))) ? Number(one("size")) : 50,
  };
}

const relOwner = alias(s.user, "rel_owner");

export async function listContacts(user: AppUser, p: ContactListParams) {
  const visible = await contactVisibilityWhere(user);
  const conds: SQL[] = [visible];
  if (p.q) {
    const like = `%${p.q.replace(/[%_\\]/g, "\\$&")}%`;
    conds.push(or(ilike(s.contacts.fullName, like), ilike(s.contacts.email, like), ilike(s.contacts.title, like), ilike(s.accounts.name, like))!);
  }
  if (p.status) conds.push(eq(s.contacts.status, p.status));
  if (p.dnc === "yes") conds.push(eq(s.contacts.doNotContact, true));
  if (p.owner === "me") conds.push(or(eq(s.contacts.ownerId, user.id), eq(s.contacts.relationshipOwnerId, user.id))!);
  else if (p.owner === "team") {
    const team = user.teamMemberIds.length ? user.teamMemberIds : [user.id];
    conds.push(or(inArray(s.contacts.ownerId, team), inArray(s.contacts.relationshipOwnerId, team))!);
  } else if (p.owner === "none") conds.push(isNull(s.contacts.relationshipOwnerId));
  else if (p.owner) conds.push(eq(s.contacts.relationshipOwnerId, p.owner));
  const where = and(...conds)!;
  const desc_ = p.dir ? p.dir === "desc" : p.sort === "lastContacted" || p.sort === "updated";
  const order =
    p.sort === "account"
      ? desc_
        ? sql`lower(${s.accounts.name}) desc nulls last`
        : sql`lower(${s.accounts.name}) asc nulls last`
      : p.sort === "lastContacted"
        ? desc_
          ? sql`${s.contacts.lastContactedAt} desc nulls last`
          : sql`${s.contacts.lastContactedAt} asc nulls last`
        : p.sort === "updated"
          ? desc_
            ? desc(s.contacts.updatedAt)
            : asc(s.contacts.updatedAt)
          : desc_
            ? sql`lower(${s.contacts.fullName}) desc`
            : sql`lower(${s.contacts.fullName}) asc`;
  const base = db
    .select({
      id: s.contacts.id,
      fullName: s.contacts.fullName,
      title: s.contacts.title,
      email: s.contacts.email,
      phone: s.contacts.phone,
      linkedinUrl: s.contacts.linkedinUrl,
      status: s.contacts.status,
      doNotContact: s.contacts.doNotContact,
      lastContactedAt: s.contacts.lastContactedAt,
      accountId: s.contacts.accountId,
      accountName: s.accounts.name,
      relationshipOwner: relOwner.name,
      ownerId: s.contacts.ownerId,
      updatedAt: s.contacts.updatedAt,
    })
    .from(s.contacts)
    .leftJoin(s.accounts, eq(s.accounts.id, s.contacts.accountId))
    .leftJoin(relOwner, eq(relOwner.id, s.contacts.relationshipOwnerId));
  const [rows, [{ total }]] = await Promise.all([
    base
      .where(where)
      .orderBy(order, asc(s.contacts.id))
      .limit(p.pageSize)
      .offset((p.page - 1) * p.pageSize),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(s.contacts)
      .leftJoin(s.accounts, eq(s.accounts.id, s.contacts.accountId))
      .where(where),
  ]);
  return { rows, total, page: p.page, pageSize: p.pageSize };
}

export async function getContactDetail(user: AppUser, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const visible = await contactVisibilityWhere(user);
  const [contact] = await db.select().from(s.contacts).where(and(eq(s.contacts.id, id), visible));
  if (!contact) return null;
  const [dealWhere, editScope] = await Promise.all([dealAccessWhere(user, "view"), scopeFor(user, "contacts", "edit")]);
  const [account, relOwnerRow, owner, deals, activities, accountDeals] = await Promise.all([
    contact.accountId
      ? db.select({ id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain, doNotContact: s.accounts.doNotContact }).from(s.accounts).where(eq(s.accounts.id, contact.accountId)).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    contact.relationshipOwnerId ? db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(eq(s.user.id, contact.relationshipOwnerId)).then((r) => r[0] ?? null) : Promise.resolve(null),
    contact.ownerId ? db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(eq(s.user.id, contact.ownerId)).then((r) => r[0] ?? null) : Promise.resolve(null),
    db
      .select({
        dealId: s.deals.id,
        name: s.deals.name,
        role: s.dealContacts.role,
        pipelineKey: s.pipelines.key,
        pipelineColor: s.pipelines.color,
        stageName: s.stages.name,
        status: s.deals.status,
        isPrimary: sql<boolean>`${s.deals.primaryContactId} = ${contact.id}`,
      })
      .from(s.dealContacts)
      .innerJoin(s.deals, eq(s.deals.id, s.dealContacts.dealId))
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
      .where(and(eq(s.dealContacts.contactId, contact.id), dealWhere)),
    db
      .select({ id: s.activities.id, type: s.activities.type, source: s.activities.source, subject: s.activities.subject, body: s.activities.body, occurredAt: s.activities.occurredAt, actorName: s.user.name })
      .from(s.activities)
      .leftJoin(s.user, eq(s.user.id, s.activities.actorId))
      .where(
        and(
          eq(s.activities.contactId, contact.id),
          or(isNull(s.activities.dealId), exists(db.select({ x: sql`1` }).from(s.deals).where(and(eq(s.deals.id, s.activities.dealId), dealWhere))))!,
        ),
      )
      .orderBy(desc(s.activities.occurredAt))
      .limit(50),
    contact.accountId
      ? db
          .select({ id: s.deals.id, name: s.deals.name, pipelineKey: s.pipelines.key, stageName: s.stages.name })
          .from(s.deals)
          .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
          .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
          .where(and(eq(s.deals.accountId, contact.accountId), dealWhere))
      : Promise.resolve([]),
  ]);
  const canEdit = inScope(user, editScope, { ownerId: contact.ownerId });
  return { contact, account, relOwner: relOwnerRow, owner, deals, activities, accountDeals, canEdit };
}
