import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { autonomyLevel } from "@/lib/integrations/core";
import { bumpActivity, internalDomains, loadDirectory, resolveDealForAccount } from "@/lib/integrations/directory";
import { matchParticipants, normalizeBlocklist, type Directory } from "@/lib/integrations/matching-core";
import { getPrefs } from "@/lib/integrations/store";
import { computeAwaiting, messageDirection, stripQuoted, type ParsedMessage } from "./parse";
import { recomputeDealHealth } from "@/lib/deals/service";

export type IngestContext = {
  owner: { id: string; name: string; email: string };
  ownerEmails: string[];
  directory: Directory;
  internal: string[];
  blocklist: string[];
  autonomy: Record<string, unknown>;
};

export async function loadIngestContext(userId: string): Promise<IngestContext> {
  const [u] = await db.select({ id: s.user.id, name: s.user.name, email: s.user.email }).from(s.user).where(eq(s.user.id, userId));
  if (!u) throw new Error("User not found");
  const [directory, internal, prefs, autonomy] = await Promise.all([
    loadDirectory(),
    internalDomains(u.email),
    getPrefs(userId),
    getSetting<Record<string, unknown>>("agent.autonomy", {}),
  ]);
  return {
    owner: u,
    ownerEmails: [u.email.toLowerCase()],
    directory,
    internal,
    blocklist: normalizeBlocklist(prefs.blocklist),
    autonomy,
  };
}

export type IngestResult =
  | { status: "ingested"; threadRowId: string; messageRowId: string; dealId: string | null }
  | { status: "duplicate"; threadRowId: string }
  | { status: "skipped"; reason: string };

/**
 * Relevance-filter and store one Gmail message (EML-3/4): upsert thread + message, auto-link account/contact/deal,
 * log one activity per message, bump deal/contact recency and recompute awaiting-reply.
 * `force` is used for messages sent from the CRM (always logged, optionally against an explicit deal).
 */
