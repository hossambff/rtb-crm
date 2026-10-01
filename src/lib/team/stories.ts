import "server-only";
import { aiAllowedFor } from "@/lib/gmail/ai-gate";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { aiAvailable, aiObject, modelFor, RTB_SYSTEM, untrusted } from "@/lib/ai";
import { logServerError } from "@/lib/errors";
import { dealValue } from "@/lib/pipeline-math";
import { dealAccessWhere, dealModule, inScope, scopeFor, type AppUser } from "@/lib/rbac/server";
import { activeUserWhere } from "@/lib/users";
import { prefillStory, STORY_WINDOW_DAYS, stripCitations, type StoryDraft, type StoryFacts } from "./story-core";
import { STORY_PROMPT_KIND, type StoryComposerData } from "./queries";

const DAY = 86_400_000;
const TICK_LIMIT = 10;
const TICK_AI_LIMIT = 3;
const TICK_AI_BUDGET_MS = 60_000;

type StoredPrompt = { draft: StoryDraft; engine: string; dealId: string; status: "won" | "lost"; closedAt: string | null; aiTried?: boolean };

/** Facts for a story prefill (no permission checks — callers check). Null when the deal is gone or not closed. */
export async function loadStoryFacts(dealId: string): Promise<(StoryFacts & { restricted: boolean; ownerId: string | null }) | null> {
  const [row] = await db
    .select({ d: s.deals, p: s.pipelines, accountName: s.accounts.name, accountRestricted: s.accounts.restricted, stageProb: s.stages.probability })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .where(and(eq(s.deals.id, dealId), isNull(s.deals.deletedAt)));
  if (!row || (row.d.status !== "won" && row.d.status !== "lost")) return null;
  const d = row.d;
  const closedAt = (d.status === "won" ? d.wonAt : d.lostAt) ?? d.updatedAt;
  const [history, acts, calls, contact] = await Promise.all([
    db
      .select({ name: s.stages.name, at: s.dealStageHistory.changedAt, fromId: s.dealStageHistory.fromStageId })
      .from(s.dealStageHistory)
      .innerJoin(s.stages, eq(s.stages.id, s.dealStageHistory.toStageId))
      .where(eq(s.dealStageHistory.dealId, dealId))
      .orderBy(asc(s.dealStageHistory.changedAt))
      .limit(50),
    db
      .select({ type: s.activities.type, n: sql<number>`count(*)::int` })
      .from(s.activities)
      .where(and(eq(s.activities.dealId, dealId), inArray(s.activities.type, ["email", "call", "meeting"])))
      .groupBy(s.activities.type),
    db
      .select({ analysis: s.transcripts.analysis })
      .from(s.transcripts)
      .where(and(eq(s.transcripts.dealId, dealId), eq(s.transcripts.status, "ready")))
      .orderBy(desc(sql`coalesce(${s.transcripts.occurredAt}, ${s.transcripts.createdAt})`))
      .limit(3),
    d.primaryContactId
      ? db.select({ name: s.contacts.fullName, title: s.contacts.title }).from(s.contacts).where(and(eq(s.contacts.id, d.primaryContactId), isNull(s.contacts.deletedAt)))
      : Promise.resolve([]),
  ]);
  // Path: the stage the deal started in (first history row's "from") then every stage entered.
  let startName: string | null = null;
  const firstFrom = history[0]?.fromId;
  if (firstFrom) {
    const [st] = await db.select({ name: s.stages.name }).from(s.stages).where(eq(s.stages.id, firstFrom));
    startName = st?.name ?? null;
  }
  const count = (t: string) => acts.find((a) => a.type === t)?.n ?? 0;
  const objections: StoryFacts["objections"] = [];
  for (const c of calls) {
    const list = (c.analysis as { objections?: { objection?: unknown; response_given?: unknown }[] } | null)?.objections ?? [];
    for (const o of list) {
      if (typeof o?.objection === "string" && o.objection.trim()) objections.push({ objection: o.objection, response: typeof o.response_given === "string" ? o.response_given : "" });
    }
  }
  const value = dealValue({
    unit: row.p.unit,
    muu: d.muu,
    usdPerMuu: d.usdPerMuu,
    pipelineUsdPerMuu: row.p.usdPerMuu,
    contractValueCents: d.contractValueCents,
    annualizedValueCents: d.annualizedValueCents,
    stageProbability: row.stageProb,
  });
  const c = contact[0];
  return {
    status: d.status as "won" | "lost",
    dealName: d.name,
    accountName: row.accountName ?? null,
    pipelineKey: row.p.key,
    unit: row.p.unit,
    valueUsd: value.grossUsd,
    muu: d.muu,
    createdAt: d.createdAt,
    closedAt,
    lostReason: d.lostReason,
    stagePath: [...(startName ? [startName] : []), ...history.map((h) => h.name)],
    activity: { email: count("email"), call: count("call"), meeting: count("meeting") },
    objections: objections.slice(0, 5),
    champion: c ? `${c.name}${c.title ? ` (${c.title})` : ""}` : null,
    restricted: d.restricted || Boolean(row.accountRestricted),
    ownerId: d.ownerId,
  };
}

