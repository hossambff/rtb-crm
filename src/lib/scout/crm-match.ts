import "server-only";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import type { CrmMatch } from "./core";

export type AccountLite = {
  id: string;
  name: string;
  domain: string | null;
  ownerId: string | null;
  restricted: boolean;
  doNotContact: boolean;
  category: string | null;
  country: string | null;
  ownership: string | null;
  muu: number | null;
  muuConfidence: string | null;
};

export type DomainMatch = CrmMatch & { account?: AccountLite; hasRelationship: boolean };

/**
 * Match domains against CRM accounts (domain or altDomains), then summarize the most relevant deal:
 * open deal (owner + stage) > most recent lost deal (reason) > account without deal. Restricted accounts are
 * reported only as "in CRM" — no deal/owner details leak (MNPI rule).
 */
export async function matchDomains(domains: string[]): Promise<Map<string, DomainMatch>> {
  const out = new Map<string, DomainMatch>();
  if (!domains.length) return out;
  const arr = sql`ARRAY[${sql.join(
    domains.map((d) => sql`${d}`),
    sql`, `,
  )}]::text[]`;
  const accts = await db
    .select({
      id: s.accounts.id,
      name: s.accounts.name,
      domain: s.accounts.domain,
      altDomains: s.accounts.altDomains,
      ownerId: s.accounts.ownerId,
      restricted: s.accounts.restricted,
      doNotContact: s.accounts.doNotContact,
      category: s.accounts.category,
      country: s.accounts.country,
      ownership: s.accounts.ownership,
      muu: s.accounts.muu,
      muuConfidence: s.accounts.muuConfidence,
    })
    .from(s.accounts)
    .where(and(isNull(s.accounts.deletedAt), or(inArray(s.accounts.domain, domains), sql`${s.accounts.altDomains} && ${arr}`)));
  if (!accts.length) return out;
  const ids = accts.map((a) => a.id);
  const [dealRows, contactCounts] = await Promise.all([
    db
      .select({
        id: s.deals.id,
        accountId: s.deals.accountId,
        status: s.deals.status,
        ownerId: s.deals.ownerId,
        ownerName: s.user.name,
        stage: s.stages.name,
        pipelineKey: s.pipelines.key,
        lostAt: s.deals.lostAt,
        lostReason: s.deals.lostReason,
        restricted: s.deals.restricted,
        updatedAt: s.deals.updatedAt,
      })
      .from(s.deals)
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .leftJoin(s.user, eq(s.user.id, s.deals.ownerId))
      .where(and(inArray(s.deals.accountId, ids), isNull(s.deals.deletedAt)))
      .orderBy(desc(s.deals.updatedAt)),
    db
      .select({ accountId: s.contacts.accountId, n: sql<number>`count(*)::int` })
      .from(s.contacts)
      .where(and(inArray(s.contacts.accountId, ids), isNull(s.contacts.deletedAt)))
      .groupBy(s.contacts.accountId),
  ]);
  const contactsBy = new Map(contactCounts.map((c) => [c.accountId, c.n]));
  for (const a of accts) {
    const acctDeals = dealRows.filter((d) => d.accountId === a.id && !d.restricted);
    const won = acctDeals.some((d) => d.status === "won");
    const hasRelationship = (contactsBy.get(a.id) ?? 0) > 0 || won;
    const account: AccountLite = { ...a, muuConfidence: a.muuConfidence ?? null };
    let m: DomainMatch;
    if (a.restricted) m = { status: "in_crm", accountId: a.id, hasRelationship: false, account };
    else {
      const open = acctDeals.find((d) => d.status === "open" || d.status === "hold");
      const lost = acctDeals.find((d) => d.status === "lost");
      if (open)
        m = { status: "open_deal", accountId: a.id, dealId: open.id, ownerId: open.ownerId ?? undefined, ownerName: open.ownerName, stage: open.stage, pipelineKey: open.pipelineKey, accountOwnerId: a.ownerId, hasRelationship, account };
      else if (lost)
        m = { status: "lost", accountId: a.id, dealId: lost.id, lostAt: lost.lostAt?.toISOString() ?? lost.updatedAt.toISOString(), lostReason: lost.lostReason, stage: lost.stage, pipelineKey: lost.pipelineKey, accountOwnerId: a.ownerId, hasRelationship, account };
      else m = { status: "in_crm", accountId: a.id, accountOwnerId: a.ownerId, hasRelationship, account };
    }
    for (const d of [a.domain, ...a.altDomains]) if (d && domains.includes(d) && !out.has(d)) out.set(d, m);
  }
  return out;
}

/** Categories of accounts with won deals — cheap "lookalike of won partners" signal when no Apify similarity exists. */
export async function wonCategories(): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ c: s.accounts.category })
    .from(s.deals)
    .innerJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .where(and(eq(s.deals.status, "won"), isNull(s.deals.deletedAt)));
  return new Set(rows.map((r) => r.c?.toLowerCase()).filter((c): c is string => Boolean(c)));
}

/** Suppressed domains (global suppression list, SCOUT-23). */
export async function suppressedDomains(domains: string[]): Promise<Set<string>> {
  if (!domains.length) return new Set();
  const rows = await db.select({ v: s.suppressionList.value }).from(s.suppressionList).where(and(eq(s.suppressionList.kind, "domain"), inArray(s.suppressionList.value, domains)));
  return new Set(rows.map((r) => r.v));
}

export async function suppressedEmails(emails: string[]): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const lower = emails.map((e) => e.toLowerCase());
  const domains = [...new Set(lower.map((e) => e.split("@")[1]).filter((d): d is string => Boolean(d)))];
  const rows = await db
    .select({ v: s.suppressionList.value, k: s.suppressionList.kind })
    .from(s.suppressionList)
    .where(or(and(eq(s.suppressionList.kind, "email"), inArray(s.suppressionList.value, lower)), domains.length ? and(eq(s.suppressionList.kind, "domain"), inArray(s.suppressionList.value, domains)) : sql`false`));
  const emailSet = new Set(rows.filter((r) => r.k === "email").map((r) => r.v));
  const domSet = new Set(rows.filter((r) => r.k === "domain").map((r) => r.v));
  return new Set(lower.filter((e) => emailSet.has(e) || domSet.has(e.split("@")[1] ?? "")));
}

/** Domains rejected in any search within the suppression window (reject → no re-scout for 6 months). */
export async function recentlyRejected(domains: string[], since: Date): Promise<Set<string>> {
  if (!domains.length) return new Set();
  const rows = await db
    .select({ d: s.scoutCandidates.domain })
    .from(s.scoutCandidates)
    .where(and(inArray(s.scoutCandidates.domain, domains), eq(s.scoutCandidates.state, "rejected"), sql`coalesce(${s.scoutCandidates.reviewedAt}, ${s.scoutCandidates.createdAt}) >= ${since.toISOString()}::timestamptz`));
  return new Set(rows.map((r) => r.d));
}
