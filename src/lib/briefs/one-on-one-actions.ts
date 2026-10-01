"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { getOneOnOneBrief } from "./one-on-one";

/** Rebuild this week's 1:1 brief (manager-initiated; permission re-checked inside getOneOnOneBrief). */
export const refreshOneOnOne = action(z.object({ repId: z.string().min(1).max(100) }), async ({ repId }, user) => {
  const brief = await getOneOnOneBrief(user, repId, { refresh: true });
  if (!brief) throw new UserError("You can't prep a 1:1 for this person.");
  // Rate limit (each refresh can cost an AI call): within the cooldown the cached brief comes back unchanged.
  if (Date.now() - brief.createdAt.getTime() > 10_000) throw new UserError("This brief was refreshed a moment ago — try again in a couple of minutes.");
  await audit({ actorId: user.id, action: "brief.one_on_one.refresh", entity: "user", entityId: repId, after: { periodKey: brief.periodKey, engine: brief.engine } });
  revalidatePath(`/team/1-1/${repId}`);
  return { engine: brief.engine };
});
