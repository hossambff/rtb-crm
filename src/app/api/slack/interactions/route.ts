import { NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { approvalKindLabel } from "@/lib/approvals/kinds";
import { canDecide, getApprovalHandler } from "@/lib/approvals/registry";
import { approvalIsRestricted, decideFromSlack } from "@/lib/slack/approvals";
import { ACTION_APPROVE, ACTION_REJECT, infoModal, REJECT_BLOCK, REJECT_CALLBACK, REJECT_INPUT, rejectModal, type SlackMessage } from "@/lib/slack/blocks";
import { logSlack, postToResponseUrl, slackCall } from "@/lib/slack/client";
import { getSlackContext } from "@/lib/slack/config";
import { isSlackResponseUrl, isSlackTeamId, isSlackUserId, isUuid } from "@/lib/slack/core";
import { readVerifiedSlackRequest } from "@/lib/slack/http";
import { appUserForSlack } from "@/lib/slack/identity";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Slack interactivity (Approve / Reject buttons, the rejection-reason modal). Every request is signature-verified
 * (v0, 5-minute window, constant-time) before anything is parsed. The Slack user is mapped to an app user and the
 * decision goes through the approvals service, which re-checks permissions and separation of duties. Slack needs an
 * answer within 3 s, so the decision itself runs in `after()` and the message is updated afterwards.
 */

type Payload = {
  type?: string;
  team?: { id?: string };
  user?: { id?: string; team_id?: string };
  trigger_id?: string;
  response_url?: string;
  actions?: { action_id?: string; value?: string }[];
  view?: { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, Record<string, { value?: string | null }>> } };
};

type RejectMeta = { a: string; r?: string };

const ok = () => new NextResponse(null, { status: 200 });

async function tellUser(responseUrl: string | undefined, text: string) {
  if (responseUrl && isSlackResponseUrl(responseUrl)) await postToResponseUrl(responseUrl, { response_type: "ephemeral", replace_original: false, text });
}

async function replaceMessage(responseUrl: string | undefined, msg: SlackMessage) {
  if (responseUrl && isSlackResponseUrl(responseUrl)) await postToResponseUrl(responseUrl, { replace_original: true, text: msg.text, blocks: msg.blocks });
}

export async function POST(req: Request) {
  const v = await readVerifiedSlackRequest(req);
  if (!v.ok) return v.res;

  let p: Payload;
  try {
    p = JSON.parse(v.form.get("payload") ?? "");
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }
  const teamId = p.team?.id ?? p.user?.team_id;
  // Only the connected workspace may act (a signing secret is per app, but an app can be installed in several).
  if (v.teamId && (!isSlackTeamId(teamId) || teamId !== v.teamId)) return ok();
  const slackUserId = p.user?.id;
  if (!isSlackUserId(slackUserId)) return ok();
  const ctx = await getSlackContext();
  if (!ctx) return ok();

  if (p.type === "block_actions") {
    const action = p.actions?.[0];
    const id = action?.value;
    if (!action || (action.action_id !== ACTION_APPROVE && action.action_id !== ACTION_REJECT) || !isUuid(id)) return ok(); // link buttons etc.
    const responseUrl = isSlackResponseUrl(p.response_url) ? p.response_url : undefined;

    if (action.action_id === ACTION_REJECT) {
      // QA MIN-37: trigger_id expires in 3 s — open the reason modal FIRST (no DB / Slack lookups before it), then check
      // identity, permission and restriction in after() and swap the modal for an explanation when the user can't
      // reject. The decision itself is re-checked by the approvals service on submit either way.
      const meta: RejectMeta = { a: id, ...(responseUrl ? { r: responseUrl } : {}) };
      const metadata = JSON.stringify(meta);
      const opened = await slackCall<{ view?: { id?: string } }>(ctx.token, "views.open", {
        trigger_id: p.trigger_id,
        view: rejectModal({ kindLabel: "Approval request", label: null, restricted: false, metadata }),
      });
      if (!opened.ok) {
        logSlack("views.open", opened.error);
        return ok();
      }
      const viewId = typeof opened.view?.id === "string" ? opened.view.id : null;
      after(async () => {
        const fail = async (text: string) => {
          if (viewId) {
            const r = await slackCall(ctx.token, "views.update", { view_id: viewId, view: infoModal(text) });
            if (!r.ok) logSlack("views.update", r.error);
          } else await tellUser(responseUrl, text);
        };
        const user = await appUserForSlack(slackUserId, ctx.token);
        if (!user) return fail("Your Slack account isn't linked to a Roundtable user. Ask an admin to map it in Admin → Slack.");
        const [a] = await db.select().from(s.approvals).where(eq(s.approvals.id, id));
        if (!a || a.status !== "pending") return fail("This request was already decided.");
        if (!(await canDecide(user, a))) return fail("You can't decide this request.");
        if (await approvalIsRestricted(a)) return fail("Restricted (MNPI) requests can only be decided in Roundtable.");
        if (!viewId) return;
        const h = getApprovalHandler(a.kind);
        const label = h.label ? await h.label(user, a).catch(() => null) : null;
        const r = await slackCall(ctx.token, "views.update", { view_id: viewId, view: rejectModal({ kindLabel: approvalKindLabel(a.kind), label, restricted: false, metadata }) });
        if (!r.ok) logSlack("views.update", r.error);
      });
      return ok();
    }

    after(async () => {
      const user = await appUserForSlack(slackUserId, ctx.token);
      if (!user) return tellUser(responseUrl, "Your Slack account isn't linked to a Roundtable user. Ask an admin to map it in Admin → Slack.");
      const r = await decideFromSlack(user, id, "approved", null, ctx.appUrl);
      if (r.message) await replaceMessage(responseUrl, r.message);
      if (!r.ok) await tellUser(responseUrl, r.error);
    });
    return ok();
  }

  if (p.type === "view_submission" && p.view?.callback_id === REJECT_CALLBACK) {
    let meta: RejectMeta | null = null;
    try {
      meta = JSON.parse(p.view.private_metadata ?? "") as RejectMeta;
    } catch {
      meta = null;
    }
    if (!meta || !isUuid(meta.a)) return ok();
    const reason = (p.view.state?.values?.[REJECT_BLOCK]?.[REJECT_INPUT]?.value ?? "").trim();
    if (!reason) return NextResponse.json({ response_action: "errors", errors: { [REJECT_BLOCK]: "Add a reason when rejecting." } });
    const approvalId = meta.a;
    const responseUrl = isSlackResponseUrl(meta.r) ? meta.r : undefined;
    after(async () => {
      const user = await appUserForSlack(slackUserId, ctx.token);
      if (!user) return tellUser(responseUrl, "Your Slack account isn't linked to a Roundtable user.");
      const r = await decideFromSlack(user, approvalId, "rejected", reason.slice(0, 1000), ctx.appUrl);
      if (r.message) await replaceMessage(responseUrl, r.message);
      if (!r.ok) await tellUser(responseUrl, r.error);
    });
    return ok(); // closes the modal
  }

  return ok();
}
