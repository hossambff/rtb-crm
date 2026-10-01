/**
 * Block Kit message builders — pure, unit tested (src/lib/slack/__tests__/blocks.test.ts).
 *
 * MNPI rule (docs/V2_SPEC.md §0.4): restricted records never reach Slack. Every builder that can describe a deal takes
 * a `restricted` flag and, when it is set, renders a neutral placeholder with only a link into the app (where the
 * normal access checks apply). Callers additionally skip channel posts for restricted records entirely.
 */
import { appLink, escapeMrkdwn, plain, truncate } from "./core";

export type Block = Record<string, unknown>;
export type SlackMessage = { text: string; blocks: Block[] };

export const ACTION_APPROVE = "approval:approve";
export const ACTION_REJECT = "approval:reject";
export const ACTION_OPEN = "open_app";
export const REJECT_CALLBACK = "approval_reject";
export const REJECT_BLOCK = "reason_block";
export const REJECT_INPUT = "reason";

const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text: truncate(text, 2900) } });
const context = (text: string): Block => ({ type: "context", elements: [{ type: "mrkdwn", text: truncate(text, 2900) }] });
const header = (text: string): Block => ({ type: "header", text: { type: "plain_text", text: plain(text, 150), emoji: false } });
const openButton = (url: string, label = "Open in Roundtable"): Block => ({
  type: "button",
  action_id: ACTION_OPEN,
  text: { type: "plain_text", text: plain(label, 75) },
  url,
});
const link = (url: string | null, label: string) => (url ? `<${url}|${escapeMrkdwn(label).replace(/\|/g, "/")}>` : escapeMrkdwn(label));

/* ───────────── Notifications (DMs) ───────────── */

export type NoticeInput = { kind: string; title: string; body?: string | null; href?: string | null; severity?: string | null };

const SEVERITY_PREFIX: Record<string, string> = { critical: "Critical", serious: "Serious", warning: "Warning" };

export function noticeMessage(n: NoticeInput, appUrl: string): SlackMessage {
  const url = appLink(appUrl, n.href);
  const sev = n.severity ? SEVERITY_PREFIX[n.severity] : undefined;
  const title = `${sev ? `${sev} · ` : ""}${n.title}`;
  const blocks: Block[] = [section(`*${escapeMrkdwn(truncate(title, 300))}*${n.body ? `\n${escapeMrkdwn(truncate(n.body, 600))}` : ""}`)];
  if (url) blocks.push({ type: "actions", elements: [openButton(url)] });
  return { text: truncate(title, 300), blocks };
}

/* ───────────── Approvals ───────────── */

export type ApprovalCard = {
  id: string;
  kindLabel: string;
  /** Permission-aware subject label for the recipient. Ignored when `restricted`. */
  label: string | null;
  requesterName: string | null;
  /** Short scalar summary (requested %, amount, reason). Ignored when `restricted`. */
  detail?: string | null;
  note?: string | null;
  waiting?: string | null; // "waiting 3h"
  dueLabel?: string | null; // "due in 5h" | "overdue by 2h"
  overdue?: boolean;
  escalated?: boolean;
  restricted: boolean;
  href: string;
};

