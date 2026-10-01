import "server-only";
import { and, asc, desc, eq, exists, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { canSeeRestricted, dealAccessWhere, ownedEntityWhere, scopeFor, inScope, type AppUser } from "@/lib/rbac/server";

import { ACCOUNT_SORTS, MUU_RANGES, type AccountSort } from "./constants";

/** Accounts the user may see: RBAC scope + soft delete + restricted (MNPI) access list. */
export async function accountVisibilityWhere(user: AppUser, action: "view" | "edit" = "view"): Promise<SQL> {
  const owned = await ownedEntityWhere(user, "accounts", action, s.accounts.ownerId);
  const restrictedOk =
    user.role === "super_admin"
      ? sql`true`
      : or(
          eq(s.accounts.restricted, false),
          exists(
            db
              .select({ x: sql`1` })
              .from(s.restrictedAccess)
              .where(and(eq(s.restrictedAccess.entity, "account"), eq(s.restrictedAccess.entityId, s.accounts.id), eq(s.restrictedAccess.userId, user.id))),
          ),
        )!;
  return and(isNull(s.accounts.deletedAt), owned, restrictedOk)!;
}

export type AccountListParams = {
  q?: string;
  sort?: string;
  dir?: string;
  page?: number;
  pageSize?: number;
  type?: string;
  category?: string;
  lifecycle?: string;
  priority?: string;
  owner?: string;
  openDeal?: string;
  muu?: string;
};

export type AccountListRow = {
  id: string;
  name: string;
  domain: string | null;
  type: string;
  category: string | null;
  lifecycle: string;
  priority: string | null;
  muu: number | null;
  muuSource: string | null;
  muuConfidence: string | null;
  ownerId: string | null;
  ownerName: string | null;
  restricted: boolean;
  openDeals: number;
  pipelines: string[];
  updatedAt: Date;
};

export function parseAccountListParams(sp: Record<string, string | string[] | undefined>): AccountListParams {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const page = Math.max(1, Number(one("page") ?? 1) || 1);
  const pageSize = [25, 50, 100].includes(Number(one("size"))) ? Number(one("size")) : 50;
  return {
    q: one("q")?.slice(0, 100),
    sort: one("sort"),
    dir: one("dir"),
    page,
    pageSize,
    type: one("type"),
    category: one("category"),
    lifecycle: one("lifecycle"),
    priority: one("priority"),
    owner: one("owner"),
    openDeal: one("openDeal"),
    muu: one("muu"),
  };
}

export async function listAccounts(user: AppUser, p: AccountListParams) {
  const [visible, dealWhere] = await Promise.all([accountVisibilityWhere(user), dealAccessWhere(user, "view")]);
  const openDealExists = exists(
    db
      .select({ x: sql`1` })
      .from(s.deals)
      .where(and(eq(s.deals.accountId, s.accounts.id), eq(s.deals.status, "open"), dealWhere)),
  );
  const conds: SQL[] = [visible];
  if (p.q) {
    const like = `%${p.q.replace(/[%_\\]/g, "\\$&")}%`;
    conds.push(or(ilike(s.accounts.name, like), ilike(s.accounts.domain, like))!);
  }
  if (p.type) conds.push(eq(s.accounts.type, p.type as never));
  if (p.category) conds.push(eq(s.accounts.category, p.category));
  if (p.lifecycle) conds.push(eq(s.accounts.lifecycle, p.lifecycle as never));
  if (p.priority) conds.push(eq(s.accounts.priority, p.priority as never));
  if (p.owner === "none") conds.push(isNull(s.accounts.ownerId));
  else if (p.owner === "me") conds.push(eq(s.accounts.ownerId, user.id));
  else if (p.owner === "team") conds.push(inArray(s.accounts.ownerId, user.teamMemberIds.length ? user.teamMemberIds : [user.id]));
  else if (p.owner) conds.push(eq(s.accounts.ownerId, p.owner));
  if (p.openDeal === "yes") conds.push(openDealExists);
  if (p.openDeal === "no") conds.push(sql`not ${openDealExists}`);
  const range = MUU_RANGES.find((r) => r.key === p.muu);
  if (range) {
    conds.push(sql`${s.accounts.muu} >= ${range.min}`);
    if (range.max != null) conds.push(sql`${s.accounts.muu} < ${range.max}`);
  }
  const where = and(...conds)!;
  const sort: AccountSort = (ACCOUNT_SORTS as readonly string[]).includes(p.sort ?? "") ? (p.sort as AccountSort) : "name";
  const dirDesc = p.dir ? p.dir === "desc" : sort === "muu" || sort === "updated" || sort === "created";
  const order = (() => {
    switch (sort) {
      case "muu":
        return dirDesc ? sql`${s.accounts.muu} desc nulls last` : sql`${s.accounts.muu} asc nulls last`;
      case "updated":
        return dirDesc ? desc(s.accounts.updatedAt) : asc(s.accounts.updatedAt);
      case "created":
        return dirDesc ? desc(s.accounts.createdAt) : asc(s.accounts.createdAt);
      case "lifecycle":
        return dirDesc ? desc(s.accounts.lifecycle) : asc(s.accounts.lifecycle);
      case "priority":
        return dirDesc ? sql`${s.accounts.priority} desc nulls last` : sql`${s.accounts.priority} asc nulls last`;
      default:
        return dirDesc ? sql`lower(${s.accounts.name}) desc` : sql`lower(${s.accounts.name}) asc`;
    }
  })();
  const page = p.page ?? 1;
  const size = p.pageSize ?? 50;
  const openCount = sql<number>`(select count(*)::int from ${s.deals} where ${s.deals.accountId} = ${s.accounts.id} and ${s.deals.status} = 'open' and ${dealWhere})`;
  const pipelineKeys = sql<string[] | null>`(select array_agg(distinct p.key) from ${s.deals} join ${s.pipelines} p on p.id = ${s.deals.pipelineId} where ${s.deals.accountId} = ${s.accounts.id} and ${s.deals.status} <> 'lost' and ${dealWhere})`;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: s.accounts.id,
        name: s.accounts.name,
        domain: s.accounts.domain,
        type: s.accounts.type,
        category: s.accounts.category,
        lifecycle: s.accounts.lifecycle,
        priority: s.accounts.priority,
        muu: s.accounts.muu,
        muuSource: s.accounts.muuSource,
        muuConfidence: s.accounts.muuConfidence,
        ownerId: s.accounts.ownerId,
        ownerName: s.user.name,
        restricted: s.accounts.restricted,
        openDeals: openCount,
        pipelines: pipelineKeys,
        updatedAt: s.accounts.updatedAt,
      })
      .from(s.accounts)
      .leftJoin(s.user, eq(s.user.id, s.accounts.ownerId))
      .where(where)
      .orderBy(order, asc(s.accounts.id))
      .limit(size)
      .offset((page - 1) * size),
    db.select({ total: sql<number>`count(*)::int` }).from(s.accounts).where(where),
  ]);
  return { rows: rows.map((r) => ({ ...r, pipelines: r.pipelines ?? [] })) as AccountListRow[], total, page, pageSize: size };
}

