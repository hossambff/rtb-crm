"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "@/lib/actions";
import { loadDealForWrite } from "@/lib/deals/service";
import { createDealComment, deleteDealComment, editDealComment } from "./service";

const uuid = z.string().uuid();
const body = z.string().trim().min(1, "Write something first").max(5000);
const mentionIds = z.array(z.string().max(100)).max(20).optional();

/** Post a comment or a one-level reply on a deal the user can view (V2 §C2). */
export const postDealComment = action(z.object({ dealId: uuid, body, parentId: uuid.optional(), mentionIds }), async (input, user) => {
  const ctx = await loadDealForWrite(user, input.dealId, "view");
  const res = await createDealComment(user, { id: ctx.deal.id, name: ctx.deal.name, restricted: ctx.deal.restricted }, input);
  revalidatePath(`/deals/${ctx.deal.id}`);
  return res;
});

/** Edit your own comment (marks it edited; newly mentioned people are notified). */
export const editDealCommentAction = action(z.object({ commentId: uuid, body, mentionIds }), async (input, user) => {
  const res = await editDealComment(user, input.commentId, input);
  revalidatePath(`/deals/${res.dealId}`);
  return { notified: res.notified };
});

/** Soft-delete your own comment. */
export const deleteDealCommentAction = action(z.object({ commentId: uuid }), async ({ commentId }, user) => {
  const res = await deleteDealComment(user, commentId);
  revalidatePath(`/deals/${res.dealId}`);
  return { ok: true };
});
