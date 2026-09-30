import "server-only";
import { and, count, desc, eq, exists, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealAccessWhere, ForbiddenError, scopeFor, type AppUser } from "@/lib/rbac/server";
import type { Scope } from "@/lib/rbac/model";
import type { StoredEmailAnalysis } from "./analyze";

export type InboxFilters = {
  awaiting?: "us" | "them";
  intent?: string;
  linked?: "linked" | "unlinked";
  mailbox?: "mine" | "team";
  view?: "private";
  q?: string;
};

export async function emailScope(user: AppUser): Promise<Scope> {
  return scopeFor(user, "email", "view");
}

/**
 * Visibility (EML-11): your own mailbox (incl. private threads only in the Private view); other people's mailboxes only
 * within your email scope (team/all), never private, and only threads linked to a deal you can view.
 */
async function visibleThreadsWhere(user: AppUser, filters: InboxFilters): Promise<SQL> {
  const scope = await emailScope(user);
  if (scope === "none") throw new ForbiddenError("You don't have access to the Inbox.");
  const own = eq(s.emailThreads.mailboxUserId, user.id);
  if (filters.view === "private") return and(own, eq(s.emailThreads.private, true))!;
  const mineVisible = and(own, eq(s.emailThreads.private, false))!;
  if (filters.mailbox === "mine" || scope === "own") return mineVisible;
  const dealWhere = await dealAccessWhere(user, "view");
  const ownerCond = scope === "team" ? inArray(s.emailThreads.mailboxUserId, user.teamMemberIds.length ? user.teamMemberIds : [user.id]) : sql`true`;
  const others = and(
    ownerCond,
    eq(s.emailThreads.private, false),
    isNotNull(s.emailThreads.dealId),
    exists(db.select({ x: sql`1` }).from(s.deals).where(and(eq(s.deals.id, s.emailThreads.dealId), dealWhere))),
  )!;
  return filters.mailbox === "team" ? and(others, sql`${s.emailThreads.mailboxUserId} <> ${user.id}`)! : or(mineVisible, others)!;
}

export type ThreadListItem = Awaited<ReturnType<typeof listThreads>>[number];

export async function listThreads(user: AppUser, filters: InboxFilters, limit = 150) {
  const base = await visibleThreadsWhere(user, filters);
  const conds: SQL[] = [base];
  if (filters.awaiting) conds.push(eq(s.emailThreads.awaitingReplyFrom, filters.awaiting));
  if (filters.intent) conds.push(eq(s.emailThreads.aiIntent, filters.intent));
  if (filters.linked === "linked") conds.push(isNotNull(s.emailThreads.dealId));
  if (filters.linked === "unlinked") conds.push(isNull(s.emailThreads.dealId));
  if (filters.q) {
    const like = `%${filters.q.replace(/[%_\\]/g, "\\$&")}%`;
    conds.push(or(ilike(s.emailThreads.subject, like), sql`array_to_string(${s.emailThreads.participants}, ' ') ilike ${like}`)!);
  }
  const rows = await db
    .select({
      id: s.emailThreads.id,
      subject: s.emailThreads.subject,
      snippet: s.emailThreads.snippet,
      participants: s.emailThreads.participants,
      lastMessageAt: s.emailThreads.lastMessageAt,
      awaitingReplyFrom: s.emailThreads.awaitingReplyFrom,
      aiIntent: s.emailThreads.aiIntent,
      dealId: s.emailThreads.dealId,
      accountId: s.emailThreads.accountId,
      accountName: s.accounts.name,
      private: s.emailThreads.private,
      mailboxUserId: s.emailThreads.mailboxUserId,
      mailboxName: s.user.name,
      messageCount: sql<number>`(select count(*)::int from ${s.emailMessages} where ${s.emailMessages.threadId} = ${s.emailThreads.id})`,
    })
    .from(s.emailThreads)
    .leftJoin(s.accounts, eq(s.accounts.id, s.emailThreads.accountId))
    .innerJoin(s.user, eq(s.user.id, s.emailThreads.mailboxUserId))
    .where(and(...conds))
    .orderBy(sql`${s.emailThreads.lastMessageAt} desc nulls last`)
    .limit(limit);
  const dealNames = await visibleDealNames(user, rows.map((r) => r.dealId));
  return rows.map((r) => ({ ...r, dealName: r.dealId ? (dealNames.get(r.dealId) ?? null) : null, dealVisible: r.dealId ? dealNames.has(r.dealId) : false }));
}

