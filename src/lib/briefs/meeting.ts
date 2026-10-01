import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { aiAvailable, aiObject, modelFor, untrusted } from "@/lib/ai";
import { notify } from "@/lib/notifications/notify";
import { getPrefs } from "@/lib/prefs";
import { can, canSeeRestricted, loadAppUserById, type AppUser } from "@/lib/rbac/server";
import { contactVisibilityWhere } from "@/lib/contacts/queries";
import { isSensitive } from "@/lib/notifications/sensitive";
import { getAccessibleDeal } from "@/lib/integrations/deal-access";
import { internalDomains, loadDirectory, resolveDealForAccount } from "@/lib/integrations/directory";
import { isInternal, matchParticipants, normalizeEmail } from "@/lib/integrations/matching-core";
import { dayBounds, formatInTz, safeTz } from "@/lib/time";
import {
  aiBriefSchema,
  briefEligibility,
  briefHref,
  briefMayUseAi,
  briefNotificationTitle,
  briefPrompt,
  briefToText,
  buildHeuristicBrief,
  isSkippedMarker,
  isStale,
  mergeAiBrief,
  skippedMarker,
  type BriefSkipReason,
  type BriefInput,
  type MeetingBrief,
} from "./meeting-core";

/**
 * Auto meeting briefs (docs/V2_SPEC.md §A5). Owner: WS-C.
 * - prepareUpcomingMeetingBriefs: the 5-minute tick. Meetings starting within `withinMin` with external attendees →
 *   build (or refresh a stale) brief → briefs(kind meeting) + meetings.prep_brief → notify the owner ONCE.
 * - prepareDayBriefs: the morning email/calendar sync builds the day's briefs ahead of time (no notification).
 * Everything is computed from stored meetings (calendar sync frequency is limited) and as the meeting owner: deals and
 * restricted accounts the owner can't see never enter the brief. Idempotent; never throws.
 */

type MeetingRow = typeof s.meetings.$inferSelect;
const KIND = "meeting";

/* ───────────────────────────── Gathering (permission-checked, as the owner) ───────────────────────────── */

async function resolveLinks(owner: AppUser, m: MeetingRow): Promise<{ accountId: string | null; dealId: string | null }> {
  let accountId = m.accountId;
  let dealId = m.dealId;
  if (!accountId && m.attendees.length) {
    // "linkable": match attendee domains/contacts like the calendar sync does, and remember the link.
    const internal = await internalDomains(owner.email);
    const match = matchParticipants(m.attendees, await loadDirectory(), { internalDomains: internal, blocklist: [], ownerEmail: owner.email });
    accountId = match.accountId;
    if (accountId) {
      dealId = dealId ?? (await resolveDealForAccount(accountId, owner.id));
      await db
        .update(s.meetings)
        .set({ accountId: sql`coalesce(${s.meetings.accountId}, ${accountId}::uuid)`, dealId: sql`coalesce(${s.meetings.dealId}, ${dealId}::uuid)` })
        .where(eq(s.meetings.id, m.id));
    }
  }
  return { accountId, dealId };
}

type Gathered = { input: BriefInput; skip: null } | { input: null; skip: BriefSkipReason };

