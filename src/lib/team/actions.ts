"use server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { can, ForbiddenError } from "@/lib/rbac/server";
import { postTeamPostToSlack } from "@/lib/slack/deliver";
import { getTranscriptForUser } from "@/lib/transcripts/queries";
import { getVisiblePost, isLeader, isModerator, STORY_PROMPT_KIND } from "./queries";
import { aiStoryDraft, loadClosedDealForUser, loadStoryFacts } from "./stories";
import { composeStoryBody, isReaction, PLAYBOOK_TAGS, prefillStory, quoteInTranscript, reactionSummary, REACTIONS, type StoryDraft } from "./story-core";

const uuid = z.string().uuid();
const tagsSchema = z.array(z.enum(PLAYBOOK_TAGS)).max(PLAYBOOK_TAGS.length);

function revalidateTeam() {
  revalidatePath("/team");
  revalidatePath("/home");
}

/** Slack is fire-and-forget after the response; restricted posts never go to Slack (checked by callers too). */
function slackLater(postId: string) {
  after(async () => {
    try {
      await postTeamPostToSlack(postId);
    } catch {
      /* the contract says it never throws; belt and braces */
    }
  });
}

/* ═════════════════════ Win / loss stories ═════════════════════ */

const storySchema = z.object({
  dealId: uuid,
  title: z.string().trim().min(3, "Add a title").max(140),
  whatWorked: z.string().trim().max(1500).default(""),
  objection: z.string().trim().max(1000).default(""),
  timeline: z.string().trim().max(1000).default(""),
  slack: z.boolean().default(false),
});

export const postStory = action(storySchema, async (input, user) => {
  const deal = await loadClosedDealForUser(user, input.dealId);
  if (!deal) throw new UserError("Deal not found.");
  if (deal.status !== "won" && deal.status !== "lost") throw new UserError("Stories are for won or lost deals.");
  if (!deal.canPost) throw new ForbiddenError("Only the deal team can share this story.");
  const kind = deal.status === "won" ? "win" : "loss";
  const body = composeStoryBody(kind, input);
  if (!body) throw new UserError("Add at least one section — what worked, the objection, or the timeline.");

  const post = await db.transaction(async (tx) => {
    // One story per deal, even with a double submit or two teammates posting at once.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`team_story:${deal.id}`}))`);
    const [dupe] = await tx
      .select({ id: s.teamPosts.id })
      .from(s.teamPosts)
      .where(and(eq(s.teamPosts.dealId, deal.id), inArray(s.teamPosts.kind, ["win", "loss"]), isNull(s.teamPosts.deletedAt)));
    if (dupe) throw new UserError("A story for this deal was already shared.");
    const [row] = await tx
      .insert(s.teamPosts)
      .values({ kind, dealId: deal.id, authorId: user.id, title: input.title, body, restricted: deal.restricted })
      .returning({ id: s.teamPosts.id });
    await audit({ actorId: user.id, action: "team_post.create", entity: "team_post", entityId: row!.id, after: { kind, dealId: deal.id, restricted: deal.restricted } }, tx);
    return row!;
  });
  if (input.slack && !deal.restricted) slackLater(post.id);
  revalidateTeam();
  return { id: post.id, slack: input.slack && !deal.restricted };
});

/** Copilot rewrite of the story draft (facts only). Falls back to the heuristic draft. */
export const draftStoryWithAi = action(z.object({ dealId: uuid }), async ({ dealId }, user) => {
  const deal = await loadClosedDealForUser(user, dealId);
  if (!deal || (deal.status !== "won" && deal.status !== "lost")) throw new UserError("Deal not found.");
  if (!deal.canPost) throw new ForbiddenError();
  const facts = await loadStoryFacts(dealId);
  if (!facts) throw new UserError("Deal not found.");
  const heuristic = prefillStory(facts);
  // SEC M-6: MNPI never goes to the model (restricted deal or account), and the copilot.use_ai permission is honoured.
  const better = facts.restricted || !(await can(user, "copilot", "use_ai")) ? null : await aiStoryDraft(facts, heuristic, user.id);
  const result: { draft: StoryDraft; engine: string } = better ?? { draft: heuristic, engine: "heuristic" };
  // Cache for the owner's prompt so the Today item opens the improved draft next time.
  await db
    .update(s.briefs)
    .set({ content: { draft: result.draft, engine: result.engine, dealId, status: facts.status, closedAt: facts.closedAt.toISOString(), aiTried: true }, engine: result.engine })
    .where(and(eq(s.briefs.kind, STORY_PROMPT_KIND), eq(s.briefs.subjectId, dealId)));
  return { ...result, ai: Boolean(better) };
});

/* ═════════════════════ Announcements ═════════════════════ */

export const postAnnouncement = action(
  z.object({ title: z.string().trim().min(3, "Add a title").max(140), body: z.string().trim().max(4000).default(""), slack: z.boolean().default(false) }),
  async (input, user) => {
    if (!isLeader(user)) throw new ForbiddenError("Only leaders can post announcements.");
    const [row] = await db
      .insert(s.teamPosts)
      .values({ kind: "announcement", authorId: user.id, title: input.title, body: input.body || null, restricted: false })
      .returning({ id: s.teamPosts.id });
    await audit({ actorId: user.id, action: "team_post.create", entity: "team_post", entityId: row!.id, after: { kind: "announcement", title: input.title } });
    if (input.slack) slackLater(row!.id);
    revalidateTeam();
    return { id: row!.id };
  },
);

/* ═════════════════════ Reactions, playbook, delete ═════════════════════ */

