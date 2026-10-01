import "server-only";
import { mnpiSafe } from "@/lib/deals/notice";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { aiAvailable, aiObject, modelFor, untrusted } from "@/lib/ai";
import { untrustedField } from "@/lib/untrusted-core";
import { audit } from "@/lib/audit";
import { logServerError } from "@/lib/errors";
import { notifyMany } from "@/lib/notifications/notify";
import { isSensitive } from "@/lib/notifications/sensitive";
import { ensureMigrationProject } from "@/lib/onboarding/service";
import { can, ForbiddenError, type AppUser } from "@/lib/rbac/server";
import { dealAudience, dealAudienceRecord, directoryUser, userCanOnDeal } from "@/lib/deals/audience";
import { loadBriefSource } from "@/lib/deals/brief-source";
import { canAssignTo, hiddenDealFields, loadDealForWrite, logActivity, recomputeDealHealth } from "@/lib/deals/service";
import { handoffBriefSchema, HANDOFF_KIND_LABEL, heuristicBrief, isPendingHandoffConflict, ownerChangedSince, roleFitsKind, type HandoffBrief, type HandoffKind } from "./core";

/** Stored alongside the brief (jsonb): the deal owner when the handoff was sent (CR M1). Not part of the visible brief. */
type StoredBrief = HandoffBrief & { ownerAtCreate?: string | null };

export type HandoffDTO = {
  id: string;
  dealId: string;
  kind: HandoffKind;
  status: string;
  brief: HandoffBrief;
  from: { id: string; name: string; image: string | null } | null;
  to: { id: string; name: string; image: string | null };
  responseNote: string | null;
  respondedAt: string | null;
  createdAt: string;
};

