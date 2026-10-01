import "server-only";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { getPrefs } from "@/lib/prefs";
import { alertsChannelMessage, commentMessage, noticeMessage, teamPostMessage, type ChannelAlert, type SlackMessage } from "./blocks";
import { logSlack, slackCall } from "./client";
import { approvalIdFromHref, approvalLookupFromHref, isUuid } from "./core";
import { getSlackContext, type SlackContext } from "./config";
import { appUserById, slackIdForUser } from "./identity";

/**
 * Slack delivery contract (docs/V2_SPEC.md §C1). Owner: WS-E1.
 * - Never throws, never blocks long: one chat.postMessage per recipient/post, 3 s timeout each, a total deadline.
 * - A no-op when Slack is not configured.
 * - MNPI: restricted deals/accounts never reach Slack (neutral text for DMs, nothing at all for channels).
 */
export type SlackNotice = {
  kind: string;
  title: string;
  body?: string | null;
  href?: string | null;
  severity?: string | null;
  /** MNPI hard guard (set by notify() for restricted subjects): never delivered to Slack. */
  sensitive?: boolean;
};

const MAX_DM_RECIPIENTS = 25;
const DM_DEADLINE_MS = 8000;

async function post(ctx: SlackContext, channel: string, msg: SlackMessage, extra: Record<string, unknown> = {}): Promise<string | null> {
  return (await postRef(ctx, channel, msg, extra))?.ts ?? null;
}

/** chat.postMessage returning the message reference: `channel` is the resolved conversation ID (a DM's D…, not the user ID). */
async function postRef(ctx: SlackContext, channel: string, msg: SlackMessage, extra: Record<string, unknown> = {}): Promise<{ channel: string; ts: string } | null> {
  const res = await slackCall<{ ts?: string; channel?: string }>(ctx.token, "chat.postMessage", {
    channel,
    text: msg.text,
    blocks: msg.blocks,
    unfurl_links: false,
    unfurl_media: false,
    ...extra,
  });
  if (!res.ok) {
    logSlack("chat.postMessage", res.error);
    return null;
  }
  return typeof res.ts === "string" ? { ts: res.ts, channel: typeof res.channel === "string" ? res.channel : channel } : null;
}

/** Is the record an in-app link points at restricted? (/deals/<id>, /accounts/<id>) — fails closed. */
async function hrefIsRestricted(href: string | null | undefined): Promise<boolean> {
  if (!href) return false;
  const m = /^\/(deals|accounts)\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(href);
  if (!m || !isUuid(m[2])) return false;
  try {
    if (m[1] === "deals") {
      const [d] = await db
        .select({ r: s.deals.restricted, ar: s.accounts.restricted })
        .from(s.deals)
        .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
        .where(eq(s.deals.id, m[2]!));
      return Boolean(d?.r || d?.ar);
    }
    const [a] = await db.select({ r: s.accounts.restricted }).from(s.accounts).where(eq(s.accounts.id, m[2]!));
    return Boolean(a?.r);
  } catch {
    return true;
  }
}

/**
 * The pending approval a notification is about: its own `approval=<id>` link, or (QA MAJ-15) for approval
 * notifications that link to the subject instead (/deals/<id>, /proposals/<id>, registrations, scout) the most recent
 * pending request of the matching kind and subject. Subject-less hrefs (registrations, scout) only resolve when exactly
 * one request of that kind was created in the last 10 minutes. Either way the card shows the approval's own
 * permission-aware label, and every click is re-checked by the approvals service.
 */
async function approvalForNotice(n: SlackNotice) {
  const directId = approvalIdFromHref(n.href);
  if (directId) return (await db.select().from(s.approvals).where(eq(s.approvals.id, directId)))[0] ?? null;
  if (n.kind !== "approval") return null;
  const look = approvalLookupFromHref(n.href);
  if (!look) return null;
  const conds = [eq(s.approvals.status, "pending"), inArray(s.approvals.kind, look.kinds)];
  if (look.entity && look.entityId) conds.push(eq(s.approvals.entity, look.entity), eq(s.approvals.entityId, look.entityId));
  else conds.push(gte(s.approvals.createdAt, new Date(Date.now() - 10 * 60_000)));
  const rows = await db.select().from(s.approvals).where(and(...conds)).orderBy(desc(s.approvals.createdAt)).limit(2);
  if (!look.entityId && rows.length !== 1) return null;
  return rows[0] ?? null;
}

/** Append a posted approval card to approvals.slack_messages (bounded). Never throws. */
async function rememberApprovalCard(approvalId: string, ref: { channel: string; ts: string }) {
  try {
    await db
      .update(s.approvals)
      .set({ slackMessages: sql`(case when jsonb_array_length(${s.approvals.slackMessages}) < 50 then ${s.approvals.slackMessages} || ${JSON.stringify([ref])}::jsonb else ${s.approvals.slackMessages} end)` })
      .where(eq(s.approvals.id, approvalId));
  } catch {
    logSlack("approval_card", "remember_failed");
  }
}

