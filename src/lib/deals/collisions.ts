import "server-only";
import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { getVisibleAccount } from "@/lib/accounts/queries";
import { canSeeRestricted, dealAccessWhere, type AppUser } from "@/lib/rbac/server";
import { logServerError } from "@/lib/errors";
import { COLLISION_KINDS, mergeTouches, TOUCH_KINDS, type RecentTouch, type TouchKind, type TouchRow } from "./collisions-core";

export type { RecentTouch, TouchKind } from "./collisions-core";
export { accountNoun, collisionHeadline, describeTouch, latestPerPerson } from "./collisions-core";

/**
 * Collision warnings (V2 §C4). "Chris emailed this publisher 2 days ago" — other people's touches (activities, email
 * threads, meetings) on the same account. Exposes only WHO / WHAT KIND / WHEN: never subjects, bodies or recipients.
 *
 * Permission model:
 * - the caller must be able to see the account (scope + restricted access list) — or, for the deal page, the deal;
 * - touches attached to a restricted (MNPI) deal the caller isn't on the access list for are skipped entirely;
 * - private email threads (and activities flagged private) are skipped entirely;
 * - meetings/threads are only read from the stored rows (no live calendar/Gmail calls).
 * Never throws: a failure returns [] (it is a hint, not a gate).
 */

const DAY = 86_400_000;
const uuidRe = /^[0-9a-f-]{36}$/i;

export type TouchOptions = {
  /** Look-back window (default 14 days). */
  days?: number;
  /** Include the caller's own touches (the account timeline does; collision warnings don't). */
  includeSelf?: boolean;
  /** Upcoming meetings within this many days count too (default 14; 0 = past only). */
  aheadDays?: number;
};

/** Other users' touches on an account in the last 14 days (WS-C composer, account page). [] when the account isn't visible. */
export async function getRecentTouches(user: AppUser, accountId: string, opts: TouchOptions = {}): Promise<RecentTouch[]> {
  try {
    if (!uuidRe.test(accountId)) return [];
    const account = await getVisibleAccount(user, accountId);
    if (!account) return [];
    return await touchesForAccount(user, accountId, opts);
  } catch (e) {
    logServerError("collisions.account", e);
    return [];
  }
}

/** Same, resolved through a deal the caller can see (its account may be outside their account scope). */
export async function getRecentTouchesForDeal(
  user: AppUser,
  dealId: string,
  opts: TouchOptions & {
    /** The deal page already loaded (and access-checked) the deal + its account — skip the lookup (perf H-4). */
    known?: { accountId: string | null; accountType: string | null; accountRestricted: boolean };
  } = {},
): Promise<{ touches: RecentTouch[]; accountType: string | null }> {
  try {
    if (!uuidRe.test(dealId)) return { touches: [], accountType: null };
    const [d] = opts.known
      ? [opts.known]
      : await db
          .select({ accountId: s.deals.accountId, accountType: s.accounts.type, accountRestricted: s.accounts.restricted })
          .from(s.deals)
          .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
          .where(and(eq(s.deals.id, dealId), await dealAccessWhere(user, "view")));
    if (!d?.accountId) return { touches: [], accountType: null };
    if (d.accountRestricted && !(await canSeeRestricted(user, "account", d.accountId))) return { touches: [], accountType: null };
    return { touches: await touchesForAccount(user, d.accountId, opts), accountType: d.accountType ?? null };
  } catch (e) {
    logServerError("collisions.deal", e);
    return { touches: [], accountType: null };
  }
}

export type TimelineTouch = { id: string; userId: string; userName: string; userImage: string | null; kind: TouchKind; at: string; dealId: string | null; dealName: string | null };

/**
 * "Who's talking to them" (account page): individual touches by everyone (incl. the caller) over `days`, newest
 * first, plus deal names for deals the caller can see. Same exposure rules as getRecentTouches.
 */
