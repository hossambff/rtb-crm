import "server-only";
import { mnpiSafe } from "@/lib/deals/notice";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, outsideTransaction } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { logServerError } from "@/lib/errors";
import { notifyMany } from "@/lib/notifications/notify";
import { isSensitive } from "@/lib/notifications/sensitive";
import { after } from "next/server";
import { mirrorCommentToSlack, syncCommentToSlack } from "@/lib/slack/deliver";
import { getDealForUser } from "@/lib/deals/queries";
import { dealAudience, dealAudienceRecord } from "@/lib/deals/audience";
import type { AppUser } from "@/lib/rbac/server";
import { buildThreads, countLive, newMentions, resolveMentions, type Thread } from "./core";

export type MentionUser = { id: string; name: string; image: string | null };

/** People who may be @mentioned on a deal: everyone who can view it (restricted deals: the access list + super admins). */
export async function mentionableUsers(dealId: string): Promise<MentionUser[]> {
  const rec = await dealAudienceRecord(dealId);
  if (!rec) return [];
  const users = await dealAudience(rec, "view");
  return users.map((u) => ({ id: u.id, name: u.name, image: u.image })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Live comments on a deal (tab badge). Caller has checked visibility. Never throws. */
export async function countDealComments(dealId: string): Promise<number> {
  try {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.comments)
      .where(and(eq(s.comments.entity, "deal"), eq(s.comments.entityId, dealId), isNull(s.comments.deletedAt)));
    return r?.n ?? 0;
  } catch (e) {
    logServerError("comments.count", e);
    return 0;
  }
}

/** Discussion tab bundle: threads + mention audience. Null when the caller can't see the deal. */
export async function getDealDiscussion(user: AppUser, dealId: string): Promise<{ threads: Thread[]; count: number; mentionable: MentionUser[] } | null> {
  const deal = await getDealForUser(user, dealId);
  if (!deal) return null;
  const author = alias(s.user, "author");
  const [rows, mentionable] = await Promise.all([
    db
      .select({
        id: s.comments.id,
        parentId: s.comments.parentId,
        authorId: s.comments.authorId,
        authorName: author.name,
        authorImage: author.image,
        body: s.comments.body,
        createdAt: s.comments.createdAt,
        editedAt: s.comments.editedAt,
        deletedAt: s.comments.deletedAt,
      })
      .from(s.comments)
      .leftJoin(author, eq(author.id, s.comments.authorId))
      .where(and(eq(s.comments.entity, "deal"), eq(s.comments.entityId, dealId)))
      .orderBy(asc(s.comments.createdAt))
      .limit(400),
    mentionableUsers(dealId),
  ]);
  const threads = buildThreads(
    rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), editedAt: r.editedAt?.toISOString() ?? null, deletedAt: r.deletedAt?.toISOString() ?? null })),
    user.id,
  );
  return { threads, count: countLive(threads), mentionable };
}

type DealRef = { id: string; name: string; restricted: boolean };

/** Run a Slack mirror step after the response (serverless-safe); outside a request scope, best effort. Never throws. */
function scheduleSlack(fn: () => Promise<void>) {
  const run = () => outsideTransaction(() => fn().catch((e) => logServerError("comment.slack", e)));
  try {
    after(run);
  } catch {
    void run();
  }
}
const scheduleMirror = (id: string) => scheduleSlack(() => mirrorCommentToSlack(id));

/**
 * Create a deal comment (caller has verified the user can view the deal). Mentions are limited to the deal's audience;
 * mentioned users get a `mention` notification, the parent's author a reply notification. Mirrors to Slack
 * (fire-and-forget; WS-E1's mirror never posts restricted deals to channels).
 */