export async function visibleDealNames(user: AppUser, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map();
  const where = await dealAccessWhere(user, "view");
  const rows = await db
    .select({ id: s.deals.id, name: s.deals.name })
    .from(s.deals)
    .where(and(inArray(s.deals.id, unique), where));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function inboxCounts(user: AppUser) {
  const [row] = await db
    .select({
      us: sql<number>`count(*) filter (where ${s.emailThreads.awaitingReplyFrom} = 'us')::int`,
      them: sql<number>`count(*) filter (where ${s.emailThreads.awaitingReplyFrom} = 'them')::int`,
      unlinked: sql<number>`count(*) filter (where ${s.emailThreads.dealId} is null)::int`,
      total: count(),
    })
    .from(s.emailThreads)
    .where(and(eq(s.emailThreads.mailboxUserId, user.id), eq(s.emailThreads.private, false)));
  return row ?? { us: 0, them: 0, unlinked: 0, total: 0 };
}

/** Full thread for the detail pane, or null when not visible to the user. */
export async function getThread(user: AppUser, threadId: string) {
  const scope = await emailScope(user);
  if (scope === "none") return null;
  const [t] = await db
    .select({ t: s.emailThreads, accountName: s.accounts.name, mailboxName: s.user.name })
    .from(s.emailThreads)
    .leftJoin(s.accounts, eq(s.accounts.id, s.emailThreads.accountId))
    .innerJoin(s.user, eq(s.user.id, s.emailThreads.mailboxUserId))
    .where(eq(s.emailThreads.id, threadId));
  if (!t) return null;
  const isOwn = t.t.mailboxUserId === user.id;
  const dealNames = await visibleDealNames(user, [t.t.dealId]);
  if (!isOwn) {
    if (t.t.private || !t.t.dealId || !dealNames.has(t.t.dealId)) return null;
    if (scope === "own") return null;
    if (scope === "team" && !user.teamMemberIds.includes(t.t.mailboxUserId)) return null;
  }
  const messages = await db
    .select()
    .from(s.emailMessages)
    .where(eq(s.emailMessages.threadId, threadId))
    .orderBy(sql`${s.emailMessages.sentAt} asc nulls first`);
  const evidence = messages.map((m) => `email:${m.id}`);
  const tasks = evidence.length
    ? await db
        .select({ id: s.tasks.id, title: s.tasks.title, status: s.tasks.status, dueAt: s.tasks.dueAt, owedBy: s.tasks.owedBy, evidenceSource: s.tasks.evidenceSource })
        .from(s.tasks)
        .where(inArray(s.tasks.evidenceSource, evidence))
        .orderBy(desc(s.tasks.createdAt))
    : [];
  const suggestedIds = messages.map((m) => (m.analysis as StoredEmailAnalysis | null)?.suggestedDealId ?? null);
  const suggested = await visibleDealNames(user, suggestedIds);
  return {
    thread: t.t,
    accountName: t.accountName,
    mailboxName: t.mailboxName,
    isOwn,
    dealName: t.t.dealId ? (dealNames.get(t.t.dealId) ?? null) : null,
    messages: messages.map((m) => ({
      id: m.id,
      fromAddr: m.fromAddr,
      toAddrs: m.toAddrs,
      ccAddrs: m.ccAddrs,
      sentAt: m.sentAt,
      direction: m.direction,
      bodyText: m.bodyText,
      analysis: (m.analysis as StoredEmailAnalysis | null) ?? null,
      analyzedAt: m.analyzedAt,
    })),
    tasks,
    suggestedDeal: [...suggested.entries()].map(([id, name]) => ({ id, name }))[0] ?? null,
  };
}
export type ThreadDetail = NonNullable<Awaited<ReturnType<typeof getThread>>>;