async function gather(owner: AppUser, m: MeetingRow, now: Date, opts: { requireLink: boolean }): Promise<Gathered> {
  const internal = await internalDomains(owner.email);
  const external = [...new Set(m.attendees.map((a) => normalizeEmail(a)).filter((e): e is string => Boolean(e)))].filter((e) => !isInternal(e, internal));
  if (!external.length) return { input: null, skip: "internal" }; // internal-only meetings get no brief

  const links = await resolveLinks(owner, m);
  let account: BriefInput["account"] = null;
  if (links.accountId) {
    const [a] = await db
      .select({ id: s.accounts.id, name: s.accounts.name, restricted: s.accounts.restricted })
      .from(s.accounts)
      .where(and(eq(s.accounts.id, links.accountId), isNull(s.accounts.deletedAt)));
    if (a && (!a.restricted || (await canSeeRestricted(owner, "account", a.id)))) account = { id: a.id, name: a.name };
  }

  // Deal facts only when the owner can view the deal (scope + restricted access list).
  let deal: BriefInput["deal"] = null;
  const visible = links.dealId ? await getAccessibleDeal(owner, links.dealId, "view") : null;
  if (visible) {
    const [d] = await db
      .select({ deal: s.deals, stageName: s.stages.name, slaDays: s.stages.slaDays })
      .from(s.deals)
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
      .where(eq(s.deals.id, visible.id));
    if (d) {
      deal = {
        id: d.deal.id,
        name: d.deal.name,
        stage: d.stageName,
        status: d.deal.status,
        nextStep: d.deal.nextStep,
        nextStepDueAt: d.deal.nextStepDueAt?.toISOString() ?? null,
        expectedCloseDate: d.deal.expectedCloseDate?.toISOString() ?? null,
        health: d.deal.healthScore,
        daysInStage: Math.floor((now.getTime() - d.deal.stageEnteredAt.getTime()) / 86_400_000),
        stageSlaDays: d.slaDays,
        lastActivityAt: d.deal.lastActivityAt?.toISOString() ?? null,
      };
    }
  }

  // QA MAJ-14: no automatic brief (or "Brief ready" ping) for vendors / recruiters / personal invites with no CRM link
  const skip = briefEligibility({ externalAttendees: external.length, accountId: account?.id ?? null, dealVisible: Boolean(deal) });
  if (skip && opts.requireLink) return { input: null, skip };

  // Attendees with titles and last touch — only contacts the OWNER can see (SEC L-10: restricted accounts, scope)
  const contacts = external.length
    ? await db
        .select({ email: s.contacts.email, fullName: s.contacts.fullName, title: s.contacts.title, lastContactedAt: s.contacts.lastContactedAt })
        .from(s.contacts)
        .where(and(inArray(s.contacts.email, external), isNull(s.contacts.deletedAt), await contactVisibilityWhere(owner)))
    : [];
  const byEmail = new Map(contacts.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c]));
  const attendees = external.slice(0, 12).map((email) => {
    const c = byEmail.get(email);
    return { email, name: c?.fullName ?? null, title: c?.title ?? null, lastTouch: c?.lastContactedAt?.toISOString() ?? null, known: Boolean(c) };
  });

  // Open commitments both ways on the deal (or the account when no visible deal).
  const scopeCond = deal ? eq(s.tasks.dealId, deal.id) : account ? and(eq(s.tasks.accountId, account.id), isNull(s.tasks.dealId)) : null;
  const tasks = scopeCond
    ? await db
        .select({ title: s.tasks.title, dueAt: s.tasks.dueAt, owedBy: s.tasks.owedBy })
        .from(s.tasks)
        .where(and(scopeCond, eq(s.tasks.status, "open")))
        .orderBy(sql`${s.tasks.dueAt} asc nulls last`)
        .limit(12)
    : [];
  const toTask = (t: (typeof tasks)[number]) => ({ title: t.title, due: t.dueAt?.toISOString() ?? null, overdue: Boolean(t.dueAt && t.dueAt.getTime() < now.getTime()) });
  const ours = tasks.filter((t) => t.owedBy !== "them").slice(0, 5).map(toTask);
  const theirs = tasks.filter((t) => t.owedBy === "them").slice(0, 5).map(toTask);

  // Last analyzed call on the visible deal (or the owner's own calls with the account).
  const callCond = deal ? eq(s.transcripts.dealId, deal.id) : account ? and(eq(s.transcripts.accountId, account.id), eq(s.transcripts.uploadedBy, owner.id)) : null;
  let lastCall: BriefInput["lastCall"] = null;
  if (callCond) {
    const [c] = await db
      .select({ id: s.transcripts.id, title: s.transcripts.title, occurredAt: s.transcripts.occurredAt, createdAt: s.transcripts.createdAt, analysis: s.transcripts.analysis })
      .from(s.transcripts)
      .where(and(callCond, eq(s.transcripts.status, "ready"), isNotNull(s.transcripts.analysis)))
      .orderBy(desc(sql`coalesce(${s.transcripts.occurredAt}, ${s.transcripts.createdAt})`))
      .limit(1);
    if (c) {
      const a = (c.analysis ?? {}) as { summary?: unknown; risks?: unknown; objections?: unknown };
      const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      const objections = Array.isArray(a.objections) ? a.objections.map((o) => (o as { objection?: unknown })?.objection).filter((x): x is string => typeof x === "string") : [];
      lastCall = { id: c.id, title: c.title, at: (c.occurredAt ?? c.createdAt).toISOString(), highlights: strs(a.summary).slice(0, 3), risks: strs(a.risks).slice(0, 3), objections: objections.slice(0, 2) };
    }
  }

  return {
    skip: null,
    input: {
      meeting: { id: m.id, title: m.title, startsAt: m.startsAt?.toISOString() ?? null, endsAt: m.endsAt?.toISOString() ?? null },
      account,
      deal,
      attendees,
      ours,
      theirs,
      lastCall,
      now,
    },
  };
}

