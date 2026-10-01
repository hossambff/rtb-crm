"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "@/lib/actions";
import { MAX_SHARE_DEALS, SHARE_EXPIRY_DAYS, SHARE_FIELDS } from "./core";
import { createShareLink, listShareLinks, revokeShareLink } from "./service";

export const createShareLinkAction = action(
  z.object({
    dealIds: z.array(z.string().uuid()).min(1, "Pick at least one deal").max(MAX_SHARE_DEALS),
    label: z.string().trim().min(1, "Name the link").max(120),
    partnerName: z.string().trim().max(120).nullish(),
    fields: z.array(z.enum(SHARE_FIELDS)).min(1, "Pick at least one field"),
    expiryDays: z.union([z.literal(SHARE_EXPIRY_DAYS[0]), z.literal(SHARE_EXPIRY_DAYS[1]), z.literal(SHARE_EXPIRY_DAYS[2])]),
  }),
  async (input, user) => {
    const r = await createShareLink(user, input);
    for (const id of input.dealIds.slice(0, 5)) revalidatePath(`/deals/${id}`);
    return r;
  },
);

export const revokeShareLinkAction = action(z.object({ id: z.string().uuid() }), async ({ id }, user) => {
  await revokeShareLink(user, id);
  return null;
});

export const listShareLinksAction = action(z.object({ dealId: z.string().uuid().optional() }), async ({ dealId }, user) => {
  return listShareLinks(user, { dealId });
});