export async function ingestParsedMessage(
  ctx: IngestContext,
  p: ParsedMessage,
  opts: { force?: boolean; dealId?: string | null } = {},
): Promise<IngestResult> {
  const [existing] = await db
    .select()
    .from(s.emailThreads)
    .where(and(eq(s.emailThreads.mailboxUserId, ctx.owner.id), eq(s.emailThreads.gmailThreadId, p.threadId)))
    .limit(1);
  if (existing?.private) return { status: "skipped", reason: "private" };

  const participants = [p.from, ...p.to, ...p.cc].filter((x): x is string => Boolean(x));
  const match = matchParticipants(participants, ctx.directory, { internalDomains: ctx.internal, blocklist: ctx.blocklist, ownerEmail: ctx.owner.email });
  if (match.reason === "blocked") return { status: "skipped", reason: "blocked" };
  if (!existing && !match.relevant && !opts.force) return { status: "skipped", reason: match.reason };

  const sentAt = p.sentAt ?? new Date();
  const direction = messageDirection(p, ctx.ownerEmails);
  const linkLevel = autonomyLevel(ctx.autonomy, "link_email");

  // Account/deal linking. Only auto-link threads that have never been linked (manual unlinks are respected).
  let threadRow = existing ?? null;
  let accountId = existing?.accountId ?? null;
  let dealId = existing?.dealId ?? null;
  let suggestedDealId: string | null = null;
  if (opts.dealId) {
    dealId = dealId ?? opts.dealId;
    if (!accountId) {
      const [d] = await db.select({ accountId: s.deals.accountId }).from(s.deals).where(eq(s.deals.id, opts.dealId));
      accountId = d?.accountId ?? null;
    }
  }
  if (!existing || (!existing.accountId && !existing.dealId)) {
    accountId = accountId ?? match.accountId;
    if (!dealId && accountId && linkLevel >= 1) {
      const candidate = await resolveDealForAccount(accountId, ctx.owner.id);
      if (linkLevel >= 2) dealId = candidate;
      else suggestedDealId = candidate;
    }
  }

  if (!threadRow) {
    const [inserted] = await db
      .insert(s.emailThreads)
      .values({
        mailboxUserId: ctx.owner.id,
        gmailThreadId: p.threadId,
        subject: p.subject,
        snippet: p.snippet,
        participants,
        lastMessageAt: sentAt,
        dealId,
        accountId,
      })
      .onConflictDoNothing({ target: [s.emailThreads.mailboxUserId, s.emailThreads.gmailThreadId] })
      .returning();
    threadRow =
      inserted ??
      (
        await db
          .select()
          .from(s.emailThreads)
          .where(and(eq(s.emailThreads.mailboxUserId, ctx.owner.id), eq(s.emailThreads.gmailThreadId, p.threadId)))
          .limit(1)
      )[0]!;
  } else {
    const newer = !threadRow.lastMessageAt || sentAt >= threadRow.lastMessageAt;
    const [updated] = await db
      .update(s.emailThreads)
      .set({
        subject: threadRow.subject ?? p.subject,
        snippet: newer ? p.snippet : threadRow.snippet,
        participants: [...new Set([...threadRow.participants, ...participants])],
        lastMessageAt: newer ? sentAt : threadRow.lastMessageAt,
        dealId,
        accountId,
      })
      .where(eq(s.emailThreads.id, threadRow.id))
      .returning();
    threadRow = updated!;
  }

  const [msg] = await db
    .insert(s.emailMessages)
    .values({
      threadId: threadRow.id,
      gmailMessageId: p.id,
      fromAddr: p.from,
      toAddrs: p.to,
      ccAddrs: p.cc,
      sentAt,
      direction,
      bodyText: p.bodyText.slice(0, 100_000),
      analysis: suggestedDealId ? { suggestedDealId } : null,
    })
    .onConflictDoNothing({ target: [s.emailMessages.threadId, s.emailMessages.gmailMessageId] })
    .returning({ id: s.emailMessages.id });
  if (!msg) return { status: "duplicate", threadRowId: threadRow.id };

  if (autonomyLevel(ctx.autonomy, "log_activity") >= 1) {
    await db.insert(s.activities).values({
      type: "email",
      source: "gmail",
      subject: p.subject,
      body: stripQuoted(p.bodyText).slice(0, 500) || p.snippet,
      direction,
      occurredAt: sentAt,
      actorId: ctx.owner.id,
      dealId: threadRow.dealId,
      accountId: threadRow.accountId,
      contactId: match.contactIds[0] ?? null,
      emailMessageId: msg.id,
      metadata: { emailThreadId: threadRow.id, gmailThreadId: p.threadId, from: p.from, to: p.to },
    });
  }
  await bumpActivity(threadRow.dealId, match.contactIds, sentAt);
  if (threadRow.dealId) await recomputeDealHealth(threadRow.dealId);
  await refreshThreadState(threadRow.id);
  return { status: "ingested", threadRowId: threadRow.id, messageRowId: msg.id, dealId: threadRow.dealId };
}

/** Cheap pre-check on a metadata-only message: would ingestParsedMessage keep it? */
export async function wouldIngest(ctx: IngestContext, p: Pick<ParsedMessage, "threadId" | "from" | "to" | "cc">): Promise<boolean> {
  const [existing] = await db
    .select({ private: s.emailThreads.private })
    .from(s.emailThreads)
    .where(and(eq(s.emailThreads.mailboxUserId, ctx.owner.id), eq(s.emailThreads.gmailThreadId, p.threadId)))
    .limit(1);
  if (existing?.private) return false;
  const participants = [p.from, ...p.to, ...p.cc].filter((x): x is string => Boolean(x));
  const match = matchParticipants(participants, ctx.directory, { internalDomains: ctx.internal, blocklist: ctx.blocklist, ownerEmail: ctx.owner.email });
  if (match.reason === "blocked") return false;
  return Boolean(existing) || match.relevant;
}

/** Recompute awaitingReplyFrom (last message direction + OOO/not-interested intent) and the thread intent. */
export async function refreshThreadState(threadRowId: string) {
  const msgs = await db
    .select({ direction: s.emailMessages.direction, sentAt: s.emailMessages.sentAt, analysis: s.emailMessages.analysis })
    .from(s.emailMessages)
    .where(eq(s.emailMessages.threadId, threadRowId));
  const withIntent = msgs.map((m) => ({ direction: m.direction, sentAt: m.sentAt, intent: (m.analysis as { intent?: string } | null)?.intent ?? null }));
  const latest = [...withIntent].sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0))[0];
  await db
    .update(s.emailThreads)
    .set({ awaitingReplyFrom: computeAwaiting(withIntent), ...(latest?.intent ? { aiIntent: latest.intent } : {}) })
    .where(eq(s.emailThreads.id, threadRowId));
}