/**
 * DM each user who turned on Slack DMs and has (or can be auto-mapped to) a verified Slack member ID. Called by notify()
 * for interrupting notifications (the alert budget is applied upstream). Approval notifications become interactive
 * Approve / Reject messages for users who may decide them. Every recipient is re-validated with the session-equivalent
 * loader (SEC L-2: banned / expired / removed-domain users get nothing).
 * Returns the user IDs that were actually delivered to (so callers can record deliveredVia "slack").
 */
export async function deliverToSlack(userIds: string[], n: SlackNotice): Promise<{ delivered: string[] }> {
  const delivered: string[] = [];
  if (n.sensitive) return { delivered };
  try {
    const ctx = await getSlackContext();
    if (!ctx || !userIds.length) return { delivered };
    const deadline = Date.now() + DM_DEADLINE_MS;
    const approval = await approvalForNotice(n).catch(() => null);
    const restricted = approval ? false : await hrefIsRestricted(n.href);
    for (const userId of Array.from(new Set(userIds)).slice(0, MAX_DM_RECIPIENTS)) {
      if (Date.now() > deadline) break;
      try {
        const prefs = await getPrefs(userId);
        if (!prefs.slackDm) continue;
        const user = await appUserById(userId);
        if (!user) continue;
        const slackId = await slackIdForUser(userId, ctx.token);
        if (!slackId) continue;
        let msg: SlackMessage | null = null;
        let card = false;
        if (approval) {
          // Lazy: notify() → deliverToSlack → approvals service → notify() would otherwise be an import cycle.
          const { approvalMessageFor } = await import("./approvals");
          msg = await approvalMessageFor(user, approval, ctx.appUrl);
          card = Boolean(msg);
          // Not a decider: a direct approval link gets a neutral pointer; a subject link falls back to the plain notice
          // (restricted subjects never get here — notify() drops sensitive rows before Slack).
          if (!msg)
            msg = approvalIdFromHref(n.href)
              ? noticeMessage({ kind: n.kind, title: "New approval request — open in Roundtable", href: n.href }, ctx.appUrl)
              : (await hrefIsRestricted(n.href))
                ? noticeMessage({ kind: n.kind, title: "New notification about a restricted record", body: "Details stay in Roundtable.", href: n.href }, ctx.appUrl)
                : noticeMessage(n, ctx.appUrl);
        } else if (restricted) {
          msg = noticeMessage({ kind: n.kind, title: "New notification about a restricted record", body: "Details stay in Roundtable.", href: n.href, severity: n.severity }, ctx.appUrl);
        } else {
          msg = noticeMessage(n, ctx.appUrl);
        }
        const ref = await postRef(ctx, slackId, msg);
        if (ref) {
          delivered.push(userId);
          // Remember approval cards so a decision made elsewhere can update them (stale-button fix).
          if (card && approval) await rememberApprovalCard(approval.id, ref);
        }
      } catch {
        logSlack("deliver", "recipient_failed");
      }
    }
  } catch {
    logSlack("deliver", "failed");
  }
  return { delivered };
}

/** Mirror a new deal comment to the pipeline's deal channel (threaded under its parent when the parent was mirrored). */
export async function mirrorCommentToSlack(commentId: string): Promise<void> {
  try {
    if (!isUuid(commentId)) return;
    const ctx = await getSlackContext();
    if (!ctx) return;
    const [c] = await db.select().from(s.comments).where(eq(s.comments.id, commentId));
    if (!c || c.entity !== "deal" || c.deletedAt || c.slackTs) return;
    const [d] = await db
      .select({ name: s.deals.name, restricted: s.deals.restricted, accountRestricted: s.accounts.restricted, deletedAt: s.deals.deletedAt, pipelineKey: s.pipelines.key })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
      .where(eq(s.deals.id, c.entityId));
    if (!d || d.restricted || d.accountRestricted || d.deletedAt) return;
    const channel = ctx.config.dealChannels?.[d.pipelineKey];
    if (!channel) return;
    let threadTs: string | undefined;
    if (c.parentId) {
      const [parent] = await db.select({ ts: s.comments.slackTs }).from(s.comments).where(eq(s.comments.id, c.parentId));
      threadTs = parent?.ts ?? undefined;
    }
    const author = c.authorId ? (await db.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, c.authorId)))[0]?.name : null;
    const msg = commentMessage({ authorName: author ?? null, dealName: d.name, body: c.body, href: `/deals/${c.entityId}`, restricted: d.restricted }, ctx.appUrl);
    if (!msg) return;
    const ts = await post(ctx, channel, msg, threadTs ? { thread_ts: threadTs } : {});
    if (ts) await db.update(s.comments).set({ slackTs: ts }).where(eq(s.comments.id, c.id));
  } catch {
    logSlack("mirrorComment", "failed");
  }
}

