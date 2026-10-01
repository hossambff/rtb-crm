import "server-only";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { approvalDetail, approvalKindLabel } from "@/lib/approvals/kinds";
import { canDecide, getApprovalHandler, type ApprovalRow } from "@/lib/approvals/registry";
import { decide } from "@/lib/approvals/service";
import { effectiveDueAt, getSlaSettings } from "@/lib/approvals/sla";
import { slaStatus } from "@/lib/approvals/sla-core";
import { logServerError } from "@/lib/errors";
import { ForbiddenError, type AppUser } from "@/lib/rbac/server";
import { approvalDecidedMessage, approvalMessage, decidedCardStatus, type SlackMessage } from "./blocks";
import { logSlack, slackCall } from "./client";
import { getSlackContext } from "./config";
import { appUserById } from "./identity";
import { approvalHref, isUuid } from "./core";

/** Does an approval concern a restricted (MNPI) deal or account? Then Slack only ever gets a neutral link. */
export async function approvalIsRestricted(a: ApprovalRow): Promise<boolean> {
  try {
    const dealIds = new Set<string>();
    if (Array.isArray(a.payload?.dealIds)) for (const x of a.payload.dealIds as unknown[]) if (isUuid(x)) dealIds.add(x);
    if (a.entity === "deal" && isUuid(a.entityId)) dealIds.add(a.entityId);
    if (a.entity === "proposal" && isUuid(a.entityId)) {
      const [p] = await db.select({ dealId: s.proposals.dealId }).from(s.proposals).where(eq(s.proposals.id, a.entityId));
      if (p) dealIds.add(p.dealId);
    }
    if (dealIds.size) {
      const rows = await db
        .select({ r: s.deals.restricted, ar: s.accounts.restricted })
        .from(s.deals)
        .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
        .where(inArray(s.deals.id, [...dealIds].slice(0, 500)));
      if (rows.some((r) => r.r || r.ar)) return true;
    }
    let accountId: string | null = a.entity === "account" && isUuid(a.entityId) ? a.entityId : null;
    if (a.kind === "lead_registration" && isUuid(a.entityId)) {
      const [r] = await db.select({ accountId: s.leadRegistrations.accountId }).from(s.leadRegistrations).where(eq(s.leadRegistrations.id, a.entityId));
      accountId = r?.accountId ?? accountId;
    }
    if (accountId) {
      const [acc] = await db.select({ r: s.accounts.restricted }).from(s.accounts).where(eq(s.accounts.id, accountId));
      if (acc?.r) return true;
    }
    return false;
  } catch {
    return true; // fail closed
  }
}

async function userName(id: string | null): Promise<string | null> {
  if (!id) return null;
  const [u] = await db.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, id));
  return u?.name ?? null;
}

/**
 * The Slack message for `user` about approval `a`: buttons when the request is pending and the user may decide it
 * (same canDecide as the app: role/handler rule + separation of duties), the decided state otherwise, and a neutral
 * card for restricted subjects. Returns null when the user has nothing to see.
 */
export async function approvalMessageFor(user: AppUser, a: ApprovalRow, appUrl: string): Promise<SlackMessage | null> {
  const restricted = await approvalIsRestricted(a);
  const kindLabel = approvalKindLabel(a.kind);
  const h = getApprovalHandler(a.kind);
  const label = restricted ? null : h.label ? await h.label(user, a).catch(() => null) : null;
  const href = approvalHref(a.id);
  if (a.status !== "pending") {
    return approvalDecidedMessage({ kindLabel, label, status: decidedCardStatus(a.status, a.note), deciderName: await userName(a.decidedBy), restricted, href }, appUrl);
  }
  if (!(await canDecide(user, a))) return null;
  const settings = await getSlaSettings();
  const sla = slaStatus({ createdAt: a.createdAt, dueAt: effectiveDueAt(a, settings) });
  return approvalMessage(
    {
      id: a.id,
      kindLabel,
      label,
      requesterName: a.requestedBy.startsWith("system:") ? "System import" : await userName(a.requestedBy),
      detail: approvalDetail(a.payload),
      note: a.note,
      waiting: `waiting ${sla.waiting}`,
      dueLabel: sla.dueLabel,
      overdue: sla.state === "overdue",
      escalated: Boolean(a.escalatedAt),
      restricted,
      href,
    },
    appUrl,
  );
}

export type SlackDecisionResult = { ok: true; message: SlackMessage } | { ok: false; error: string; message?: SlackMessage };

/**
 * Decide through THE approvals service (permission + SoD + handler side effects + audit + notifications), acting as
 * the mapped app user. Returns the message to show in place of the buttons, or an error for the clicker only.
 */