/** An approval DM. Restricted subjects get no buttons (decide in the app, where the content is visible). */
export function approvalMessage(a: ApprovalCard, appUrl: string): SlackMessage {
  const url = appLink(appUrl, a.href);
  const prefix = a.escalated ? "Escalated approval" : a.overdue ? "Overdue approval" : "Approval requested";
  if (a.restricted) {
    return {
      text: `${prefix}: ${a.kindLabel} on a restricted record`,
      blocks: [
        section(`*${escapeMrkdwn(prefix)}* · ${escapeMrkdwn(a.kindLabel)} on a restricted record`),
        context("Restricted (MNPI) details are never shown in Slack. Review it in Roundtable."),
        ...(url ? [{ type: "actions", elements: [openButton(url, "Review in Roundtable")] }] : []),
      ],
    };
  }
  const subject = a.label ? escapeMrkdwn(truncate(a.label, 200)) : "a request";
  const lines = [`*${escapeMrkdwn(prefix)}* · ${escapeMrkdwn(a.kindLabel)}`, subject];
  if (a.detail) lines.push(escapeMrkdwn(truncate(a.detail, 300)));
  if (a.note) lines.push(`> ${escapeMrkdwn(truncate(a.note, 400)).replace(/\n/g, "\n> ")}`);
  const meta = [a.requesterName ? `Requested by ${escapeMrkdwn(a.requesterName)}` : null, a.waiting, a.dueLabel].filter(Boolean).join(" · ");
  return {
    text: `${prefix}: ${a.kindLabel} · ${truncate(a.label ?? "request", 120)}`,
    blocks: [
      section(lines.join("\n")),
      ...(meta ? [context(meta)] : []),
      {
        type: "actions",
        block_id: `approval:${a.id}`,
        elements: [
          { type: "button", action_id: ACTION_APPROVE, style: "primary", value: a.id, text: { type: "plain_text", text: "Approve" } },
          { type: "button", action_id: ACTION_REJECT, style: "danger", value: a.id, text: { type: "plain_text", text: "Reject…" } },
          ...(url ? [openButton(url, "Open")] : []),
        ],
      },
    ],
  };
}

export type DecidedCard = {
  kindLabel: string;
  label: string | null;
  status: string; // approved | rejected | failed | …
  deciderName: string | null;
  restricted: boolean;
  href: string;
  note?: string | null;
};

const STATUS_WORD: Record<string, string> = { approved: "Approved", rejected: "Rejected", failed: "Failed to apply", pending: "Pending", withdrawn: "Withdrawn", superseded: "Superseded" };

/** The word a decided card shows: withdrawn / superseded requests are stored as "rejected" with a marker note. */
export function decidedCardStatus(status: string, note: string | null | undefined): string {
  if (status !== "rejected" || !note) return status;
  if (/(^|\n)(Override withdrawn|Withdrawn)\b/.test(note)) return "withdrawn";
  if (/(^|\n)Superseded\b/.test(note)) return "superseded";
  return status;
}

/** Replaces the buttons once a request is decided (by anyone, from Slack or the app). */
export function approvalDecidedMessage(d: DecidedCard, appUrl: string): SlackMessage {
  const url = appLink(appUrl, d.href);
  const word = STATUS_WORD[d.status] ?? d.status;
  const subject = d.restricted ? "a restricted record" : escapeMrkdwn(truncate(d.label ?? "request", 200));
  const by = d.deciderName ? ` by ${escapeMrkdwn(d.deciderName)}` : "";
  const lines = [`*${escapeMrkdwn(word)}*${by} · ${escapeMrkdwn(d.kindLabel)}`, subject];
  if (d.note && !d.restricted) lines.push(`> ${escapeMrkdwn(truncate(d.note, 300))}`);
  return {
    text: `${word}${d.deciderName ? ` by ${d.deciderName}` : ""}: ${d.kindLabel}`,
    blocks: [section(lines.join("\n")), ...(url ? [context(link(url, "View in Roundtable"))] : [])],
  };
}

/** Modal asking for the (required) rejection reason. `metadata` is echoed back in view_submission. */
export function rejectModal(p: { kindLabel: string; label: string | null; restricted: boolean; metadata: string }): Block {
  return {
    type: "modal",
    callback_id: REJECT_CALLBACK,
    private_metadata: p.metadata,
    title: { type: "plain_text", text: "Reject request" },
    submit: { type: "plain_text", text: "Reject" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      section(`${escapeMrkdwn(p.kindLabel)} · ${p.restricted ? "restricted record" : escapeMrkdwn(truncate(p.label ?? "request", 200))}`),
      {
        type: "input",
        block_id: REJECT_BLOCK,
        label: { type: "plain_text", text: "Reason (shared with the requester)" },
        element: { type: "plain_text_input", action_id: REJECT_INPUT, multiline: true, min_length: 1, max_length: 1000 },
      },
    ],
  };
}