/**
 * Deterministic brief + optional AI talking points (fast tier, logged to agent_runs, falls back silently).
 * SEC M-6: AI only when the owner has copilot.use_ai and the deal/account isn't restricted — MNPI never goes to the
 * model; restricted meetings get the heuristic brief.
 */
async function compose(owner: AppUser, input: BriefInput, useAi: boolean): Promise<MeetingBrief> {
  const base = buildHeuristicBrief(input);
  if (!useAi || !aiAvailable() || !(base.deal || base.lastCall || base.account)) return base;
  const [userMayUseAi, sensitive] = await Promise.all([can(owner, "copilot", "use_ai"), isSensitive({ dealId: input.deal?.id ?? null, accountId: input.account?.id ?? null })]);
  if (!briefMayUseAi({ requested: useAi, aiAvailable: true, userMayUseAi, sensitive })) return base;
  try {
    const model = await modelFor("fast");
    const ai = await aiObject({ kind: "meeting_prep", userId: owner.id, tier: "fast", schema: aiBriefSchema, prompt: briefPrompt(base, (l, t) => untrusted(l, t, 6_000)), maxOutputTokens: 1_200 });
    return mergeAiBrief(base, ai, model);
  } catch {
    return base;
  }
}

async function store(owner: AppUser, m: MeetingRow, brief: MeetingBrief): Promise<void> {
  await db
    .insert(s.briefs)
    .values({ kind: KIND, subjectId: m.id, userId: owner.id, periodKey: "", content: brief as unknown as Record<string, unknown>, engine: brief.engine })
    .onConflictDoUpdate({ target: [s.briefs.kind, s.briefs.subjectId, s.briefs.userId, s.briefs.periodKey], set: { content: brief as unknown as Record<string, unknown>, engine: brief.engine } });
  const tz = safeTz(owner.timezone);
  await db.update(s.meetings).set({ prepBrief: briefToText(brief, (iso) => formatInTz(iso, tz, "date")) }).where(eq(s.meetings.id, m.id));
}

/**
 * Build + store a brief for one meeting as its owner. `skip` says why there is none: "internal" (no external
 * attendees) or — for automatic runs (`requireLink`) — "unlinked" (no account/deal link).
 */
export async function buildMeetingBrief(
  m: MeetingRow,
  owner: AppUser,
  opts: { useAi?: boolean; now?: Date; requireLink?: boolean } = {},
): Promise<{ brief: MeetingBrief; skip: null } | { brief: null; skip: BriefSkipReason }> {
  const g = await gather(owner, m, opts.now ?? new Date(), { requireLink: opts.requireLink ?? false });
  if (!g.input) return { brief: null, skip: g.skip };
  const brief = await compose(owner, g.input, opts.useAi ?? true);
  await store(owner, m, brief);
  return { brief, skip: null };
}

/** Remember that the tick skipped this meeting (internal / unlinked) so it never fills the tick window again. */
async function markSkipped(m: MeetingRow, ownerId: string, reason: BriefSkipReason, now: Date): Promise<void> {
  await db
    .insert(s.briefs)
    .values({ kind: KIND, subjectId: m.id, userId: ownerId, periodKey: "", content: skippedMarker(reason, now), engine: "skipped", deliveredAt: now })
    .onConflictDoUpdate({ target: [s.briefs.kind, s.briefs.subjectId, s.briefs.userId, s.briefs.periodKey], set: { deliveredAt: sql`coalesce(${s.briefs.deliveredAt}, now())` } });
}

export async function getStoredBrief(meetingId: string, ownerId: string): Promise<{ content: MeetingBrief; deliveredAt: Date | null } | null> {
  const [b] = await db
    .select({ content: s.briefs.content, deliveredAt: s.briefs.deliveredAt })
    .from(s.briefs)
    .where(and(eq(s.briefs.kind, KIND), eq(s.briefs.subjectId, meetingId), eq(s.briefs.userId, ownerId), eq(s.briefs.periodKey, "")));
  if (!b || isSkippedMarker(b.content)) return null; // a skip marker is not a brief
  return { content: b.content as unknown as MeetingBrief, deliveredAt: b.deliveredAt };
}

/**
 * SQL pre-filter for automatic briefs (CR M7 / QA MAJ-11): meetings whose owner has meeting briefs on, with at least one
 * attendee outside the internal domains, that are linked or linkable to an account/deal. Uses meetings(starts_at) and
 * the GIN index on attendees; skipped meetings that slip through get a marker row and are never re-selected.
 */
