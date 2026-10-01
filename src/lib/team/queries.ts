import "server-only";
import { and, desc, eq, exists, ilike, inArray, isNull, lt, notExists, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealAccessWhere, type AppUser } from "@/lib/rbac/server";
import { PLAYBOOK_TAGS, reactionSummary, STORY_PROMPT_TTL_DAYS, type PlaybookTag, type PostKind, type Reaction, type StoryDraft } from "./story-core";

const DAY = 86_400_000;

/** Roles that may post announcements, curate the playbook and moderate the feed. */
export const LEADER_ROLES = ["super_admin", "admin", "executive", "sales_leader"] as const;
export const isLeader = (user: Pick<AppUser, "role">) => (LEADER_ROLES as readonly string[]).includes(user.role);
export const isModerator = (user: Pick<AppUser, "role">) => user.role === "super_admin" || user.role === "admin";

/**
 * Feed visibility (MNPI): a post is visible when it is not deleted and
 *  - it is not restricted and its deal (if any) is not restricted *now* (a deal flagged restricted later hides old posts), or
 *  - the user can see the linked deal (dealAccessWhere incl. the restricted access list), or
 *  - it is a deal-less restricted post (clip from a restricted account's call) written by the user, or
 *  - the user is a super admin.
 */
export async function postVisibleWhere(user: AppUser): Promise<SQL> {
  if (user.role === "super_admin") return isNull(s.teamPosts.deletedAt);
  const access = await dealAccessWhere(user, "view");
  return and(
    isNull(s.teamPosts.deletedAt),
    or(
      // SEC L-11: a deal whose ACCOUNT became restricted later hides its old public posts too.
      and(
        eq(s.teamPosts.restricted, false),
        notExists(
          db
            .select({ x: sql`1` })
            .from(s.deals)
            .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
            .where(and(eq(s.deals.id, s.teamPosts.dealId), or(eq(s.deals.restricted, true), eq(s.accounts.restricted, true)))),
        ),
      )!,
      exists(db.select({ x: sql`1` }).from(s.deals).where(and(eq(s.deals.id, s.teamPosts.dealId), access))),
      and(isNull(s.teamPosts.dealId), eq(s.teamPosts.authorId, user.id))!,
    )!,
  )!;
}

export type FeedPost = {
  id: string;
  kind: PostKind;
  title: string;
  body: string | null;
  tags: string[];
  inPlaybook: boolean;
  restricted: boolean;
  createdAt: string;
  author: { id: string; name: string; image: string | null } | null;
  deal: { id: string; name: string; pipelineKey: string; linkable: boolean } | null;
  clip: { transcriptId: string; quote: string; at?: string | null; speaker?: string | null } | null;
  reactions: { emoji: Reaction; count: number; mine: boolean; names: string[] }[];
  canDelete: boolean;
  canCurate: boolean;
};

type ListOpts = { kind?: PostKind | null; before?: Date | null; limit?: number; playbook?: boolean; tag?: PlaybookTag | null; q?: string | null };

/** Feed / playbook rows visible to the user, newest first. */
export async function listPosts(user: AppUser, opts: ListOpts = {}): Promise<{ posts: FeedPost[]; nextBefore: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const conds: SQL[] = [await postVisibleWhere(user)];
  if (opts.kind) conds.push(eq(s.teamPosts.kind, opts.kind));
  if (opts.before) conds.push(lt(s.teamPosts.createdAt, opts.before));
  if (opts.playbook) conds.push(eq(s.teamPosts.inPlaybook, true));
  if (opts.tag) conds.push(sql`${s.teamPosts.tags} @> array[${opts.tag}]::text[]`);
  if (opts.q?.trim()) {
    const like = `%${opts.q.trim().slice(0, 100).replace(/[%_\\]/g, "\\$&")}%`;
    conds.push(or(ilike(s.teamPosts.title, like), ilike(s.teamPosts.body, like), sql`${s.teamPosts.clip}->>'quote' ilike ${like}`)!);
  }
  const rows = await db
    .select({
      p: s.teamPosts,
      authorName: s.user.name,
      authorImage: s.user.image,
      dealName: s.deals.name,
      dealDeleted: s.deals.deletedAt,
      dealRestricted: s.deals.restricted,
      pipelineKey: s.pipelines.key,
    })
    .from(s.teamPosts)
    .leftJoin(s.user, eq(s.user.id, s.teamPosts.authorId))
    .leftJoin(s.deals, eq(s.deals.id, s.teamPosts.dealId))
    .leftJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .where(and(...conds))
    .orderBy(desc(s.teamPosts.createdAt))
    .limit(limit + 1);
  const page = rows.slice(0, limit);

  // Which linked deals can the user open? (non-restricted posts are readable by everyone; the deal link only if visible)
  const dealIds = [...new Set(page.map((r) => r.p.dealId).filter((x): x is string => Boolean(x)))];
  const visible = new Set<string>();
  if (dealIds.length) {
    const access = await dealAccessWhere(user, "view");
    const v = await db.select({ id: s.deals.id }).from(s.deals).where(and(inArray(s.deals.id, dealIds), access));
    for (const r of v) visible.add(r.id);
  }
  // Reactor names (for the hover hint) — one query for the page.
  const reactorIds = [...new Set(page.flatMap((r) => Object.values(r.p.reactions ?? {}).flat()))].slice(0, 500);
  const names = new Map<string, string>();
  if (reactorIds.length) {
    const us = await db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(inArray(s.user.id, reactorIds));
    for (const u of us) names.set(u.id, u.name);
  }
  const leader = isLeader(user);
  const posts: FeedPost[] = page.map(({ p, authorName, authorImage, dealName, dealDeleted, dealRestricted, pipelineKey }) => ({
    id: p.id,
    kind: p.kind as PostKind,
    title: p.title,
    body: p.body,
    tags: p.tags.filter((t) => !t.includes(":")),
    inPlaybook: p.inPlaybook,
    restricted: p.restricted || Boolean(dealRestricted),
    createdAt: p.createdAt.toISOString(),
    author: p.authorId ? { id: p.authorId, name: authorName ?? "Former teammate", image: authorImage ?? null } : null,
    deal: p.dealId && dealName ? { id: p.dealId, name: dealName, pipelineKey: pipelineKey ?? "", linkable: visible.has(p.dealId) && !dealDeleted } : null,
    clip: p.clip ?? null,
    reactions: reactionSummary(p.reactions, user.id).map((r) => ({
      ...r,
      names: (p.reactions[r.emoji] ?? []).map((id) => (id === user.id ? "You" : (names.get(id) ?? "Someone"))).slice(0, 8),
    })),
    canDelete: p.authorId === user.id || isModerator(user),
    canCurate: leader || p.authorId === user.id,
  }));
  return { posts, nextBefore: rows.length > limit ? page[page.length - 1]!.p.createdAt.toISOString() : null };
}

