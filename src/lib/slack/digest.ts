import "server-only";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { integrationConnections } from "@/db/schema";
import { overdueApprovalCount } from "@/lib/approvals/sla";
import { dayBounds, toWall } from "@/lib/alerts/time";
import { DEFAULT_TZ } from "@/lib/time";
import { channelDigestMessage } from "./blocks";
import { logSlack, slackCall } from "./client";
import { getSlackContext, getSlackRow } from "./config";

const DIGEST_HOUR = 8;

/**
 * Optional daily channel digest (C1). Call it from the 5-minute tick: it posts at most once per local day, after 08:00
 * (org time zone), claimed atomically on the Slack connection row so overlapping ticks can't double-post.
 * Contains counts and non-restricted won deal names only. Never throws.
 */
export async function postSlackChannelDigest(now: Date = new Date(), tz: string = DEFAULT_TZ): Promise<{ posted: boolean }> {
  try {
    const ctx = await getSlackContext();
    const channel = ctx?.config.digestEnabled ? ctx.config.digestChannel : null;
    if (!ctx || !channel) return { posted: false };
    const wall = toWall(now, tz);
    if (wall.getUTCHours() < DIGEST_HOUR) return { posted: false };
    const today = wall.toISOString().slice(0, 10);
    const row = await getSlackRow();
    if (!row) return { posted: false };
    const claimed = await db
      .update(integrationConnections)
      .set({ config: sql`jsonb_set(${integrationConnections.config}, '{digestLastDate}', to_jsonb(${today}::text))` })
      .where(and(eq(integrationConnections.id, row.id), sql`coalesce(${integrationConnections.config}->>'digestLastDate', '') <> ${today}`))
      .returning({ id: integrationConnections.id });
    if (!claimed.length) return { posted: false };

    const yesterday = dayBounds(new Date(now.getTime() - 86_400_000), tz);
    const [approvals, wins, created] = await Promise.all([
      overdueApprovalCount(now),
      db
        .select({ id: s.deals.id, name: s.deals.name, accountName: s.accounts.name })
        .from(s.deals)
        .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
        .where(and(eq(s.deals.restricted, false), sql`coalesce(${s.accounts.restricted}, false) = false`, sql`${s.deals.deletedAt} is null`, gte(s.deals.wonAt, yesterday.start), lt(s.deals.wonAt, yesterday.end)))
        .limit(8),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(s.deals)
        .where(and(sql`${s.deals.deletedAt} is null`, gte(s.deals.createdAt, yesterday.start), lt(s.deals.createdAt, yesterday.end))),
    ]);
    const msg = channelDigestMessage(
      {
        dateLabel: new Intl.DateTimeFormat("en-US", { weekday: "short", day: "numeric", month: "short", timeZone: tz }).format(now),
        approvalsPending: approvals.pending,
        approvalsOverdue: approvals.overdue,
        wins: wins.map((w) => ({ name: w.accountName ?? w.name, href: `/deals/${w.id}` })),
        newDeals: created[0]?.n ?? 0,
      },
      ctx.appUrl,
    );
    const res = await slackCall(ctx.token, "chat.postMessage", { channel, text: msg.text, blocks: msg.blocks, unfurl_links: false });
    if (!res.ok) logSlack("digest", res.error);
    return { posted: res.ok };
  } catch {
    logSlack("digest", "failed");
    return { posted: false };
  }
}