function autoBriefCandidateWhere(internalList: string[]) {
  const internal = internalList.length ? sql`array[${sql.join(internalList.map((d) => sql`${d}`), sql`, `)}]` : sql`array[]`;
  const domains = sql`array(select split_part(x, '@', 2) from unnest(${s.meetings.attendees}) x)`;
  return and(
    isNotNull(s.meetings.ownerId),
    sql`cardinality(${s.meetings.attendees}) > 0`,
    sql`not exists (select 1 from ${s.userPrefs} p where p.user_id = ${s.meetings.ownerId} and p.autopilot->>'meetingBriefs' = 'false')`,
    sql`exists (select 1 from unnest(${s.meetings.attendees}) a
                where split_part(a, '@', 2) <> all(${internal}::text[])
                  and split_part(a, '@', 2) <> coalesce((select split_part(lower(u.email), '@', 2) from ${s.user} u where u.id = ${s.meetings.ownerId}), ''))`,
    sql`(${s.meetings.accountId} is not null or ${s.meetings.dealId} is not null
         or exists (select 1 from ${s.contacts} c where c.email = any(${s.meetings.attendees}) and c.deleted_at is null)
         or exists (select 1 from ${s.accounts} ac where ac.deleted_at is null and (ac.domain = any(${domains}) or ac.alt_domains && ${domains})))`,
  )!;
}

/* ───────────────────────────── Jobs ───────────────────────────── */

const MAX_PER_TICK = 25;

/** Auto meeting briefs contract (docs/V2_SPEC.md §A5). Called by the 5-minute tick. Must never throw. */
export async function prepareUpcomingMeetingBriefs(opts: { withinMin: number; deadlineMs: number }): Promise<{ prepared: number; delivered: number }> {
  let prepared = 0;
  let delivered = 0;
  try {
    const now = new Date();
    const until = new Date(now.getTime() + Math.max(5, opts.withinMin) * 60_000);
    const internal = await internalDomains(null);
    // Meetings about to start whose brief hasn't been delivered to the owner yet (one indexed scan, bounded).
    const due = await db
      .select({ m: s.meetings })
      .from(s.meetings)
      .leftJoin(
        s.briefs,
        and(eq(s.briefs.kind, KIND), eq(s.briefs.subjectId, sql`${s.meetings.id}::text`), eq(s.briefs.userId, s.meetings.ownerId), eq(s.briefs.periodKey, "")),
      )
      .where(and(gte(s.meetings.startsAt, now), lte(s.meetings.startsAt, until), isNull(s.briefs.deliveredAt), autoBriefCandidateWhere(internal)))
      .orderBy(s.meetings.startsAt)
      .limit(MAX_PER_TICK);

    const owners = new Map<string, AppUser | null>();
    for (const { m } of due) {
      if (Date.now() > opts.deadlineMs - 10_000) break;
      try {
        const ownerId = m.ownerId!;
        if (!owners.has(ownerId)) owners.set(ownerId, await loadAppUserById(ownerId));
        const owner = owners.get(ownerId);
        if (!owner) {
          await markSkipped(m, ownerId, "off", now); // inactive owner: never re-select this meeting
          continue;
        }
        if ((await getPrefs(owner.id)).autopilot.meetingBriefs === false) continue; // filtered in SQL; belt and braces

        const existing = await getStoredBrief(m.id, owner.id);
        let brief = existing?.content ?? null;
        if (!brief || isStale(brief, now)) {
          const built = await buildMeetingBrief(m, owner, { now, requireLink: true });
          if (!built.brief) {
            await markSkipped(m, owner.id, built.skip, now);
            continue;
          }
          brief = built.brief;
          prepared++;
        }
        // Deliver once: only the runner that flips deliveredAt notifies (overlapping ticks are safe).
        const [claimed] = await db
          .update(s.briefs)
          .set({ deliveredAt: new Date() })
          .where(and(eq(s.briefs.kind, KIND), eq(s.briefs.subjectId, m.id), eq(s.briefs.userId, owner.id), eq(s.briefs.periodKey, ""), isNull(s.briefs.deliveredAt)))
          .returning({ id: s.briefs.id });
        if (!claimed) continue;
        await notify(owner.id, {
          kind: "system",
          title: briefNotificationTitle(brief.account?.name ?? m.title, m.startsAt ?? now, new Date()),
          body: brief.talkingPoints[0] ?? null,
          href: briefHref(m.id),
          sensitive: await isSensitive({ dealId: m.dealId ?? brief.deal?.id, accountId: m.accountId ?? brief.account?.id }),
        });
        delivered++;
      } catch (e) {
        console.error("[briefs] meeting brief failed", (e as Error).message?.split("\nparams:")[0]?.slice(0, 200));
      }
    }
  } catch (e) {
    console.error("[briefs] tick failed", (e as Error).message?.split("\nparams:")[0]?.slice(0, 200));
  }
  return { prepared, delivered };
}

