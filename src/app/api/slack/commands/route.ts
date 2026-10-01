import { NextResponse, after } from "next/server";
import { audit } from "@/lib/audit";
import { postToResponseUrl } from "@/lib/slack/client";
import { runRtbCommand } from "@/lib/slack/commands";
import { getSlackContext } from "@/lib/slack/config";
import { isSlackResponseUrl, isSlackTeamId, isSlackUserId } from "@/lib/slack/core";
import { ephemeral, readVerifiedSlackRequest } from "@/lib/slack/http";
import { appUserForSlack } from "@/lib/slack/identity";
import { logServerError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * `/rtb` slash command. Signature-verified; acknowledged immediately (empty 200 = nothing posted to the channel) and
 * answered ephemerally through the response_url once the permission-checked lookup is done.
 */
export async function POST(req: Request) {
  const v = await readVerifiedSlackRequest(req);
  if (!v.ok) return v.res;
  const f = v.form;
  const teamId = f.get("team_id");
  if (v.teamId && (!isSlackTeamId(teamId) || teamId !== v.teamId)) return ephemeral("This Slack workspace isn't connected to Roundtable.");
  const slackUserId = f.get("user_id");
  const responseUrl = f.get("response_url");
  if (!isSlackUserId(slackUserId) || !isSlackResponseUrl(responseUrl)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const ctx = await getSlackContext();
  if (!ctx) return ephemeral("Roundtable isn't fully connected to Slack yet. Ask an admin to finish setup in Admin → Slack.");
  const text = (f.get("text") ?? "").slice(0, 200);

  after(async () => {
    try {
      const user = await appUserForSlack(slackUserId, ctx.token);
      if (!user) {
        await postToResponseUrl(responseUrl, {
          response_type: "ephemeral",
          text: "Your Slack account isn't linked to a Roundtable user (we match by email). Ask an admin to map it in Admin → Slack.",
        });
        return;
      }
      const msg = await runRtbCommand(user, text, ctx.appUrl);
      await postToResponseUrl(responseUrl, { response_type: "ephemeral", replace_original: false, text: msg.text, blocks: msg.blocks });
      await audit({ actorId: user.id, action: "slack.command", entity: "slack", entityId: "rtb", after: { command: text.split(" ")[0]?.slice(0, 20) ?? "" } });
    } catch (e) {
      logServerError("slack.command", e);
      await postToResponseUrl(responseUrl, { response_type: "ephemeral", text: "Something went wrong. Try again in a moment." });
    }
  });
  return new NextResponse(null, { status: 200 });
}