const aiDraftSchema = z.object({
  title: z.string().describe("≤ 90 chars, e.g. 'Won TheStreet — 12.4M MUU'"),
  whatWorked: z.string().describe("1–3 sentences. For a loss: what we'd do differently."),
  objection: z.string().describe("The main objection and how it was handled (or why we couldn't), or empty"),
  timeline: z.string().describe("1–2 sentences with the cycle length and key milestones"),
});

/** AI polish of the heuristic draft (facts only). Returns null on any failure — callers keep the heuristic. */
export async function aiStoryDraft(facts: StoryFacts, heuristic: StoryDraft, userId: string | null): Promise<{ draft: StoryDraft; engine: string } | null> {
  if (!aiAvailable()) return null;
  try {
    const model = await modelFor("fast");
    const factsText = JSON.stringify(
      {
        outcome: facts.status,
        deal: facts.dealName,
        account: facts.accountName,
        motion: facts.pipelineKey,
        value: heuristic.title,
        daysToClose: Math.round((facts.closedAt.getTime() - facts.createdAt.getTime()) / DAY),
        stagePath: facts.stagePath,
        activity: facts.activity,
        champion: facts.champion,
        lostReason: facts.lostReason,
      },
      null,
      1,
    );
    const objections = facts.objections.map((o) => `- ${o.objection} → ${o.response}`).join("\n");
    const out = await aiObject({
      kind: "team_story",
      userId,
      tier: "fast",
      schema: aiDraftSchema,
      maxOutputTokens: 2000,
      system: `${RTB_SYSTEM}\nFor this output: write plain prose for teammates — no source citations, tags or labels in the text.`,
      prompt: [
        `Draft a short internal ${facts.status === "won" ? "win" : "loss"} story for the sales team feed, so other reps can reuse what worked (or avoid what didn't).`,
        "Use ONLY the facts below. Never invent names, numbers, quotes or reasons, and never mention data sources, tags or field names. Plain, warm, specific; no hype, no emoji. Leave a field empty if the facts don't support it.",
        "Facts (CRM):",
        untrusted("crm_deal", factsText, 4000),
        objections ? `Objections from call analyses:\n${untrusted("call_objections", objections, 3000)}` : "No objections recorded.",
        `Current heuristic draft (improve, keep facts):\n${untrusted("draft", JSON.stringify(heuristic), 3000)}`,
      ].join("\n\n"),
    });
    const clean = (v: string, n: number) => stripCitations(v.replace(/\s+/g, " ")).slice(0, n);
    return {
      draft: {
        kind: heuristic.kind,
        title: clean(out.title, 140) || heuristic.title,
        whatWorked: clean(out.whatWorked, 1500),
        objection: clean(out.objection, 1000),
        timeline: clean(out.timeline, 1000) || heuristic.timeline,
      },
      engine: `ai:${model}`,
    };
  } catch (e) {
    logServerError("team.story_ai", e);
    return null;
  }
}

/**
 * Tick job (docs/V2_SPEC.md §C9): for deals won/lost in the last 7 days that have no story and no prompt yet, store a
 * prefilled "Share the story" prompt for the owner (briefs kind story_prompt). The Today provider (stories.ts) turns
 * it into a queue item. Idempotent (unique brief per deal+owner, NOT EXISTS guards), bounded, never throws.
 */