/**
 * Morning sync: build briefs for the rest of the user's day (in their time zone) that don't have one yet. No
 * notification here — the tick notifies ~45 min before each meeting (refreshing stale content first). Never throws.
 */
export async function prepareDayBriefs(userId: string, opts: { limit?: number; now?: Date; deadlineMs?: number } = {}): Promise<number> {
  try {
    const owner = await loadAppUserById(userId);
    if (!owner) return 0;
    if ((await getPrefs(owner.id)).autopilot.meetingBriefs === false) return 0;
    const now = opts.now ?? new Date();
    const { end } = dayBounds(now, safeTz(owner.timezone));
    const internal = await internalDomains(owner.email);
    const rows = await db
      .select({ m: s.meetings })
      .from(s.meetings)
      .leftJoin(s.briefs, and(eq(s.briefs.kind, KIND), eq(s.briefs.subjectId, sql`${s.meetings.id}::text`), eq(s.briefs.userId, s.meetings.ownerId), eq(s.briefs.periodKey, "")))
      .where(and(eq(s.meetings.ownerId, owner.id), gte(s.meetings.startsAt, now), lte(s.meetings.startsAt, end), isNull(s.briefs.id), autoBriefCandidateWhere(internal)))
      .orderBy(s.meetings.startsAt)
      .limit(opts.limit ?? 8);
    let n = 0;
    for (const { m } of rows) {
      // CR L3: respect the caller's time budget (the sync cron has many mailboxes to get through)
      if (opts.deadlineMs && Date.now() > opts.deadlineMs) break;
      try {
        const built = await buildMeetingBrief(m, owner, { now, requireLink: true });
        if (built.brief) n++;
        else await markSkipped(m, owner.id, built.skip, now);
      } catch (e) {
        console.error("[briefs] day brief failed", (e as Error).message?.split("\nparams:")[0]?.slice(0, 200));
      }
    }
    return n;
  } catch {
    return 0;
  }
}

/* ───────────────────────────── Page helpers ───────────────────────────── */

/** The meeting + its brief for the brief page. Only the meeting owner sees it (briefs are personal prep). */
export async function getMeetingBriefForUser(user: AppUser, meetingId: string) {
  const [m] = await db.select().from(s.meetings).where(eq(s.meetings.id, meetingId));
  if (!m || m.ownerId !== user.id) return null;
  const [stored, internal] = await Promise.all([getStoredBrief(m.id, user.id), internalDomains(user.email)]);
  // internal-only meetings have nothing to brief (QA MIN-24): the page says so instead of offering a failing action
  const external = m.attendees.some((a) => {
    const e = normalizeEmail(a);
    return Boolean(e && !isInternal(e, internal));
  });
  return { meeting: m, brief: stored?.content ?? null, deliveredAt: stored?.deliveredAt ?? null, upcoming: Boolean(m.startsAt && m.startsAt.getTime() > Date.now()), external };
}

/** The user's upcoming external meetings (next 7 days) with brief status — for the Calls page. */
export async function upcomingMeetingsWithBriefs(user: AppUser, limit = 6) {
  const now = new Date();
  return db
    .select({ id: s.meetings.id, title: s.meetings.title, startsAt: s.meetings.startsAt, attendees: s.meetings.attendees, dealId: s.meetings.dealId, briefId: s.briefs.id })
    .from(s.meetings)
    .leftJoin(s.briefs, and(eq(s.briefs.kind, KIND), eq(s.briefs.subjectId, sql`${s.meetings.id}::text`), eq(s.briefs.userId, user.id), eq(s.briefs.periodKey, "")))
    .where(and(eq(s.meetings.ownerId, user.id), gte(s.meetings.startsAt, now), lte(s.meetings.startsAt, new Date(now.getTime() + 7 * 86_400_000)), sql`cardinality(${s.meetings.attendees}) > 0`))
    .orderBy(s.meetings.startsAt)
    .limit(limit);
}