/** Receivers the sender may pick for a kind: people who could own (edit) the deal / onboarding specialists who can see it. */
export async function eligibleReceivers(user: AppUser, dealId: string, kind: HandoffKind): Promise<{ id: string; name: string; image: string | null; role: string }[]> {
  const rec = await dealAudienceRecord(dealId);
  if (!rec) return [];
  const users = kind === "ae_to_onboarding" ? await dealAudience(rec, "view") : await dealAudience(rec, "edit", { asOwner: true });
  return users
    .filter((u) => u.id !== user.id && (kind === "ae_to_onboarding" || u.id !== rec.ownerId) && roleFitsKind(kind, u.role))
    .map((u) => ({ id: u.id, name: u.name, image: u.image, role: u.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Prefill a brief from deal data: AI when allowed (never for restricted deals), heuristic otherwise. */
export async function draftBrief(user: AppUser, dealId: string): Promise<HandoffBrief & { engine: string }> {
  await loadDealForWrite(user, dealId, "view");
  const hidden = await hiddenDealFields(user.role);
  const { restricted, src, activities } = await loadBriefSource(dealId, hidden);
  const fallback = { ...heuristicBrief(src), engine: "heuristic" };
  if (restricted || !aiAvailable() || !(await can(user, "copilot", "use_ai"))) return fallback;
  try {
    const prompt = [
      "Write a handoff brief for the colleague taking over this deal. Return JSON matching the schema.",
      "context: 2-4 sentences on where the deal stands and why (at least 40 characters). stakeholders: one per line with role.",
      "commitments: open promises both ways. risks: one per line. nextStep: the single next action with date.",
      "Use only facts below. Draft to start from:",
      JSON.stringify(fallback),
      "",
      "## Recent activities (untrusted data)",
      ...activities.slice(0, 12).map((a) => `- ${a.occurredAt.toISOString().slice(0, 10)} ${a.type}: ${untrustedField("subject", a.subject, 200)}\n${a.body ? untrusted(`activity:${a.id}`, a.body, 1200) : ""}`),
    ].join("\n");
    const out = await aiObject({ kind: "handoff_brief", userId: user.id, tier: "fast", schema: handoffBriefSchema, prompt });
    return { ...out, engine: `ai:${await modelFor("fast")}` };
  } catch {
    return fallback;
  }
}

async function loadHandoffs(where: SQL, limit = 20): Promise<HandoffDTO[]> {
  const from = alias(s.user, "from_user");
  const to = alias(s.user, "to_user");
  const rows = await db
    .select({ h: s.handoffs, fromName: from.name, fromImage: from.image, toName: to.name, toImage: to.image })
    .from(s.handoffs)
    .leftJoin(from, eq(from.id, s.handoffs.fromUserId))
    .innerJoin(to, eq(to.id, s.handoffs.toUserId))
    .where(where)
    .orderBy(desc(s.handoffs.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.h.id,
    dealId: r.h.dealId,
    kind: r.h.kind as HandoffKind,
    status: r.h.status,
    brief: (({ ownerAtCreate, ...b }: StoredBrief) => (void ownerAtCreate, b))(r.h.brief as StoredBrief),
    from: r.h.fromUserId ? { id: r.h.fromUserId, name: r.fromName ?? "Someone", image: r.fromImage } : null,
    to: { id: r.h.toUserId, name: r.toName, image: r.toImage },
    responseNote: r.h.responseNote,
    respondedAt: r.h.respondedAt?.toISOString() ?? null,
    createdAt: r.h.createdAt.toISOString(),
  }));
}

/** Handoffs on a deal (caller has checked deal visibility), newest first. */
export async function listDealHandoffs(dealId: string): Promise<HandoffDTO[]> {
  try {
    return await loadHandoffs(eq(s.handoffs.dealId, dealId), 10);
  } catch (e) {
    logServerError("handoffs.list", e);
    return [];
  }
}

export async function createHandoff(user: AppUser, input: { dealId: string; toUserId: string; kind: HandoffKind; brief: HandoffBrief }) {
  const ctx = await loadDealForWrite(user, input.dealId, "edit");
  if (input.kind === "ae_to_onboarding" && ctx.deal.status !== "won") throw new UserError("Hand off to onboarding once the deal is won.");
  if (input.kind !== "ae_to_onboarding" && ctx.deal.status !== "open" && ctx.deal.status !== "hold") throw new UserError("Closed deals can only be handed to onboarding.");
  const eligible = await eligibleReceivers(user, ctx.deal.id, input.kind);
  const receiver = eligible.find((u) => u.id === input.toUserId);
  if (!receiver) throw new UserError("That person can't take this deal (permissions or access list). Pick someone else.");
  // SEC M-8: a reassign moves ownership → the sender needs assign permission for that receiver, like a direct reassign.
  if (input.kind === "reassign" && !(await canAssignTo(user, ctx.pipeline.key, receiver.id))) {
    throw new ForbiddenError("Your role can't reassign this deal to that person — ask your manager.");
  }
  const brief = handoffBriefSchema.parse(input.brief);
  const [pending] = await db.select({ id: s.handoffs.id }).from(s.handoffs).where(and(eq(s.handoffs.dealId, ctx.deal.id), eq(s.handoffs.status, "pending")));
  if (pending) throw new UserError("This deal already has a pending handoff — cancel it first.");
  const stored: StoredBrief = { ...brief, ownerAtCreate: ctx.deal.ownerId ?? null };
  let h: { id: string } | undefined;
  try {
    [h] = await db
      .insert(s.handoffs)
      .values({ dealId: ctx.deal.id, kind: input.kind, fromUserId: user.id, toUserId: receiver.id, brief: stored, status: "pending" })
      .returning({ id: s.handoffs.id });
  } catch (e) {
    // Double submit / two tabs: the unique partial index handoffs_one_pending_uq is the real guard.
    if (isPendingHandoffConflict(e)) throw new UserError("This deal already has a pending handoff — cancel it first.");
    throw e;
  }
  await logActivity({ type: "system", subject: `Handoff requested: ${HANDOFF_KIND_LABEL[input.kind]} to ${receiver.name}`, actorId: user.id, dealId: ctx.deal.id, accountId: ctx.deal.accountId, metadata: { handoffId: h!.id } });
  await audit({ actorId: user.id, action: "handoff.create", entity: "deal", entityId: ctx.deal.id, after: { handoffId: h!.id, kind: input.kind, toUserId: receiver.id } });
  await notifyMany([receiver.id], { kind: "handoff", ...mnpiSafe(ctx.deal.restricted || (await isSensitive({ dealId: ctx.deal.id })), { title: `${user.name} is handing you ${ctx.deal.name}`, body: brief.context.slice(0, 280) }, `${user.name} is handing you a restricted deal`), href: `/deals/${ctx.deal.id}?handoff=${h!.id}` });
  return { id: h!.id, pipelineKey: ctx.pipeline.key, receiverName: receiver.name };
}

/**
 * Receiver accepts (ownership / onboarding project moves to them) or declines with a note (stays with the sender).
 * Re-checks that the receiver may still own the deal; the status flip and the ownership change commit together.
 */
export async function respondHandoff(user: AppUser, input: { handoffId: string; accept: boolean; note?: string }) {
  if (!/^[0-9a-f-]{36}$/i.test(input.handoffId)) throw new UserError("Handoff not found.");
  const [h] = await db.select().from(s.handoffs).where(eq(s.handoffs.id, input.handoffId));
  if (!h) throw new UserError("Handoff not found.");
  if (h.toUserId !== user.id) throw new ForbiddenError("Only the receiver can respond to this handoff.");
  if (h.status !== "pending") throw new UserError(`This handoff was already ${h.status}.`);
  if (!input.accept && (input.note?.trim().length ?? 0) < 3) throw new UserError("Add a short note so the sender knows why.");
  const rec = await dealAudienceRecord(h.dealId);
  if (!rec) throw new UserError("The deal no longer exists.");
  const me = await directoryUser(user.id);
  if (!me) throw new ForbiddenError();
  const kind = h.kind as HandoffKind;
  if (input.accept) {
    const ok = kind === "ae_to_onboarding" ? await userCanOnDeal(me, rec, "view") : await userCanOnDeal(me, { ...rec, ownerId: me.id }, "edit");
    if (!ok) throw new UserError("Your role can't take over this deal — decline it with a note, or ask an admin.");
  } // A receiver who lost access can still decline: it only returns the deal to the sender.
  const [pre] = await db.select({ id: s.deals.id, name: s.deals.name, accountId: s.deals.accountId }).from(s.deals).where(and(eq(s.deals.id, h.dealId), isNull(s.deals.deletedAt)));
  if (!pre) throw new UserError("The deal no longer exists.");
  const now = new Date();
  const expectedOwner = (h.brief as StoredBrief).ownerAtCreate !== undefined ? (h.brief as StoredBrief).ownerAtCreate : h.fromUserId;
  const outcome = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ status: s.handoffs.status }).from(s.handoffs).where(eq(s.handoffs.id, h.id)).for("update");
    if (locked?.status !== "pending") throw new UserError("This handoff was already answered.");
    // CR M1: lock the deal row and re-read it — a deleted deal or an owner change since the handoff was sent wins.
    const [deal] = await tx
      .select({ id: s.deals.id, name: s.deals.name, ownerId: s.deals.ownerId, teamId: s.deals.teamId, accountId: s.deals.accountId, deletedAt: s.deals.deletedAt })
      .from(s.deals)
      .where(eq(s.deals.id, h.dealId))
      .for("update");
    if (!deal || deal.deletedAt) throw new UserError("The deal no longer exists.");
    if (input.accept && ownerChangedSince(kind, expectedOwner, deal.ownerId)) {
      await tx.update(s.handoffs).set({ status: "cancelled", responseNote: "Deal changed hands before acceptance", respondedAt: now }).where(eq(s.handoffs.id, h.id));
      await audit({ actorId: user.id, action: "handoff.cancel", entity: "deal", entityId: deal.id, before: { ownerId: expectedOwner ?? null }, after: { handoffId: h.id, reason: "owner_changed", ownerId: deal.ownerId } }, tx);
      return { stale: true as const, deal };
    }
    await tx
      .update(s.handoffs)
      .set({ status: input.accept ? "accepted" : "declined", responseNote: input.note?.trim() || null, respondedAt: now })
      .where(eq(s.handoffs.id, h.id));
    if (input.accept && kind !== "ae_to_onboarding") {
      const teamId = user.teamId ?? deal.teamId;
      await tx.update(s.deals).set({ ownerId: user.id, teamId }).where(eq(s.deals.id, deal.id));
      await audit({ actorId: user.id, action: "deal.reassign", entity: "deal", entityId: deal.id, before: { ownerId: deal.ownerId, teamId: deal.teamId }, after: { ownerId: user.id, teamId, via: "handoff", handoffId: h.id } }, tx);
    }
    if (input.accept && kind === "ae_to_onboarding") {
      const res = await ensureMigrationProject(deal.id, { actorId: user.id, ownerId: user.id }, tx);
      if (res?.project) await tx.update(s.migrationProjects).set({ ownerId: user.id }).where(eq(s.migrationProjects.id, res.project.id));
    }
    await logActivity(
      {
        type: "system",
        subject: input.accept ? `Handoff accepted by ${user.name}` : `Handoff declined by ${user.name}`,
        body: input.note?.trim() || null,
        actorId: user.id,
        dealId: deal.id,
        accountId: deal.accountId,
        metadata: { handoffId: h.id },
      },
      tx,
    );
    await audit({ actorId: user.id, action: input.accept ? "handoff.accept" : "handoff.decline", entity: "deal", entityId: deal.id, before: { status: "pending" }, after: { handoffId: h.id, note: input.note ?? null } }, tx);
    return { stale: false as const, deal };
  });
  // Thrown after the transaction committed the cancellation (a throw inside would roll it back).
  if (outcome.stale) throw new UserError("The deal changed hands since this handoff was sent — ask the sender to resend it.");
  const deal = outcome.deal;
  if (h.fromUserId && h.fromUserId !== user.id) {
    await notifyMany([h.fromUserId], {
      kind: "handoff",
      ...mnpiSafe(
        rec.restricted || (await isSensitive({ dealId: deal.id })),
        { title: input.accept ? `${user.name} accepted ${deal.name}` : `${user.name} declined ${deal.name}`, body: input.note?.trim() || (input.accept ? "Ownership has moved." : null) },
        input.accept ? `${user.name} accepted your handoff (restricted deal)` : `${user.name} declined your handoff (restricted deal)`,
      ),
      href: `/deals/${deal.id}`,
    });
  }
  if (input.accept) await recomputeDealHealth(deal.id).catch((e) => logServerError("handoff.health", e));
  return { dealId: deal.id, accepted: input.accept };
}