/** Load one visible post (for actions). */
export async function getVisiblePost(user: AppUser, postId: string) {
  const [row] = await db
    .select()
    .from(s.teamPosts)
    .where(and(eq(s.teamPosts.id, postId), await postVisibleWhere(user)));
  return row ?? null;
}

/** Counts for the Playbook tag chips. */
export async function playbookTagCounts(user: AppUser): Promise<Record<PlaybookTag, number> & { all: number }> {
  const where = and(await postVisibleWhere(user), eq(s.teamPosts.inPlaybook, true));
  const [r] = await db
    .select({
      all: sql<number>`count(*)::int`,
      ...Object.fromEntries(PLAYBOOK_TAGS.map((t) => [t, sql<number>`count(*) filter (where ${s.teamPosts.tags} @> array[${t}]::text[])::int`])),
    })
    .from(s.teamPosts)
    .where(where);
  return (r ?? { all: 0, objection: 0, pitch: 0, pricing: 0, coalition: 0 }) as Record<PlaybookTag, number> & { all: number };
}

/* ───────────── Story prompts ───────────── */

export const STORY_PROMPT_KIND = "story_prompt";

export type StoryPrompt = {
  dealId: string;
  dealName: string;
  status: "won" | "lost";
  pipelineKey: string;
  closedAt: string | null;
  createdAt: string;
};

/**
 * The user's open "Share the story" prompts: a prompt brief exists for them, the deal is still closed, they can see it,
 * no story was posted yet, the prompt is < 14 days old and they did not dismiss it in the Today queue.
 */
export async function pendingStoryPrompts(user: AppUser, limit = 10): Promise<StoryPrompt[]> {
  const access = await dealAccessWhere(user, "view");
  const since = new Date(Date.now() - STORY_PROMPT_TTL_DAYS * DAY);
  const rows = await db
    .select({
      dealId: s.deals.id,
      dealName: s.deals.name,
      status: s.deals.status,
      pipelineKey: s.pipelines.key,
      wonAt: s.deals.wonAt,
      lostAt: s.deals.lostAt,
      createdAt: s.briefs.createdAt,
    })
    .from(s.briefs)
    .innerJoin(s.deals, sql`${s.deals.id}::text = ${s.briefs.subjectId}`)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .where(
      and(
        eq(s.briefs.kind, STORY_PROMPT_KIND),
        eq(s.briefs.userId, user.id),
        sql`${s.briefs.createdAt} >= ${since.toISOString()}::timestamptz`,
        inArray(s.deals.status, ["won", "lost"]),
        access,
        notExists(
          db
            .select({ x: sql`1` })
            .from(s.teamPosts)
            .where(and(eq(s.teamPosts.dealId, s.deals.id), inArray(s.teamPosts.kind, ["win", "loss"]))),
        ),
        notExists(
          db
            .select({ x: sql`1` })
            .from(s.queueSnoozes)
            .where(
              and(
                eq(s.queueSnoozes.userId, user.id),
                sql`${s.queueSnoozes.itemKey} = 'story:' || ${s.deals.id}::text`,
                sql`(${s.queueSnoozes.until} is null or ${s.queueSnoozes.until} > now())`,
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(s.briefs.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    dealId: r.dealId,
    dealName: r.dealName,
    status: r.status as "won" | "lost",
    pipelineKey: r.pipelineKey,
    closedAt: (r.status === "won" ? r.wonAt : r.lostAt)?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export type StoryComposerData = {
  dealId: string;
  dealName: string;
  pipelineKey: string;
  status: "won" | "lost";
  restricted: boolean;
  draft: StoryDraft;
  engine: string;
  alreadyShared: boolean;
  canPost: boolean;
};