export async function accountFilterOptions() {
  const [cats, owners] = await Promise.all([
    db
      .selectDistinct({ category: s.accounts.category })
      .from(s.accounts)
      .where(and(isNull(s.accounts.deletedAt), sql`${s.accounts.category} is not null`))
      .orderBy(s.accounts.category)
      .limit(200),
    assignableUsers(),
  ]);
  return { categories: cats.map((c) => c.category!).filter(Boolean), owners };
}

/** Users that can own records (active roles + spreadsheet placeholders), for owner pickers & filters. */
export async function assignableUsers() {
  return db
    .select({ id: s.user.id, name: s.user.name, email: s.user.email })
    .from(s.user)
    .where(ne(s.user.role, "pending"))
    .orderBy(s.user.name);
}

/** Load one account if visible to the user; returns null otherwise (callers render notFound()). */
export async function getVisibleAccount(user: AppUser, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const visible = await accountVisibilityWhere(user);
  const [row] = await db.select().from(s.accounts).where(and(eq(s.accounts.id, id), visible));
  return row ?? null;
}

export async function getAccount360(user: AppUser, id: string) {
  const account = await getVisibleAccount(user, id);
  if (!account) return null;
  const [dealWhere, contactWhere, editScope] = await Promise.all([
    dealAccessWhere(user, "view"),
    ownedEntityWhere(user, "contacts", "view", s.contacts.ownerId),
    scopeFor(user, "accounts", "edit"),
  ]);
  const childIdsQ = db.select({ id: s.accounts.id }).from(s.accounts).where(and(eq(s.accounts.parentId, account.id), isNull(s.accounts.deletedAt)));
  const [parent, children, deals, contacts, activities, documents, metrics, owner, migrations, childDeals] = await Promise.all([
    account.parentId
      ? // SEC M-1: never reveal a parent the user can't see (restricted / out of scope).
        db.select({ id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain }).from(s.accounts).where(and(eq(s.accounts.id, account.parentId), await accountVisibilityWhere(user))).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    db
      .select({ id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain, muu: s.accounts.muu, lifecycle: s.accounts.lifecycle, muuConfidence: s.accounts.muuConfidence })
      .from(s.accounts)
      .where(and(eq(s.accounts.parentId, account.id), await accountVisibilityWhere(user)))
      .orderBy(sql`${s.accounts.muu} desc nulls last`),
    db
      .select({
        id: s.deals.id,
        name: s.deals.name,
        status: s.deals.status,
        pipelineKey: s.pipelines.key,
        pipelineName: s.pipelines.name,
        pipelineColor: s.pipelines.color,
        unit: s.pipelines.unit,
        usdPerMuu: s.pipelines.usdPerMuu,
        stageName: s.stages.name,
        stageCategory: s.stages.category,
        stageProbability: s.stages.probability,
        muu: s.deals.muu,
        contractValueCents: s.deals.contractValueCents,
        annualizedValueCents: s.deals.annualizedValueCents,
        probabilityOverride: s.deals.probabilityOverride,
        overrideStatus: s.deals.overrideStatus,
        nextStep: s.deals.nextStep,
        nextStepDueAt: s.deals.nextStepDueAt,
        ownerName: s.user.name,
        restricted: s.deals.restricted,
        r100: s.deals.r100,
        updatedAt: s.deals.updatedAt,
      })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
      .leftJoin(s.user, eq(s.user.id, s.deals.ownerId))
      .where(and(eq(s.deals.accountId, account.id), dealWhere))
      .orderBy(s.pipelines.sortOrder, desc(s.deals.updatedAt)),
    db
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
        seniority: s.contacts.seniority,
        relationshipOwner: s.user.name,
      })
      .from(s.contacts)
      .leftJoin(s.user, eq(s.user.id, s.contacts.relationshipOwnerId))
      .where(and(eq(s.contacts.accountId, account.id), isNull(s.contacts.deletedAt), contactWhere))
      .orderBy(asc(s.contacts.fullName))
      .limit(500),
    db
      .select({
        id: s.activities.id,
        type: s.activities.type,
        source: s.activities.source,
        subject: s.activities.subject,
        body: s.activities.body,
        occurredAt: s.activities.occurredAt,
        dealId: s.activities.dealId,
        actorName: s.user.name,
        pinned: s.activities.pinned,
      })
      .from(s.activities)
      .leftJoin(s.user, eq(s.user.id, s.activities.actorId))
      .where(
        and(
          eq(s.activities.accountId, account.id),
          or(isNull(s.activities.dealId), exists(db.select({ x: sql`1` }).from(s.deals).where(and(eq(s.deals.id, s.activities.dealId), dealWhere))))!,
        ),
      )
      .orderBy(desc(s.activities.pinned), desc(s.activities.occurredAt))
      .limit(100),
    db
      .select()
      .from(s.documents)
      .where(
        // SEC H-2: account-level documents, plus deal documents only when the deal itself is visible (restricted/scope).
        or(
          and(eq(s.documents.accountId, account.id), isNull(s.documents.dealId)),
          exists(db.select({ x: sql`1` }).from(s.deals).where(and(eq(s.deals.id, s.documents.dealId), eq(s.deals.accountId, account.id), dealWhere))),
        ),
      )
      .orderBy(desc(s.documents.createdAt))
      .limit(100),
    db.select().from(s.audienceMetrics).where(eq(s.audienceMetrics.accountId, account.id)).orderBy(asc(s.audienceMetrics.period), asc(s.audienceMetrics.createdAt)),
    account.ownerId ? db.select({ id: s.user.id, name: s.user.name, email: s.user.email }).from(s.user).where(eq(s.user.id, account.ownerId)).then((r) => r[0] ?? null) : Promise.resolve(null),
    db
      .select({ id: s.migrationProjects.id, name: s.migrationProjects.name, stage: s.migrationProjects.stage, launched: s.migrationProjects.launched, targetGoLive: s.migrationProjects.targetGoLive })
      .from(s.migrationProjects)
      .where(eq(s.migrationProjects.accountId, account.id)),
    db
      .select({ pipelineKey: s.pipelines.key, muu: sql<number>`coalesce(sum(${s.deals.muu}),0)::bigint`, n: sql<number>`count(*)::int` })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .where(and(inArray(s.deals.accountId, childIdsQ), eq(s.deals.status, "open"), dealWhere))
      .groupBy(s.pipelines.key),
  ]);
  const canEdit = inScope(user, editScope, { ownerId: account.ownerId });
  const canSeeRestrictedFlag = account.restricted ? await canSeeRestricted(user, "account", account.id) : true;
  return { account, parent, children, deals, contacts, activities, documents, metrics, owner, migrations, childDeals, canEdit, canSeeRestrictedFlag };
}

export type Account360 = NonNullable<Awaited<ReturnType<typeof getAccount360>>>;

/** Small account picker search (merge tool, contact form, parent picker). */
export async function searchAccounts(user: AppUser, q: string, limit = 10) {
  const visible = await accountVisibilityWhere(user);
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  return db
    .select({ id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain, type: s.accounts.type })
    .from(s.accounts)
    .where(and(visible, or(ilike(s.accounts.name, like), ilike(s.accounts.domain, like))))
    .orderBy(sql`lower(${s.accounts.name})`)
    .limit(limit);
}