export async function createDealComment(user: AppUser, deal: DealRef, input: { body: string; parentId?: string | null; mentionIds?: string[] }) {
  const body = input.body.trim();
  if (!body) throw new UserError("Write something first.");
  let parentAuthor: string | null = null;
  if (input.parentId) {
    const [p] = await db
      .select({ id: s.comments.id, entity: s.comments.entity, entityId: s.comments.entityId, parentId: s.comments.parentId, deletedAt: s.comments.deletedAt, authorId: s.comments.authorId })
      .from(s.comments)
      .where(eq(s.comments.id, input.parentId));
    if (!p || p.entity !== "deal" || p.entityId !== deal.id) throw new UserError("That comment isn't on this deal.");
    if (p.parentId) throw new UserError("Replies are one level deep — reply to the original comment.");
    if (p.deletedAt) throw new UserError("That comment was deleted.");
    parentAuthor = p.authorId;
  }
  const audience = await mentionableUsers(deal.id);
  const ids = resolveMentions(body, audience, input.mentionIds ?? []);
  const [c] = await db
    .insert(s.comments)
    .values({ entity: "deal", entityId: deal.id, authorId: user.id, body, mentions: ids, parentId: input.parentId ?? null })
    .returning({ id: s.comments.id });
  const inAudience = new Set(audience.map((a) => a.id));
  const mentioned = ids.filter((id) => id !== user.id && inAudience.has(id));
  const href = `/deals/${deal.id}?tab=discussion#c-${c!.id}`;
  // SEC L-1: a deal on a restricted account is MNPI too.
  const restricted = deal.restricted || (await isSensitive({ dealId: deal.id }));
  await notifyMany(mentioned, { kind: "mention", ...mnpiSafe(restricted, { title: `${user.name} mentioned you on ${deal.name}`, body: body.slice(0, 280) }, `${user.name} mentioned you on a restricted deal`), href });
  if (parentAuthor && parentAuthor !== user.id && !mentioned.includes(parentAuthor) && inAudience.has(parentAuthor)) {
    await notifyMany([parentAuthor], { kind: "mention", ...mnpiSafe(restricted, { title: `${user.name} replied on ${deal.name}`, body: body.slice(0, 280) }, `${user.name} replied on a restricted deal`), href });
  }
  await audit({ actorId: user.id, action: input.parentId ? "comment.reply" : "comment.create", entity: "deal", entityId: deal.id, after: { commentId: c!.id, parentId: input.parentId ?? null, mentions: ids } });
  // QA MIN-15: after() so serverless doesn't cut the mirror off once the response is sent.
  scheduleMirror(c!.id);
  return { id: c!.id, notified: mentioned.length };
}

/** Load a comment the caller authored on a deal they can still see. */
export async function loadOwnComment(user: AppUser, commentId: string) {
  const [c] = await db.select().from(s.comments).where(eq(s.comments.id, commentId));
  if (!c || c.entity !== "deal" || c.deletedAt) throw new UserError("Comment not found.");
  const deal = await getDealForUser(user, c.entityId);
  if (!deal) throw new UserError("Comment not found.");
  if (c.authorId !== user.id) throw new UserError("You can only change your own comments.");
  return { comment: c, deal: { id: deal.id, name: deal.name, restricted: deal.restricted } };
}

export async function editDealComment(user: AppUser, commentId: string, input: { body: string; mentionIds?: string[] }) {
  const { comment, deal } = await loadOwnComment(user, commentId);
  const body = input.body.trim();
  if (!body) throw new UserError("A comment can't be empty — delete it instead.");
  if (body === comment.body) return { id: comment.id, notified: 0, dealId: deal.id };
  const audience = await mentionableUsers(deal.id);
  const ids = resolveMentions(body, audience, input.mentionIds ?? []);
  await db.update(s.comments).set({ body, mentions: ids, editedAt: new Date() }).where(eq(s.comments.id, comment.id));
  const fresh = newMentions(comment.mentions ?? [], ids).filter((id) => id !== user.id);
  await notifyMany(fresh, { kind: "mention", ...mnpiSafe(deal.restricted || (await isSensitive({ dealId: deal.id })), { title: `${user.name} mentioned you on ${deal.name}`, body: body.slice(0, 280) }, `${user.name} mentioned you on a restricted deal`), href: `/deals/${deal.id}?tab=discussion#c-${comment.id}` });
  scheduleSlack(() => syncCommentToSlack(comment.id)); // SEC L-7
  await audit({ actorId: user.id, action: "comment.edit", entity: "deal", entityId: deal.id, before: { commentId: comment.id, body: comment.body }, after: { body, mentions: ids } });
  return { id: comment.id, notified: fresh.length, dealId: deal.id };
}

export async function deleteDealComment(user: AppUser, commentId: string) {
  const { comment, deal } = await loadOwnComment(user, commentId);
  await db.update(s.comments).set({ deletedAt: new Date() }).where(eq(s.comments.id, comment.id));
  scheduleSlack(() => syncCommentToSlack(comment.id)); // SEC L-7: remove the mirrored message too
  await audit({ actorId: user.id, action: "comment.delete", entity: "deal", entityId: deal.id, before: { commentId: comment.id, body: comment.body } });
  return { id: comment.id, dealId: deal.id };
}