/** Sender (or anyone who can edit the deal) withdraws a pending handoff. */
export async function cancelHandoff(user: AppUser, handoffId: string) {
  const [h] = await db.select().from(s.handoffs).where(eq(s.handoffs.id, handoffId));
  if (!h || h.status !== "pending") throw new UserError("No pending handoff to cancel.");
  const ctx = await loadDealForWrite(user, h.dealId, "edit");
  await db.update(s.handoffs).set({ status: "cancelled", respondedAt: new Date() }).where(and(eq(s.handoffs.id, h.id), eq(s.handoffs.status, "pending")));
  await audit({ actorId: user.id, action: "handoff.cancel", entity: "deal", entityId: ctx.deal.id, after: { handoffId: h.id } });
  // SEC M-3: account-level restriction counts too, and the link points at the deal (access-checked), never /home.
  if (h.toUserId !== user.id) await notifyMany([h.toUserId], { kind: "handoff", ...mnpiSafe(ctx.deal.restricted || (await isSensitive({ dealId: ctx.deal.id })), { title: `Handoff of ${ctx.deal.name} was withdrawn` }, "A handoff to you was withdrawn"), href: `/deals/${ctx.deal.id}` });
  return { dealId: ctx.deal.id };
}

/** Pending handoffs waiting on these receivers (queue provider helper). */
/**
 * A receiver who can't (yet) see the deal — e.g. an AE outside the SDR's team — still needs to review what they're
 * being handed. While a handoff to them is pending they get a read-only brief view: deal name, account, stage and the
 * brief the sender wrote. Nothing else from the record is exposed. Null when there's no pending handoff to `user`.
 */
export async function pendingHandoffReview(user: AppUser, dealId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(dealId)) return null;
  const [h] = await loadHandoffs(and(eq(s.handoffs.dealId, dealId), eq(s.handoffs.toUserId, user.id), eq(s.handoffs.status, "pending"))!, 1);
  if (!h) return null;
  const [d] = await db
    .select({ name: s.deals.name, stage: s.stages.name, accountName: s.accounts.name, pipelineName: s.pipelines.name, deletedAt: s.deals.deletedAt, restricted: s.deals.restricted })
    .from(s.deals)
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .where(eq(s.deals.id, dealId));
  if (!d || d.deletedAt) return null;
  if (d.restricted && user.role !== "super_admin") {
    const rec = await dealAudienceRecord(dealId);
    const me = await directoryUser(user.id);
    if (!rec || !me || !(await userCanOnDeal(me, { ...rec, ownerId: me.id }, "view"))) return null;
  }
  return { handoff: h, deal: { id: dealId, name: d.name, stage: d.stage, accountName: d.accountName, pipelineName: d.pipelineName } };
}