export async function detectClosedDealsForStories(opts: { limit?: number; deadlineMs?: number } = {}): Promise<{ prompted: number; ai: number }> {
  const started = Date.now();
  let prompted = 0;
  let ai = 0;
  try {
    const since = new Date(Date.now() - STORY_WINDOW_DAYS * DAY).toISOString();
    const candidates = await db
      .select({ id: s.deals.id, ownerId: s.deals.ownerId, restricted: s.deals.restricted })
      .from(s.deals)
      .innerJoin(s.user, eq(s.user.id, s.deals.ownerId))
      .where(
        and(
          isNull(s.deals.deletedAt),
          isNotNull(s.deals.ownerId),
          activeUserWhere,
          or(
            and(eq(s.deals.status, "won"), gte(s.deals.wonAt, sql`${since}::timestamptz`)),
            and(eq(s.deals.status, "lost"), gte(s.deals.lostAt, sql`${since}::timestamptz`)),
          ),
          notExists(db.select({ x: sql`1` }).from(s.briefs).where(and(eq(s.briefs.kind, STORY_PROMPT_KIND), sql`${s.briefs.subjectId} = ${s.deals.id}::text`))),
          notExists(db.select({ x: sql`1` }).from(s.teamPosts).where(and(eq(s.teamPosts.dealId, s.deals.id), inArray(s.teamPosts.kind, ["win", "loss"])))),
        ),
      )
      .orderBy(desc(sql`coalesce(${s.deals.wonAt}, ${s.deals.lostAt})`))
      .limit(Math.min(opts.limit ?? TICK_LIMIT, 50));

    for (const c of candidates) {
      if (opts.deadlineMs && Date.now() > opts.deadlineMs - 5_000) break;
      try {
        const facts = await loadStoryFacts(c.id);
        if (!facts || !c.ownerId) continue;
        let draft = prefillStory(facts);
        let engine = "heuristic";
        // AI only for non-restricted deals, a few per tick, inside a small time budget.
        // …and only when the deal owner may use AI at all (copilot.use_ai).
        if (!facts.restricted && ai < TICK_AI_LIMIT && Date.now() - started < TICK_AI_BUDGET_MS && (await aiAllowedFor(c.ownerId))) {
          const better = await aiStoryDraft(facts, draft, c.ownerId);
          if (better) {
            draft = better.draft;
            engine = better.engine;
            ai++;
          }
        }
        const content: StoredPrompt = { draft, engine, dealId: c.id, status: facts.status, closedAt: facts.closedAt.toISOString(), aiTried: engine !== "heuristic" || facts.restricted };
        const inserted = await db
          .insert(s.briefs)
          .values({ kind: STORY_PROMPT_KIND, subjectId: c.id, userId: c.ownerId, periodKey: "", content: content as unknown as Record<string, unknown>, engine })
          .onConflictDoNothing()
          .returning({ id: s.briefs.id });
        if (inserted.length) prompted++;
      } catch (e) {
        logServerError("team.story_prompt", e, undefined, { dealId: c.id });
      }
    }
  } catch (e) {
    logServerError("team.detect_stories", e);
  }
  return { prompted, ai };
}

/** Who may post the story for a deal: owner, split members, or anyone with edit scope covering the deal. */
async function canPostStoryFor(user: AppUser, deal: { id: string; ownerId: string | null; teamId: string | null; pipelineKey: string }): Promise<boolean> {
  if (deal.ownerId === user.id) return true;
  const splits = await db.select({ u: s.dealSplits.userId }).from(s.dealSplits).where(eq(s.dealSplits.dealId, deal.id));
  const splitUserIds = splits.map((x) => x.u);
  if (splitUserIds.includes(user.id)) return true;
  const scope = await scopeFor(user, dealModule(deal.pipelineKey), "edit");
  return scope !== "none" && inScope(user, scope, { ownerId: deal.ownerId, teamId: deal.teamId, splitUserIds, pipelineKey: deal.pipelineKey });
}

/** Visible closed deal for story actions (dealAccessWhere incl. restricted access list). */
export async function loadClosedDealForUser(user: AppUser, dealId: string) {
  const access = await dealAccessWhere(user, "view");
  const [row] = await db
    .select({ id: s.deals.id, name: s.deals.name, status: s.deals.status, ownerId: s.deals.ownerId, teamId: s.deals.teamId, restricted: s.deals.restricted, accountRestricted: s.accounts.restricted, pipelineKey: s.pipelines.key })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .where(and(eq(s.deals.id, dealId), access));
  if (!row) return null;
  return { ...row, restricted: row.restricted || Boolean(row.accountRestricted), canPost: await canPostStoryFor(user, row) };
}

/** Composer data for /team?share=<dealId>: the stored prefill (or a fresh heuristic one) + whether a story exists. */
export async function storyComposerData(user: AppUser, dealId: string): Promise<StoryComposerData | null> {
  const deal = await loadClosedDealForUser(user, dealId);
  if (!deal || (deal.status !== "won" && deal.status !== "lost")) return null;
  const [[existing], [prompt]] = await Promise.all([
    db
      .select({ id: s.teamPosts.id })
      .from(s.teamPosts)
      .where(and(eq(s.teamPosts.dealId, dealId), inArray(s.teamPosts.kind, ["win", "loss"]), isNull(s.teamPosts.deletedAt)))
      .limit(1),
    db
      .select({ content: s.briefs.content, engine: s.briefs.engine })
      .from(s.briefs)
      .where(and(eq(s.briefs.kind, STORY_PROMPT_KIND), eq(s.briefs.subjectId, dealId)))
      .orderBy(desc(s.briefs.createdAt))
      .limit(1),
  ]);
  let draft = (prompt?.content as StoredPrompt | undefined)?.draft ?? null;
  let engine = prompt?.engine ?? "heuristic";
  // A stored draft for the other outcome (deal re-opened and closed differently) is stale.
  if (!draft || draft.kind !== (deal.status === "won" ? "win" : "loss")) {
    const facts = await loadStoryFacts(dealId);
    if (!facts) return null;
    draft = prefillStory(facts);
    engine = "heuristic";
  }
  return {
    dealId,
    dealName: deal.name,
    pipelineKey: deal.pipelineKey,
    status: deal.status as "won" | "lost",
    restricted: deal.restricted,
    draft,
    engine,
    alreadyShared: Boolean(existing),
    canPost: deal.canPost,
  };
}