export async function getAccountTouchTimeline(user: AppUser, accountId: string, opts: { days?: number; limit?: number } = {}): Promise<TimelineTouch[]> {
  try {
    if (!uuidRe.test(accountId)) return [];
    const account = await getVisibleAccount(user, accountId);
    if (!account) return [];
    const now = new Date();
    const since = new Date(now.getTime() - (opts.days ?? 90) * DAY);
    const limit = Math.min(opts.limit ?? 40, 200);
    const okDeal = await visibleDealOrNone(user, s.activities.dealId);
    const [acts, meetings, dealWhere] = await Promise.all([
      db
        .select({ id: s.activities.id, userId: s.activities.actorId, userName: s.user.name, userImage: s.user.image, kind: s.activities.type, at: s.activities.occurredAt, dealId: s.activities.dealId })
        .from(s.activities)
        .innerJoin(s.user, eq(s.user.id, s.activities.actorId))
        .where(
          and(
            eq(s.activities.accountId, accountId),
            inArray(s.activities.type, [...TOUCH_KINDS]),
            gte(s.activities.occurredAt, since),
            lte(s.activities.occurredAt, now),
            notPrivate,
            okDeal,
          ),
        )
        .orderBy(sql`${s.activities.occurredAt} desc`)
        .limit(limit),
      db
        .select({ id: s.meetings.id, userId: s.meetings.ownerId, userName: s.user.name, userImage: s.user.image, at: s.meetings.startsAt, dealId: s.meetings.dealId })
        .from(s.meetings)
        .innerJoin(s.user, eq(s.user.id, s.meetings.ownerId))
        .where(and(eq(s.meetings.accountId, accountId), gte(s.meetings.startsAt, now), lte(s.meetings.startsAt, new Date(now.getTime() + 14 * DAY)), await visibleDealOrNone(user, s.meetings.dealId)))
        .orderBy(sql`${s.meetings.startsAt} asc`)
        .limit(10),
      dealAccessWhere(user, "view"),
    ]);
    const dealIds = Array.from(new Set([...acts, ...meetings].map((r) => r.dealId).filter((x): x is string => !!x)));
    const names = dealIds.length
      ? new Map((await db.select({ id: s.deals.id, name: s.deals.name }).from(s.deals).where(and(inArray(s.deals.id, dealIds), dealWhere))).map((d) => [d.id, d.name]))
      : new Map<string, string>();
    const rows: TimelineTouch[] = [
      ...meetings.map((m) => ({ id: `meeting:${m.id}`, userId: m.userId!, userName: m.userName, userImage: m.userImage, kind: "meeting" as const, at: (m.at ?? now).toISOString(), dealId: m.dealId && names.has(m.dealId) ? m.dealId : null, dealName: m.dealId ? (names.get(m.dealId) ?? null) : null })),
      ...acts.map((a) => ({ id: `activity:${a.id}`, userId: a.userId!, userName: a.userName, userImage: a.userImage, kind: a.kind as TouchKind, at: a.at.toISOString(), dealId: a.dealId && names.has(a.dealId) ? a.dealId : null, dealName: a.dealId ? (names.get(a.dealId) ?? null) : null })),
    ];
    return rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, limit);
  } catch (e) {
    logServerError("collisions.timeline", e);
    return [];
  }
}

/* ───────────── internals ───────────── */

const notPrivate: SQL = sql`coalesce((${s.activities.metadata}->>'private')::boolean, false) = false`;

/** `dealCol` is null, or points at a live deal that is not restricted / the caller is on its access list. */
async function visibleDealOrNone(user: AppUser, dealCol: typeof s.activities.dealId | typeof s.meetings.dealId | typeof s.emailThreads.dealId): Promise<SQL> {
  if (user.role === "super_admin") return sql`true`;
  return or(
    isNull(dealCol),
    sql`exists (select 1 from rso.deals d where d.id = ${dealCol} and d.deleted_at is null and (d.restricted = false or exists (select 1 from rso.restricted_access ra where ra.entity = 'deal' and ra.entity_id = d.id and ra.user_id = ${user.id})))`,
  )!;
}

