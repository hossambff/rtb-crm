import "server-only";
import { mnpiSafe } from "@/lib/deals/notice";
import { and, asc, desc, eq, gte, inArray, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { logServerError } from "@/lib/errors";
import { notifyMany } from "@/lib/notifications/notify";
import { ForbiddenError, type AppUser } from "@/lib/rbac/server";
import { parseUserDate } from "@/lib/time";
import { isHelpTarget } from "@/lib/deals/audience-core";
import { dealAudience, dealAudienceRecord, directoryUser, loadDirectory } from "@/lib/deals/audience";
import { loadBriefSource } from "@/lib/deals/brief-source";
import { hiddenDealFields, loadDealForWrite, logActivity } from "@/lib/deals/service";
import { buildHelpContext, canTransition, helpAskSchema, helpHref, isActive, type HelpStatus } from "./core";
import { isSensitive } from "@/lib/notifications/sensitive";

export type HelpRequestDTO = {
  id: string;
  dealId: string | null;
  meetingId: string | null;
  ask: string;
  context: string | null;
  neededBy: string | null;
  status: HelpStatus;
  response: string | null;
  respondedAt: string | null;
  createdAt: string;
  requester: { id: string; name: string; image: string | null };
  target: { id: string; name: string; image: string | null };
};

/** Execs / leaders (+ the requester's manager) who can see the deal. */
export async function helpTargets(user: AppUser, dealId: string | null): Promise<{ id: string; name: string; image: string | null; role: string }[]> {
  const me = await directoryUser(user.id);
  const requester = { id: user.id, managerId: me?.managerId ?? null };
  let pool = await loadDirectory();
  if (dealId) {
    const rec = await dealAudienceRecord(dealId);
    if (!rec) return [];
    pool = await dealAudience(rec, "view");
  }
  return pool
    .filter((u) => isHelpTarget(u, requester))
    .map((u) => ({ id: u.id, name: u.name, image: u.image, role: u.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function nextMeeting(dealId: string | null, meetingId: string | null) {
  if (meetingId) {
    const [m] = await db.select({ id: s.meetings.id, title: s.meetings.title, startsAt: s.meetings.startsAt, dealId: s.meetings.dealId, accountId: s.meetings.accountId, ownerId: s.meetings.ownerId }).from(s.meetings).where(eq(s.meetings.id, meetingId));
    return m ?? null;
  }
  if (!dealId) return null;
  const [m] = await db
    .select({ id: s.meetings.id, title: s.meetings.title, startsAt: s.meetings.startsAt, dealId: s.meetings.dealId, accountId: s.meetings.accountId, ownerId: s.meetings.ownerId })
    .from(s.meetings)
    .where(and(eq(s.meetings.dealId, dealId), gte(s.meetings.startsAt, new Date())))
    .orderBy(asc(s.meetings.startsAt))
    .limit(1);
  return m ?? null;
}

export async function createHelpRequest(user: AppUser, input: { dealId?: string; meetingId?: string; targetUserId: string; ask: string; neededBy?: string | null }) {
  const ask = helpAskSchema.parse(input.ask);
  let dealId = input.dealId ?? null;
  const meeting = input.meetingId ? await nextMeeting(null, input.meetingId) : null;
  if (input.meetingId) {
    if (!meeting) throw new UserError("Meeting not found.");
    // From a meeting: it must be yours, or attached to a deal you can see (checked below).
    if (meeting.ownerId !== user.id && !meeting.dealId) throw new ForbiddenError();
    if (!dealId) dealId = meeting.dealId ?? null;
    if (meeting.dealId && dealId !== meeting.dealId) throw new UserError("That meeting belongs to a different deal.");
  }
  if (!dealId && !meeting) throw new UserError("Ask for help from a deal or a meeting.");
  let ctx: Awaited<ReturnType<typeof loadDealForWrite>> | null = null;
  if (dealId) ctx = await loadDealForWrite(user, dealId, "view");
  else if (meeting && meeting.ownerId !== user.id) throw new ForbiddenError();
  const targets = await helpTargets(user, dealId);
  const target = targets.find((t) => t.id === input.targetUserId);
  if (!target) throw new UserError(dealId ? "Pick an executive or leader who can see this deal." : "Pick an executive or leader.");
  const neededBy = input.neededBy ? parseUserDate(input.neededBy, user.timezone) : null;
  if (neededBy === undefined) throw new UserError("Needed-by date is invalid.");

  let context: string;
  const upcoming = meeting ?? (dealId ? await nextMeeting(dealId, null) : null);
  const meetingInfo = upcoming ? { title: upcoming.title, startsAt: upcoming.startsAt?.toISOString() ?? null } : null;
  if (dealId) {
    const { src } = await loadBriefSource(dealId, await hiddenDealFields(user.role));
    context = buildHelpContext({ dealName: src.dealName, stageName: src.stageName, valueLabel: src.valueLabel, summary: src.summary, nextStep: src.nextStep, nextStepDueAt: src.nextStepDueAt, meeting: meetingInfo });
  } else context = buildHelpContext({ dealName: null, meeting: meetingInfo });

  const [row] = await db
    .insert(s.helpRequests)
    .values({ dealId, meetingId: meeting?.id ?? null, requesterId: user.id, targetUserId: target.id, ask, context, neededBy, status: "open" })
    .returning({ id: s.helpRequests.id });
  if (ctx) await logActivity({ type: "system", subject: `Help requested from ${target.name}`, body: ask, actorId: user.id, dealId: ctx.deal.id, accountId: ctx.deal.accountId, metadata: { helpRequestId: row!.id } });
  await audit({ actorId: user.id, action: "help.create", entity: dealId ? "deal" : "meeting", entityId: dealId ?? meeting?.id, after: { helpRequestId: row!.id, targetUserId: target.id, neededBy } });
  await notifyMany([target.id], {
    kind: "help",
    // N-7: meeting-only asks are sensitive when the meeting's account is restricted (free-text ask must not reach Slack)
    ...mnpiSafe(!!ctx?.deal.restricted || (dealId ? await isSensitive({ dealId }) : false) || (meeting?.accountId ? await isSensitive({ accountId: meeting.accountId }) : false), { title: `${user.name} needs your help${ctx ? ` on ${ctx.deal.name}` : ""}`, body: ask.slice(0, 280) }, `${user.name} needs your help on a restricted deal`),
    href: helpHref({ id: row!.id, dealId }),
  });
  return { id: row!.id, dealId, targetName: target.name, pipelineKey: ctx?.pipeline.key };
}

/** Target: accept / decline / done (with a response). Requester is notified. */
export async function respondHelpRequest(user: AppUser, input: { id: string; status: "accepted" | "declined" | "done"; response?: string }) {
  if (!/^[0-9a-f-]{36}$/i.test(input.id)) throw new UserError("Request not found.");
  const [r] = await db.select().from(s.helpRequests).where(eq(s.helpRequests.id, input.id));
  if (!r) throw new UserError("Request not found.");
  if (r.targetUserId !== user.id) throw new ForbiddenError("Only the person asked can respond.");
  if (!canTransition(r.status, input.status)) throw new UserError(`This request is already ${r.status}.`);
  const response = input.response?.trim() || null;
  if (input.status === "declined" && (response?.length ?? 0) < 3) throw new UserError("Add a short note when you decline.");
  const updated = await db
    .update(s.helpRequests)
    .set({ status: input.status, response: response ?? r.response, respondedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(s.helpRequests.id, r.id), eq(s.helpRequests.status, r.status)))
    .returning({ id: s.helpRequests.id });
  if (!updated.length) throw new UserError("This request changed in the meantime — reload.");
  let dealName: string | null = null;
  let restricted = false;
  if (!r.dealId && r.meetingId) {
    const [m] = await db.select({ accountId: s.meetings.accountId }).from(s.meetings).where(eq(s.meetings.id, r.meetingId));
    restricted = m?.accountId ? await isSensitive({ accountId: m.accountId }) : false;
  }
  if (r.dealId) {
    const [d] = await db.select({ name: s.deals.name, accountId: s.deals.accountId, restricted: s.deals.restricted }).from(s.deals).where(eq(s.deals.id, r.dealId));
    dealName = d?.name ?? null;
    restricted = !!d?.restricted || (await isSensitive({ dealId: r.dealId }));
    if (d) await logActivity({ type: "system", subject: `${user.name} ${input.status === "done" ? "completed" : input.status} a help request`, body: response, actorId: user.id, dealId: r.dealId, accountId: d.accountId, metadata: { helpRequestId: r.id } });
  }
  await audit({ actorId: user.id, action: `help.${input.status}`, entity: r.dealId ? "deal" : "help_request", entityId: r.dealId ?? r.id, before: { status: r.status }, after: { helpRequestId: r.id, status: input.status, response } });
  const verb = input.status === "accepted" ? "is on it" : input.status === "done" ? "helped" : "can't help";
  await notifyMany([r.requesterId], {
    kind: "help",
    ...mnpiSafe(restricted, { title: `${user.name} ${verb}${dealName ? ` — ${dealName}` : ""}`, body: response ?? r.ask.slice(0, 200) }, `${user.name} ${verb} (restricted deal)`),
    href: helpHref(r),
  });
  return { dealId: r.dealId };
}

export async function cancelHelpRequest(user: AppUser, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new UserError("Request not found.");
  const [r] = await db.select().from(s.helpRequests).where(eq(s.helpRequests.id, id));
  if (!r || r.requesterId !== user.id) throw new UserError("Request not found.");
  if (!isActive(r.status)) throw new UserError(`This request is already ${r.status}.`);
  await db.update(s.helpRequests).set({ status: "cancelled", updatedAt: new Date() }).where(eq(s.helpRequests.id, r.id));
  await audit({ actorId: user.id, action: "help.cancel", entity: r.dealId ? "deal" : "help_request", entityId: r.dealId ?? r.id, after: { helpRequestId: r.id } });
  if (r.status === "accepted") await notifyMany([r.targetUserId], { kind: "help", title: `${user.name} withdrew a help request`, body: null, href: helpHref(r) });
  return { dealId: r.dealId };
}

async function loadRequests(where: SQL | undefined, limit: number): Promise<HelpRequestDTO[]> {
  const req = alias(s.user, "requester");
  const tgt = alias(s.user, "target");
  const rows = await db
    .select({ r: s.helpRequests, reqName: req.name, reqImage: req.image, tgtName: tgt.name, tgtImage: tgt.image })
    .from(s.helpRequests)
    .leftJoin(req, eq(req.id, s.helpRequests.requesterId))
    .innerJoin(tgt, eq(tgt.id, s.helpRequests.targetUserId))
    .where(where)
    .orderBy(desc(s.helpRequests.createdAt))
    .limit(limit);
  return rows.map(({ r, reqName, reqImage, tgtName, tgtImage }) => ({
    id: r.id,
    dealId: r.dealId,
    meetingId: r.meetingId,
    ask: r.ask,
    context: r.context,
    neededBy: r.neededBy?.toISOString() ?? null,
    status: r.status as HelpStatus,
    response: r.response,
    respondedAt: r.respondedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    requester: { id: r.requesterId, name: reqName ?? "Someone", image: reqImage },
    target: { id: r.targetUserId, name: tgtName, image: tgtImage },
  }));
}

/** Requests on a deal (caller has checked deal visibility): active first, then the last few closed. */
export async function listDealHelpRequests(dealId: string): Promise<HelpRequestDTO[]> {
  try {
    const rows = await loadRequests(eq(s.helpRequests.dealId, dealId), 20);
    return [...rows.filter((r) => isActive(r.status)), ...rows.filter((r) => !isActive(r.status)).slice(0, 5)];
  } catch (e) {
    logServerError("help.list", e);
    return [];
  }
}

/** Queue helper: active requests where the user is the target or the requester. */
export async function activeHelpFor(userId: string): Promise<HelpRequestDTO[]> {
  return loadRequests(and(inArray(s.helpRequests.status, ["open", "accepted"]), or(eq(s.helpRequests.targetUserId, userId), eq(s.helpRequests.requesterId, userId))), 60);
}

/**
 * One request for its own page (/help/<id>): only the requester or the person asked may open it, and only while its deal
 * (if any) is still visible to them. Null otherwise (the page answers 404 — no oracle).
 */
export async function getHelpRequestFor(user: AppUser, id: string): Promise<HelpRequestDTO | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await loadRequests(eq(s.helpRequests.id, id), 1);
  if (!r || (r.requester.id !== user.id && r.target.id !== user.id)) return null;
  if (r.dealId) {
    const ok = await loadDealForWrite(user, r.dealId, "view").then(
      () => true,
      () => false,
    );
    if (!ok) return null;
  }
  return r;
}
