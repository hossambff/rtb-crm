"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "@/lib/actions";
import { channelsInput, disconnectSlack, mapSlackUsers, saveSlackChannels, sendSlackTest } from "./admin";

/** Non-secret Slack admin actions (secrets go through POST /api/slack/config). Each re-checks admin:configure. */

export const saveSlackChannelsAction = action(channelsInput, async (input, user) => {
  await saveSlackChannels(user, input);
  revalidatePath("/admin/slack");
  return null;
});

export const sendSlackTestAction = action(z.object({ target: z.enum(["alerts", "wins", "digest", "me"]) }), async ({ target }, user) => {
  const msg = await sendSlackTest(user, target);
  revalidatePath("/admin/slack");
  return msg;
});

export const mapSlackUsersAction = action(z.object({}), async (_input, user) => {
  const r = await mapSlackUsers(user);
  revalidatePath("/admin/slack");
  return r;
});

export const disconnectSlackAction = action(z.object({}), async (_input, user) => {
  await disconnectSlack(user);
  revalidatePath("/admin/slack");
  return null;
});