/** A read-only modal explaining why an action can't continue (replaces the reject modal after the post-open checks). */
export function infoModal(text: string): Block {
  return {
    type: "modal",
    title: { type: "plain_text", text: "Reject request" },
    close: { type: "plain_text", text: "Close" },
    blocks: [section(escapeMrkdwn(truncate(text, 600)))],
  };
}

/* ───────────── /rtb deal ───────────── */

/** Only allow-listed, permission-filtered, non-restricted facts. The builder never sees restricted deals' data. */
export type DealSummary = {
  name: string;
  accountName: string | null;
  pipelineKey: string;
  stageName: string;
  status: string;
  ownerName: string | null;
  value: string | null; // already formatted & field-security filtered ("12.4M MUU · $1.2M/yr")
  expectedClose: string | null; // formatted
  nextStep: string | null;
  nextStepDue: string | null; // formatted
  nextStepOverdue: boolean;
  health: number | null;
  href: string;
};

export function dealSummaryMessage(d: DealSummary, appUrl: string, others: { name: string; href: string }[] = []): SlackMessage {
  const url = appLink(appUrl, d.href);
  const fields: Block[] = [
    { type: "mrkdwn", text: `*Stage*\n${escapeMrkdwn(d.stageName)}${d.status !== "open" ? ` (${escapeMrkdwn(d.status)})` : ""}` },
    { type: "mrkdwn", text: `*Owner*\n${escapeMrkdwn(d.ownerName ?? "Unassigned")}` },
  ];
  if (d.value) fields.push({ type: "mrkdwn", text: `*Value*\n${escapeMrkdwn(d.value)}` });
  if (d.expectedClose) fields.push({ type: "mrkdwn", text: `*Expected close*\n${escapeMrkdwn(d.expectedClose)}` });
  if (d.health != null) fields.push({ type: "mrkdwn", text: `*Health*\n${Math.round(d.health)}/100` });
  const next = d.nextStep
    ? `*Next step:* ${escapeMrkdwn(truncate(d.nextStep, 300))}${d.nextStepDue ? ` · ${d.nextStepOverdue ? "overdue since" : "due"} ${escapeMrkdwn(d.nextStepDue)}` : ""}`
    : "*Next step:* none set";
  const blocks: Block[] = [
    section(`*${link(url, d.name)}* · ${escapeMrkdwn(d.pipelineKey)}${d.accountName && d.accountName !== d.name ? `\n${escapeMrkdwn(d.accountName)}` : ""}`),
    { type: "section", fields: fields.slice(0, 10) },
    section(next),
  ];
  if (others.length) {
    const list = others
      .slice(0, 5)
      .map((o) => link(appLink(appUrl, o.href), truncate(o.name, 80)))
      .join(" · ");
    blocks.push(context(`Also matching: ${list}`));
  }
  return { text: `${d.name} · ${d.stageName}`, blocks };
}

export function textMessage(text: string): SlackMessage {
  return { text: truncate(text, 300), blocks: [section(escapeMrkdwn(text))] };
}

export function helpMessage(): SlackMessage {
  return {
    text: "Roundtable commands",
    blocks: [
      section("*Roundtable commands*\n`/rtb deal <name>` — status, owner and next step of a deal you can see\n`/rtb approvals` — what is waiting on you\n`/rtb help` — this message"),
      context("Answers are visible only to you. Restricted (MNPI) records are never shown in Slack."),
    ],
  };
}

/* ───────────── Channel posts ───────────── */

export type CommentPost = { authorName: string | null; dealName: string; body: string; href: string; restricted: boolean };

/** Deal comment mirrored to the pipeline's deal channel. Returns null for restricted deals (never posted). */
export function commentMessage(c: CommentPost, appUrl: string): SlackMessage | null {
  if (c.restricted) return null;
  const url = appLink(appUrl, c.href);
  const who = escapeMrkdwn(c.authorName ?? "Someone");
  return {
    text: `${c.authorName ?? "Someone"} commented on ${c.dealName}`,
    blocks: [section(`*${who}* on ${link(url, c.dealName)}\n${escapeMrkdwn(truncate(c.body, 1200))}`)],
  };
}