/**
 * SEC L-7: propagate an edited or deleted deal comment to its mirrored Slack message (chat.update / chat.delete). If the
 * deal became restricted since, the message is deleted. Never throws; a no-op when the comment was never mirrored.
 */
export async function syncCommentToSlack(commentId: string): Promise<void> {
  try {
    if (!isUuid(commentId)) return;
    const ctx = await getSlackContext();
    if (!ctx) return;
    const [c] = await db.select().from(s.comments).where(eq(s.comments.id, commentId));
    if (!c || c.entity !== "deal" || !c.slackTs) return;
    const [d] = await db
      .select({ name: s.deals.name, restricted: s.deals.restricted, accountRestricted: s.accounts.restricted, deletedAt: s.deals.deletedAt, pipelineKey: s.pipelines.key })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
      .where(eq(s.deals.id, c.entityId));
    const channel = d ? ctx.config.dealChannels?.[d.pipelineKey] : undefined;
    if (!channel) return;
    // chat.update / chat.delete need the channel ID: this works when the deal channel is configured by ID (C0123ABCD);
    // with a "#name" Slack answers channel_not_found, which is logged and ignored (the in-app comment is authoritative).
    if (c.deletedAt || !d || d.restricted || d.accountRestricted || d.deletedAt) {
      const r = await slackCall(ctx.token, "chat.delete", { channel, ts: c.slackTs });
      if (!r.ok) logSlack("chat.delete", r.error);
      else await db.update(s.comments).set({ slackTs: null }).where(eq(s.comments.id, c.id));
      return;
    }
    const author = c.authorId ? (await db.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, c.authorId)))[0]?.name : null;
    const msg = commentMessage({ authorName: author ?? null, dealName: d.name, body: c.body, href: `/deals/${c.entityId}`, restricted: false }, ctx.appUrl);
    if (!msg) return;
    const r = await slackCall(ctx.token, "chat.update", { channel, ts: c.slackTs, text: msg.text, blocks: msg.blocks });
    if (!r.ok) logSlack("chat.update", r.error);
  } catch {
    logSlack("syncComment", "failed");
  }
}

/**
 * Post a team-feed item (win / loss / announcement / review recap) to the configured wins channel. Restricted posts
 * never leave: the post's own flag, its deal's flag and the deal's account flag are re-read right before posting (a deal
 * can become restricted after the story was written); a missing/deleted deal fails closed.
 */
export async function postTeamPostToSlack(postId: string): Promise<void> {
  try {
    if (!isUuid(postId)) return;
    const ctx = await getSlackContext();
    const channel = ctx?.config.winsChannel;
    if (!ctx || !channel) return;
    const author = async (id: string | null) => (id ? ((await db.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, id)))[0]?.name ?? null) : null);
    const [p] = await db.select().from(s.teamPosts).where(eq(s.teamPosts.id, postId));
    if (!p || p.deletedAt || p.restricted) return;
    const authorName = await author(p.authorId);
    if (p.dealId) {
      const [d] = await db
        .select({ r: s.deals.restricted, ar: s.accounts.restricted, deletedAt: s.deals.deletedAt })
        .from(s.deals)
        .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
        .where(eq(s.deals.id, p.dealId));
      if (!d || d.r || d.ar || d.deletedAt) return;
    }
    const msg = teamPostMessage({ kind: p.kind, title: p.title, body: p.body, authorName, href: "/team", restricted: p.restricted, tags: p.tags }, ctx.appUrl);
    if (msg) await post(ctx, channel, msg);
  } catch {
    logSlack("postTeamPost", "failed");
  }
}

/**
 * Post new critical alerts to the configured alerts channel (QA MAJ-16), once per alert subject (escalated copies and
 * multi-recipient alerts collapse). MNPI: alerts whose deal/account is restricted (or can't be resolved) are dropped.
 * Never throws; a no-op when Slack or the channel isn't configured.
 */
export async function postCriticalAlertsToChannel(alerts: { ruleCode: string; entity: string; entityId: string; title: string; severity: string; href: string | null }[]): Promise<number> {
  try {
    const critical = alerts.filter((a) => a.severity === "critical");
    if (!critical.length) return 0;
    const ctx = await getSlackContext();
    const channel = ctx?.config.alertsChannel;
    if (!ctx || !channel) return 0;
    const { isSensitiveEntity } = await import("@/lib/notifications/sensitive");
    const seen = new Set<string>();
    const out: ChannelAlert[] = [];
    for (const a of critical) {
      const key = `${a.ruleCode}|${a.entity}|${a.entityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (await isSensitiveEntity(a.entity, a.entityId)) continue;
      out.push({ title: a.title, href: a.href, ruleCode: a.ruleCode });
    }
    const msg = alertsChannelMessage(out, ctx.appUrl);
    if (!msg) return 0;
    return (await post(ctx, channel, msg)) ? out.length : 0;
  } catch {
    logSlack("alertsChannel", "failed");
    return 0;
  }
}