export async function decideFromSlack(user: AppUser, approvalId: string, decision: "approved" | "rejected", note: string | null, appUrl: string): Promise<SlackDecisionResult> {
  if (!isUuid(approvalId)) return { ok: false, error: "Unknown request." };
  const [a] = await db.select().from(s.approvals).where(eq(s.approvals.id, approvalId));
  if (!a) return { ok: false, error: "This request no longer exists." };
  if (a.status === "pending" && (await approvalIsRestricted(a))) {
    return { ok: false, error: "Restricted (MNPI) requests can only be decided in Roundtable." };
  }
  try {
    await decide(user, approvalId, decision, note);
  } catch (e) {
    const [now] = await db.select().from(s.approvals).where(eq(s.approvals.id, approvalId));
    const current = now ? await approvalMessageFor(user, now, appUrl).catch(() => null) : null;
    if (e instanceof UserError || e instanceof ForbiddenError) return { ok: false, error: e.message, message: current ?? undefined };
    logServerError("slack.decide", e);
    return { ok: false, error: "Something went wrong while applying the decision. Check the request in Roundtable.", message: current ?? undefined };
  }
  const [after] = await db.select().from(s.approvals).where(eq(s.approvals.id, approvalId));
  const message = after ? await approvalMessageFor(user, after, appUrl) : null;
  return { ok: true, message: message ?? approvalDecidedMessage({ kindLabel: approvalKindLabel(a.kind), label: null, status: decision, deciderName: user.name, restricted: false, href: approvalHref(a.id) }, appUrl) };
}

const CARD_DEADLINE_MS = 8000;

/**
 * Bring every Slack card posted for these approvals (approvals.slack_messages) up to date after a change made outside
 * that card: decided in the app, escalated, withdrawn or superseded. The card is rebuilt from the viewpoint of the
 * person who acted (decider, else requester) — every original recipient was a decider who could see it; restricted
 * subjects keep their neutral, button-less card. Never throws.
 */
export async function refreshApprovalCards(sel: { ids?: string[]; kind?: string; entityId?: string }): Promise<number> {
  let updated = 0;
  try {
    const ctx = await getSlackContext();
    if (!ctx) return 0;
    const conds = [sql`jsonb_array_length(${s.approvals.slackMessages}) > 0`];
    if (sel.ids?.length) conds.push(inArray(s.approvals.id, sel.ids.slice(0, 50)));
    else if (sel.kind && sel.entityId)
      // the rows just closed by a kind/subject-wide update (supersede, withdraw, record-page decision)
      conds.push(eq(s.approvals.kind, sel.kind), eq(s.approvals.entityId, sel.entityId), gte(s.approvals.decidedAt, new Date(Date.now() - 10 * 60_000)));
    else return 0;
    const rows = await db.select().from(s.approvals).where(and(...conds)).limit(20);
    const deadline = Date.now() + CARD_DEADLINE_MS;
    for (const a of rows) {
      const viewerId = a.decidedBy ?? (a.requestedBy.startsWith("system:") ? null : a.requestedBy);
      const viewer = viewerId ? await appUserById(viewerId) : null;
      const msg = await approvalCardSnapshot(a, viewer, ctx.appUrl);
      for (const ref of a.slackMessages.slice(0, 50)) {
        if (Date.now() > deadline) return updated;
        const r = await slackCall(ctx.token, "chat.update", { channel: ref.channel, ts: ref.ts, text: msg.text, blocks: msg.blocks });
        if (r.ok) updated++;
        else logSlack("chat.update", r.error);
      }
    }
  } catch {
    logSlack("approval_cards", "refresh_failed");
  }
  return updated;
}

/** The card everyone sees after a change: decided state, or (still pending, e.g. escalated) the request with buttons. */
async function approvalCardSnapshot(a: ApprovalRow, viewer: AppUser | null, appUrl: string): Promise<SlackMessage> {
  const restricted = await approvalIsRestricted(a);
  const kindLabel = approvalKindLabel(a.kind);
  const h = getApprovalHandler(a.kind);
  const label = restricted || !viewer || !h.label ? null : await h.label(viewer, a).catch(() => null);
  const href = approvalHref(a.id);
  if (a.status !== "pending")
    return approvalDecidedMessage({ kindLabel, label, status: decidedCardStatus(a.status, a.note), deciderName: await userName(a.decidedBy), restricted, href }, appUrl);
  const sla = slaStatus({ createdAt: a.createdAt, dueAt: effectiveDueAt(a, await getSlaSettings()) });
  return approvalMessage(
    {
      id: a.id,
      kindLabel,
      label,
      requesterName: a.requestedBy.startsWith("system:") ? "System import" : await userName(a.requestedBy),
      detail: approvalDetail(a.payload),
      note: a.note,
      waiting: `waiting ${sla.waiting}`,
      dueLabel: sla.dueLabel,
      overdue: sla.state === "overdue",
      escalated: Boolean(a.escalatedAt),
      restricted,
      href,
    },
    appUrl,
  );
}