export type TeamPostCard = { kind: string; title: string; body: string | null; authorName: string | null; href: string; restricted: boolean; tags?: string[] };

const POST_KIND: Record<string, { label: string; byline: string }> = {
  win: { label: "Win", byline: "Story by" },
  loss: { label: "Loss", byline: "Lessons shared by" },
  announcement: { label: "Announcement", byline: "Posted by" },
  recap: { label: "Pipeline review recap", byline: "Review led by" },
};

/** Which card a post renders as: pipeline-review recaps are announcements tagged "review". Pure. */
export function teamPostKind(p: Pick<TeamPostCard, "kind" | "tags">): string {
  return p.kind === "announcement" && p.tags?.includes("review") ? "recap" : p.kind;
}

/** Team-feed post for the wins channel, per kind. Null for restricted posts and kinds that never leave the app (clips). */
export function teamPostMessage(p: TeamPostCard, appUrl: string): SlackMessage | null {
  const kind = POST_KIND[teamPostKind(p)];
  if (p.restricted || !kind) return null;
  const url = appLink(appUrl, p.href);
  const blocks: Block[] = [header(`${kind.label}: ${p.title}`)];
  if (p.body) blocks.push(section(escapeMrkdwn(truncate(p.body, 2000))));
  blocks.push(context([p.authorName ? `${kind.byline} ${escapeMrkdwn(p.authorName)}` : null, url ? link(url, "Read in Roundtable") : null].filter(Boolean).join(" · ")));
  return { text: `${kind.label}: ${p.title}`, blocks };
}

export type ChannelAlert = { title: string; href: string | null; ruleCode: string };

/**
 * Critical alerts for the configured alerts channel (QA MAJ-16). Callers pass only non-restricted alerts (the sweep
 * resolves each alert's deal/account and drops sensitive ones). Null when there is nothing to post.
 */
export function alertsChannelMessage(alerts: ChannelAlert[], appUrl: string, max = 10): SlackMessage | null {
  if (!alerts.length) return null;
  const lines = alerts.slice(0, max).map((a) => `• ${link(appLink(appUrl, a.href), truncate(a.title, 160))} _(${escapeMrkdwn(a.ruleCode)})_`);
  if (alerts.length > max) lines.push(`…and ${alerts.length - max} more in Roundtable`);
  const head = `${alerts.length} critical alert${alerts.length === 1 ? "" : "s"}`;
  return {
    text: `Critical · ${head}`,
    blocks: [section(`*Critical* · ${head}\n${lines.join("\n")}`), context("Restricted (MNPI) records are never posted to Slack.")],
  };
}

export type ChannelDigest = {
  dateLabel: string;
  approvalsPending: number;
  approvalsOverdue: number;
  wins: { name: string; href: string }[]; // non-restricted only
  newDeals: number;
};

export function channelDigestMessage(d: ChannelDigest, appUrl: string): SlackMessage {
  const wins = d.wins.length
    ? d.wins
        .slice(0, 8)
        .map((w) => `• ${link(appLink(appUrl, w.href), truncate(w.name, 80))}`)
        .join("\n")
    : "No closed-won deals yesterday.";
  return {
    text: `Roundtable daily · ${d.dateLabel}`,
    blocks: [
      header(`Roundtable daily · ${d.dateLabel}`),
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Approvals waiting*\n${d.approvalsPending}${d.approvalsOverdue ? ` (${d.approvalsOverdue} overdue)` : ""}` },
          { type: "mrkdwn", text: `*New deals yesterday*\n${d.newDeals}` },
        ],
      },
      section(`*Won yesterday*\n${wins}`),
      context("Restricted (MNPI) records are excluded from Slack."),
    ],
  };
}