export const toggleReactionAction = action(z.object({ postId: uuid, emoji: z.string().max(16) }), async ({ postId, emoji }, user) => {
  if (!isReaction(emoji)) throw new UserError("Unknown reaction.");
  const post = await getVisiblePost(user, postId);
  if (!post) throw new UserError("Post not found.");
  // Atomic toggle in SQL so concurrent reactions never overwrite each other.
  const uid = sql`to_jsonb(${user.id}::text)`;
  const key = sql`${emoji}::text`;
  const list = sql`coalesce(${s.teamPosts.reactions} -> ${key}, '[]'::jsonb)`;
  const [row] = await db
    .update(s.teamPosts)
    .set({
      reactions: sql`case
        when ${list} @> jsonb_build_array(${user.id}::text) then
          case when jsonb_array_length(${list}) <= 1 then ${s.teamPosts.reactions} - ${key}
               else jsonb_set(${s.teamPosts.reactions}, array[${emoji}]::text[], (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(${list}) e where e <> ${uid}))
          end
        else jsonb_set(${s.teamPosts.reactions}, array[${emoji}]::text[], ${list} || jsonb_build_array(${user.id}::text), true)
      end`,
    })
    .where(and(eq(s.teamPosts.id, postId), isNull(s.teamPosts.deletedAt)))
    .returning({ reactions: s.teamPosts.reactions });
  // No audit row per reaction (high-volume, low-value); the state itself is the record.
  return { reactions: reactionSummary(row?.reactions ?? {}, user.id), allowed: REACTIONS };
});

export const setPlaybook = action(z.object({ postId: uuid, inPlaybook: z.boolean(), tags: tagsSchema.default([]) }), async ({ postId, inPlaybook, tags }, user) => {
  const post = await getVisiblePost(user, postId);
  if (!post) throw new UserError("Post not found.");
  if (!isLeader(user) && post.authorId !== user.id) throw new ForbiddenError("Only leaders or the author can curate the playbook.");
  if (inPlaybook && !tags.length && !post.tags.some((t) => (PLAYBOOK_TAGS as readonly string[]).includes(t))) throw new UserError("Pick at least one tag.");
  const keep = post.tags.filter((t) => !(PLAYBOOK_TAGS as readonly string[]).includes(t)); // e.g. "review", "review:<id>"
  const nextTags = inPlaybook ? [...new Set([...keep, ...tags])] : post.tags;
  await db.update(s.teamPosts).set({ inPlaybook, tags: nextTags }).where(eq(s.teamPosts.id, postId));
  await audit({ actorId: user.id, action: inPlaybook ? "team_post.playbook_add" : "team_post.playbook_remove", entity: "team_post", entityId: postId, before: { inPlaybook: post.inPlaybook, tags: post.tags }, after: { inPlaybook, tags: nextTags } });
  revalidateTeam();
  return { ok: true };
});

export const deletePost = action(z.object({ postId: uuid }), async ({ postId }, user) => {
  const post = await getVisiblePost(user, postId);
  if (!post) throw new UserError("Post not found.");
  if (post.authorId !== user.id && !isModerator(user)) throw new ForbiddenError("Only the author or an admin can remove this post.");
  await db.update(s.teamPosts).set({ deletedAt: new Date() }).where(eq(s.teamPosts.id, postId));
  await audit({ actorId: user.id, action: "team_post.delete", entity: "team_post", entityId: postId, before: { kind: post.kind, title: post.title } });
  revalidateTeam();
  return { ok: true };
});

/* ═════════════════════ Playbook clips (from call transcripts) ═════════════════════ */

const clipSchema = z.object({
  transcriptId: uuid,
  quote: z.string().trim().min(8, "Select a longer quote").max(1200),
  at: z
    .string()
    .regex(/^\d{2}:\d{2}:\d{2}$/)
    .nullable()
    .optional(),
  speaker: z.string().trim().max(80).nullable().optional(),
  title: z.string().trim().min(3, "Add a short title").max(140),
  note: z.string().trim().max(1000).optional(),
  tags: tagsSchema.min(1, "Pick at least one tag"),
});

export const addPlaybookClip = action(clipSchema, async (input, user) => {
  const detail = await getTranscriptForUser(user, input.transcriptId);
  if (!detail) throw new UserError("Call not found.");
  const t = detail.transcript;
  if (!quoteInTranscript(input.quote, t.rawText)) throw new UserError("That quote isn't in the transcript — select the text again.");
  // MNPI: a clip inherits the restricted flag of the call's deal or account.
  const [[deal], [account]] = await Promise.all([
    t.dealId ? db.select({ restricted: s.deals.restricted }).from(s.deals).where(eq(s.deals.id, t.dealId)) : Promise.resolve([]),
    t.accountId ? db.select({ restricted: s.accounts.restricted }).from(s.accounts).where(eq(s.accounts.id, t.accountId)) : Promise.resolve([]),
  ]);
  const restricted = Boolean(deal?.restricted || account?.restricted);
  const [row] = await db
    .insert(s.teamPosts)
    .values({
      kind: "clip",
      dealId: t.dealId, // visibility of a restricted clip then follows the deal's access list
      authorId: user.id,
      title: input.title,
      body: input.note || null,
      clip: { transcriptId: t.id, quote: input.quote.replace(/\s+/g, " "), at: input.at ?? null, speaker: input.speaker ?? null },
      tags: input.tags,
      inPlaybook: true,
      restricted,
    })
    .returning({ id: s.teamPosts.id });
  await audit({ actorId: user.id, action: "team_post.clip", entity: "team_post", entityId: row!.id, after: { transcriptId: t.id, tags: input.tags, restricted } });
  revalidateTeam();
  revalidatePath(`/calls/${t.id}`);
  return { id: row!.id };
});
