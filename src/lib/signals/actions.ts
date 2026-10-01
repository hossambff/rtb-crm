"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "@/lib/actions";
import { applySignal, dismissSignal } from "./service";

/** Deal page / panel actions for deal signals (permission + gates re-checked in the service). */
export const applyDealSignal = action(z.object({ id: z.uuid(), dealId: z.uuid() }), async ({ id, dealId }, user) => {
  const r = await applySignal(user, id);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/home");
  return r;
});

export const dismissDealSignal = action(z.object({ id: z.uuid(), dealId: z.uuid() }), async ({ id, dealId }, user) => {
  await dismissSignal(user, id);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/home");
  return true;
});
