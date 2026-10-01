"use server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, ForbiddenError } from "@/lib/rbac/server";
import { buildMeetingBrief } from "./meeting";

/** Build (or refresh) the brief for one of my meetings on demand. No notification — I'm already looking at it. */
export const prepareBriefNow = action(z.object({ meetingId: z.uuid() }), async ({ meetingId }, user) => {
  await assertCan(user, "calls", "view");
  const [m] = await db.select().from(s.meetings).where(eq(s.meetings.id, meetingId));
  if (!m) throw new UserError("Meeting not found.");
  if (m.ownerId !== user.id) throw new ForbiddenError("Briefs are prepared for the meeting owner.");
  // manual "Prepare now" works for unlinked external meetings too (the automatic run skips those)
  const { brief } = await buildMeetingBrief(m, user);
  if (!brief) throw new UserError("This meeting has no external attendees, so there's nothing to brief.");
  await audit({ actorId: user.id, action: "meeting.brief_prepare", entity: "meeting", entityId: meetingId, after: { engine: brief.engine } });
  revalidatePath(`/calls/briefs/${meetingId}`);
  revalidatePath("/calls");
  return { engine: brief.engine };
});
