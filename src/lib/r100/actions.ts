"use server";
import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, canSeeRestricted, ForbiddenError, inScope, type AppUser } from "@/lib/rbac/server";
import { moveDealToStage } from "@/lib/deals/stage-service";
import { INTERVIEW_STATUSES, mergeR100, parseInterviews, type Interview, type R100Json } from "./calc";

/** Load an R100 deal the user may edit (module scope + record scope + restricted list). */
async function editableR100Deal(user: AppUser, dealId: string) {
  const [row] = await db
    .select({ deal: s.deals, pipelineKey: s.pipelines.key })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .where(and(eq(s.deals.id, dealId), isNull(s.deals.deletedAt)));
  if (!row || row.pipelineKey !== "R100") throw new UserError("Roundtable 100 deal not found.");
  const scope = await assertCan(user, "deals_R100", "edit");
  const splits = await db.select({ userId: s.dealSplits.userId }).from(s.dealSplits).where(eq(s.dealSplits.dealId, dealId));
  const d = row.deal;
  if (!inScope(user, scope, { ownerId: d.ownerId, teamId: d.teamId, splitUserIds: splits.map((x) => x.userId), pipelineKey: "R100" }))
    throw new ForbiddenError();
  if (d.restricted && !(await canSeeRestricted(user, "deal", d.id))) throw new ForbiddenError();
  return d;
}

const url = z.union([z.url({ protocol: /^https?$/ }), z.literal("")]).optional().nullable();

const patchSchema = z.object({
  dealId: z.uuid(),
  patch: z
    .object({
      firstPostDate: z.union([z.iso.date(), z.literal("")]).nullable().optional(),
      participation: z.array(z.boolean()).max(3).optional(),
      postCount: z.number().int().min(0).max(100000).optional(),
      profileUrl: url,
      editorialLinks: z.array(z.url({ protocol: /^https?$/ })).max(20).optional(),
      bonusEligible: z.boolean().optional(),
      bonusCents: z.number().int().min(0).max(100_000_000).optional(),
    })
    .strict(),
});

export const updateR100 = action(patchSchema, async ({ dealId, patch }, user) => {
  const deal = await editableR100Deal(user, dealId);
  const before = (deal.r100 ?? {}) as R100Json;
  const clean: Partial<R100Json> = { ...patch };
  if (patch.firstPostDate === "") clean.firstPostDate = null;
  if (patch.profileUrl === "") clean.profileUrl = null;
  const after = mergeR100(before, clean);
  await db.update(s.deals).set({ r100: after }).where(eq(s.deals.id, dealId));
  await audit({ actorId: user.id, action: "r100.update", entity: "deal", entityId: dealId, before, after });
  revalidatePath("/r100");
  return after;
});

/**
 * R100 board stage change (H-12): goes through the ONE shared stage service (gates / required fields, lost & hold
 * reasons, approval-gated stages, won automation, first-post stamp, history, activity, audit, health, row lock).
 * Optional gate values / reason are passed through; a missing one comes back as the service's field message.
 */
export const setR100Stage = action(
  z.object({
    dealId: z.uuid(),
    stageId: z.uuid(),
    fields: z.record(z.string().max(60), z.string().max(2000)).optional(),
    reasonCode: z.string().max(120).optional(),
    reasonText: z.string().trim().max(2000).optional(),
  }),
  async ({ dealId, stageId, fields, reasonCode, reasonText }, user) => {
    const deal = await editableR100Deal(user, dealId);
    if (deal.stageId === stageId) return { changed: false };
    const [stage] = await db.select({ id: s.stages.id }).from(s.stages).where(and(eq(s.stages.id, stageId), eq(s.stages.pipelineId, deal.pipelineId)));
    if (!stage) throw new UserError("That stage is not part of the Roundtable 100 pipeline.");
    const res = await moveDealToStage(user, dealId, { id: stageId }, { fields, reasonCode, reasonText }, { via: "r100" });
    if (res.pendingApproval) throw new UserError(`${res.stageName} needs approval — a request was sent; the deal moves once it is approved.`);
    const [after] = await db.select({ r100: s.deals.r100 }).from(s.deals).where(eq(s.deals.id, dealId));
    revalidatePath("/r100");
    revalidatePath(`/deals/${dealId}`);
    return { changed: res.moved, firstPostDate: ((after?.r100 ?? {}) as R100Json).firstPostDate ?? null };
  },
);

const interviewSchema = z.object({
  dealId: z.uuid(),
  interview: z.object({
    id: z.string().max(64).optional(),
    guest: z.string().trim().min(1, "Guest is required").max(200),
    host: z.string().trim().max(200).default(""),
    status: z.enum(INTERVIEW_STATUSES),
    filmedAt: z.union([z.iso.date(), z.literal("")]).nullable().optional(),
    publishAt: z.union([z.iso.date(), z.literal("")]).nullable().optional(),
    link: url,
  }),
});

export const saveInterview = action(interviewSchema, async ({ dealId, interview }, user) => {
  const deal = await editableR100Deal(user, dealId);
  const cf = (deal.customFields ?? {}) as Record<string, unknown>;
  const list = parseInterviews(cf);
  const item: Interview = {
    id: interview.id || crypto.randomUUID(),
    guest: interview.guest,
    host: interview.host ?? "",
    status: interview.status,
    filmedAt: interview.filmedAt || null,
    publishAt: interview.publishAt || null,
    link: interview.link || null,
  };
  const idx = list.findIndex((i) => i.id === item.id);
  const next = idx >= 0 ? list.map((i, j) => (j === idx ? item : i)) : [...list, item];
  await db.update(s.deals).set({ customFields: { ...cf, interviews: next } }).where(eq(s.deals.id, dealId));
  await audit({ actorId: user.id, action: idx >= 0 ? "r100.interview.update" : "r100.interview.create", entity: "deal", entityId: dealId, before: idx >= 0 ? list[idx] : null, after: item });
  revalidatePath("/r100");
  return item;
});

export const deleteInterview = action(z.object({ dealId: z.uuid(), interviewId: z.string().min(1).max(64) }), async ({ dealId, interviewId }, user) => {
  const deal = await editableR100Deal(user, dealId);
  const cf = (deal.customFields ?? {}) as Record<string, unknown>;
  const list = parseInterviews(cf);
  const removed = list.find((i) => i.id === interviewId);
  if (!removed) throw new UserError("Interview not found.");
  await db
    .update(s.deals)
    .set({ customFields: { ...cf, interviews: list.filter((i) => i.id !== interviewId) } })
    .where(eq(s.deals.id, dealId));
  await audit({ actorId: user.id, action: "r100.interview.delete", entity: "deal", entityId: dealId, before: removed, after: null });
  revalidatePath("/r100");
  return { ok: true };
});