async function touchesForAccount(user: AppUser, accountId: string, opts: TouchOptions): Promise<RecentTouch[]> {
  const now = new Date();
  const since = new Date(now.getTime() - (opts.days ?? 14) * DAY);
  const ahead = new Date(now.getTime() + (opts.aheadDays ?? 14) * DAY);
  const notMe = (col: typeof s.activities.actorId | typeof s.meetings.ownerId | typeof s.emailThreads.mailboxUserId): SQL => (opts.includeSelf ? sql`true` : ne(col, user.id));
  const [okAct, okMeet, okThread] = await Promise.all([
    visibleDealOrNone(user, s.activities.dealId),
    visibleDealOrNone(user, s.meetings.dealId),
    visibleDealOrNone(user, s.emailThreads.dealId),
  ]);
  // Perf H-4: one round trip (UNION ALL) instead of three aggregate queries.
  const src = sql<string>`'activity'`.as("src");
  const all = await db
    .select({ src, userId: s.activities.actorId, userName: s.user.name, userImage: s.user.image, kind: sql<string>`${s.activities.type}::text`.as("kind"), at: sql<Date>`max(${s.activities.occurredAt})`.as("at"), count: sql<number>`count(*)::int`.as("count") })
    .from(s.activities)
    .innerJoin(s.user, eq(s.user.id, s.activities.actorId))
    .where(
      and(
        eq(s.activities.accountId, accountId),
        inArray(s.activities.type, [...COLLISION_KINDS]),
        gte(s.activities.occurredAt, since),
        lte(s.activities.occurredAt, now),
        isNotNull(s.activities.actorId),
        notMe(s.activities.actorId),
        notPrivate,
        okAct,
      ),
    )
    .groupBy(s.activities.actorId, s.user.name, s.user.image, s.activities.type)
    .unionAll(
      db
        .select({ src: sql<string>`'thread'`.as("src"), userId: s.emailThreads.mailboxUserId, userName: s.user.name, userImage: s.user.image, kind: sql<string>`'email'`.as("kind"), at: sql<Date>`max(${s.emailThreads.lastMessageAt})`.as("at"), count: sql<number>`count(*)::int`.as("count") })
        .from(s.emailThreads)
        .innerJoin(s.user, eq(s.user.id, s.emailThreads.mailboxUserId))
        .where(and(eq(s.emailThreads.accountId, accountId), eq(s.emailThreads.private, false), gte(s.emailThreads.lastMessageAt, since), lte(s.emailThreads.lastMessageAt, now), notMe(s.emailThreads.mailboxUserId), okThread))
        .groupBy(s.emailThreads.mailboxUserId, s.user.name, s.user.image),
    )
    .unionAll(
      db
        .select({ src: sql<string>`'meeting'`.as("src"), userId: s.meetings.ownerId, userName: s.user.name, userImage: s.user.image, kind: sql<string>`'meeting'`.as("kind"), at: sql<Date>`max(${s.meetings.startsAt})`.as("at"), count: sql<number>`count(*)::int`.as("count") })
        .from(s.meetings)
        .innerJoin(s.user, eq(s.user.id, s.meetings.ownerId))
        .where(and(eq(s.meetings.accountId, accountId), gte(s.meetings.startsAt, since), lte(s.meetings.startsAt, ahead), notMe(s.meetings.ownerId), okMeet))
        .groupBy(s.meetings.ownerId, s.user.name, s.user.image),
    );
  const acts = all.filter((r) => r.src === "activity");
  const threads = all.filter((r) => r.src === "thread");
  const meetings = all.filter((r) => r.src === "meeting");
  const rows: TouchRow[] = [
    ...acts.map((r) => ({ ...r, kind: r.kind })),
    // Synced threads usually also have activities; the merge keeps the latest instant per person × kind. Counts from
    // threads are not added on top of activity counts to avoid double counting the same conversation.
    ...threads.map((r) => ({ ...r, kind: "email", count: acts.some((a) => a.userId === r.userId && a.kind === "email") ? 0 : r.count })),
    ...meetings.map((r) => ({ ...r, kind: "meeting", count: acts.some((a) => a.userId === r.userId && a.kind === "meeting") ? 0 : r.count })),
  ];
  return mergeTouches(rows, { excludeUserId: opts.includeSelf ? null : user.id });
}
