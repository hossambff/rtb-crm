"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "@/lib/actions";
import { loadDealForWrite } from "@/lib/deals/service";
import { handoffBriefSchema, HANDOFF_KINDS } from "./core";
import { cancelHandoff, createHandoff, draftBrief, eligibleReceivers, respondHandoff } from "./service";

const uuid = z.string().uuid();

function refresh(dealId: string, pipelineKey?: string) {
  revalidatePath(`/deals/${dealId}`);
  if (pipelineKey) revalidatePath(`/pipelines/${pipelineKey}`);
  revalidatePath("/home");
}

/** Dialog bootstrap: eligible receivers per kind + a prefilled brief (AI / heuristic). */
export const prepareHandoff = action(z.object({ dealId: uuid }), async ({ dealId }, user) => {
  await loadDealForWrite(user, dealId, "edit");
  const [brief, sdrToAe, reassign, onboarding] = await Promise.all([
    draftBrief(user, dealId),
    eligibleReceivers(user, dealId, "sdr_to_ae"),
    eligibleReceivers(user, dealId, "reassign"),
    eligibleReceivers(user, dealId, "ae_to_onboarding"),
  ]);
  return { brief, receivers: { sdr_to_ae: sdrToAe, reassign, ae_to_onboarding: onboarding } };
});

export const requestHandoff = action(z.object({ dealId: uuid, toUserId: z.string().min(1).max(100), kind: z.enum(HANDOFF_KINDS), brief: handoffBriefSchema }), async (input, user) => {
  const res = await createHandoff(user, input);
  refresh(input.dealId, res.pipelineKey);
  return { id: res.id, receiverName: res.receiverName };
});

export const answerHandoff = action(z.object({ handoffId: uuid, accept: z.boolean(), note: z.string().trim().max(1000).optional() }), async (input, user) => {
  const res = await respondHandoff(user, input);
  refresh(res.dealId);
  return res;
});

export const withdrawHandoff = action(z.object({ handoffId: uuid }), async ({ handoffId }, user) => {
  const res = await cancelHandoff(user, handoffId);
  refresh(res.dealId);
  return { ok: true };
});
