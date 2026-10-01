"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "@/lib/actions";
import { loadDealForWrite } from "@/lib/deals/service";
import { helpAskSchema } from "./core";
import { cancelHelpRequest, createHelpRequest, helpTargets, respondHelpRequest } from "./service";

const uuid = z.string().uuid();

function refresh(dealId: string | null | undefined) {
  if (dealId) revalidatePath(`/deals/${dealId}`);
  revalidatePath("/home");
}

/** Dialog bootstrap: who can be asked (execs / leaders / your manager who can see the deal). */
export const listHelpTargets = action(z.object({ dealId: uuid.optional() }), async ({ dealId }, user) => {
  if (dealId) await loadDealForWrite(user, dealId, "view");
  return helpTargets(user, dealId ?? null);
});

export const requestHelp = action(
  z.object({ dealId: uuid.optional(), meetingId: uuid.optional(), targetUserId: z.string().min(1).max(100), ask: helpAskSchema, neededBy: z.string().max(40).optional().nullable() }),
  async (input, user) => {
    const res = await createHelpRequest(user, input);
    refresh(res.dealId);
    return { id: res.id, targetName: res.targetName };
  },
);

export const answerHelpRequest = action(z.object({ id: uuid, status: z.enum(["accepted", "declined", "done"]), response: z.string().trim().max(2000).optional() }), async (input, user) => {
  const res = await respondHelpRequest(user, input);
  refresh(res.dealId);
  return { ok: true };
});

export const withdrawHelpRequest = action(z.object({ id: uuid }), async ({ id }, user) => {
  const res = await cancelHelpRequest(user, id);
  refresh(res.dealId);
  return { ok: true };
});
