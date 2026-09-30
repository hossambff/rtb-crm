import "server-only";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { emailDomain } from "@/lib/domain";
import { env } from "@/lib/env";
import { buildDirectory, pickDeal, type Directory } from "./matching-core";

/** Contacts + account domains for participant matching (loaded once per sync run). */
export async function loadDirectory(): Promise<Directory> {
  const [contacts, accounts] = await Promise.all([
    db
      .select({ id: s.contacts.id, email: s.contacts.email, altEmails: s.contacts.altEmails, accountId: s.contacts.accountId })
      .from(s.contacts)
      .where(and(isNull(s.contacts.deletedAt), or(sql`${s.contacts.email} is not null`, sql`cardinality(${s.contacts.altEmails}) > 0`))),
    db
      .select({ id: s.accounts.id, domain: s.accounts.domain, altDomains: s.accounts.altDomains })
      .from(s.accounts)
      .where(and(isNull(s.accounts.deletedAt), or(sql`${s.accounts.domain} is not null`, sql`cardinality(${s.accounts.altDomains}) > 0`))),
  ]);
  return buildDirectory(contacts, accounts);
}

/** RTB's own domains (env allowlist + admin-added allowed_domains + the mailbox owner's domain). */
export async function internalDomains(ownerEmail?: string | null): Promise<string[]> {
  let extra: string[] = [];
  try {
    extra = (await db.select({ d: s.allowedDomains.domain }).from(s.allowedDomains)).map((r) => r.d.toLowerCase());
  } catch {
    extra = [];
  }
  const own = emailDomain(ownerEmail);
  return [...new Set([...env.allowedDomains, ...extra, ...(own ? [own] : [])])];
}

/**
 * Open deal for an account from the user's perspective: owned by/split with the user first, else the most recently
 * active open deal. Restricted deals only when the user owns/splits them.
 */
export async function resolveDealForAccount(accountId: string | null, userId: string): Promise<string | null> {
  if (!accountId) return null;
  const rows = await db
    .select({
      id: s.deals.id,
      ownerId: s.deals.ownerId,
      restricted: s.deals.restricted,
      lastActivityAt: s.deals.lastActivityAt,
      updatedAt: s.deals.updatedAt,
      splitUserIds: sql<string[]>`coalesce((select array_agg(${s.dealSplits.userId}) from ${s.dealSplits} where ${s.dealSplits.dealId} = ${s.deals.id}), '{}')`,
    })
    .from(s.deals)
    .where(and(eq(s.deals.accountId, accountId), eq(s.deals.status, "open"), isNull(s.deals.deletedAt)));
  const allowed = rows.filter((d) => !d.restricted || d.ownerId === userId || d.splitUserIds.includes(userId));
  return pickDeal(allowed, userId)?.id ?? null;
}

/** Open/hold stage names of a deal's pipeline (what AI stage suggestions must choose from). */
export async function dealStageNames(dealId: string | null): Promise<string[]> {
  if (!dealId) return [];
  const rows = await db
    .select({ name: s.stages.name, category: s.stages.category })
    .from(s.stages)
    .innerJoin(s.deals, eq(s.deals.pipelineId, s.stages.pipelineId))
    .where(eq(s.deals.id, dealId))
    .orderBy(s.stages.sortOrder);
  return rows.filter((r) => r.category === "open" || r.category === "hold").map((r) => r.name);
}

/** Bump deals.lastActivityAt / contacts.lastContactedAt (never moves them backwards). */
export async function bumpActivity(dealId: string | null, contactIds: string[], at: Date) {
  if (dealId) {
    await db
      .update(s.deals)
      .set({ lastActivityAt: sql`greatest(coalesce(${s.deals.lastActivityAt}, 'epoch'::timestamptz), ${at.toISOString()}::timestamptz)` })
      .where(eq(s.deals.id, dealId));
  }
  if (contactIds.length) {
    await db
      .update(s.contacts)
      .set({ lastContactedAt: sql`greatest(coalesce(${s.contacts.lastContactedAt}, 'epoch'::timestamptz), ${at.toISOString()}::timestamptz)` })
      .where(inArray(s.contacts.id, contactIds));
  }
}
