import "server-only";
import { googleFetch } from "@/lib/integrations/google";
import { getMessage, listMessages, sendMessage } from "@/lib/gmail/client";
import { buildRawEmail } from "@/lib/gmail/mime";
import { encodeBase64Url, header, parseGmailMessage, stripQuoted, type GmailMessage } from "@/lib/gmail/parse";
import { isAutoReply, isBounceSender, isUnsubscribeReply } from "./core";

/**
 * Gmail I/O for the sequence runner (send, reconcile, live reply/bounce checks). Uses the shared Gmail REST helpers
 * (src/lib/gmail/client.ts); everything here runs with the SENDER's own token.
 */
const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export type OutgoingSequenceEmail = {
  from: string;
  fromName: string | null;
  to: string;
  subject: string;
  body: string;
  messageId: string; // our own Message-ID (see makeMessageId) — lets a crashed send be found again
  inReplyTo: string | null;
  references: string | null;
  threadId: string | null;
};

/** RFC 2822 message with our Message-ID header prepended (buildRawEmail never sets one). */
export function rawWithMessageId(msg: OutgoingSequenceEmail): string {
  const raw = buildRawEmail({ from: msg.from, fromName: msg.fromName, to: [msg.to], subject: msg.subject, body: msg.body, inReplyTo: msg.inReplyTo, references: msg.references });
  const id = msg.messageId.replace(/[\r\n]/g, "");
  return encodeBase64Url(`Message-ID: ${id}\r\n${raw}`);
}

export async function sendSequenceEmail(token: string, msg: OutgoingSequenceEmail): Promise<{ id: string; threadId: string }> {
  const sent = await sendMessage(token, rawWithMessageId(msg), msg.threadId);
  return { id: sent.id, threadId: sent.threadId };
}

/** The Message-ID header Gmail actually stored for a sent message (falls back to ours if Gmail kept it). */
export async function storedMessageIdHeader(token: string, gmailId: string): Promise<string | null> {
  try {
    const p = parseGmailMessage(await getMessage(token, gmailId, "metadata"));
    return p.messageIdHeader ?? null;
  } catch {
    return null;
  }
}

/**
 * Was the message for a recorded send intent actually sent? Looks it up by our Message-ID first, then by recipient +
 * subject in Sent after the intent time. Returns null when not found. Throws on Gmail errors (caller must NOT resend).
 */
export async function findSentMessage(
  token: string,
  opts: { messageId: string; to: string; subject: string; afterMs: number },
): Promise<{ id: string; threadId: string; messageIdHeader: string | null } | null> {
  const bare = opts.messageId.replace(/^<|>$/g, "");
  const byId = await listMessages(token, { q: `rfc822msgid:${bare}`, maxResults: 5 });
  const hit = byId.messages?.[0];
  if (hit) return { id: hit.id, threadId: hit.threadId, messageIdHeader: (await storedMessageIdHeader(token, hit.id)) ?? opts.messageId };
  const after = Math.floor(opts.afterMs / 1000) - 120;
  const q = `in:sent to:(${opts.to.replace(/[()"\s]/g, "")}) after:${after}`;
  const list = await listMessages(token, { q, maxResults: 10 });
  const wanted = opts.subject.trim().toLowerCase();
  let first: { id: string; threadId: string; messageIdHeader: string | null } | null = null;
  for (const ref of (list.messages ?? []).slice(0, 10)) {
    const p = parseGmailMessage(await getMessage(token, ref.id, "metadata"));
    const hit = { id: ref.id, threadId: ref.threadId, messageIdHeader: p.messageIdHeader };
    if ((p.subject ?? "").trim().toLowerCase() === wanted) return hit;
    first ??= hit;
  }
  // Err on the side of NOT double-sending: any mail to this person since the intent counts as "already sent".
  return first;
}

export type LiveReplyCheck = { replied: boolean; bounced: boolean; unsubscribe: boolean };

const AUTO_HEADERS = ["Auto-Submitted", "X-Autoreply", "X-Autorespond", "Precedence"];

/** Out-of-office / auto-responder? (headers from a metadata or full fetch) */
function autoReply(m: GmailMessage): boolean {
  const h = m.payload?.headers;
  return isAutoReply({
    autoSubmitted: header(h, "Auto-Submitted"),
    xAutoreply: header(h, "X-Autoreply"),
    xAutorespond: header(h, "X-Autorespond"),
    precedence: header(h, "Precedence"),
    subject: header(h, "Subject"),
  });
}

/** Inbound messages (not sent by the mailbox) in our thread since `sinceMs`: reply, bounce (DSN) or unsubscribe. */
export async function checkThread(token: string, threadId: string, senderEmail: string, sinceMs: number): Promise<LiveReplyCheck> {
  const p = new URLSearchParams({ format: "metadata" });
  for (const h of ["From", "Subject", "Date", ...AUTO_HEADERS]) p.append("metadataHeaders", h);
  const t = await googleFetch<{ messages?: GmailMessage[] }>(token, `${BASE}/threads/${encodeURIComponent(threadId)}?${p}`);
  const out: LiveReplyCheck = { replied: false, bounced: false, unsubscribe: false };
  const me = senderEmail.toLowerCase();
  for (const m of t.messages ?? []) {
    const parsed = parseGmailMessage(m);
    const at = Number(m.internalDate ?? 0);
    if (at && at < sinceMs) continue;
    if (parsed.labelIds.includes("SENT") || parsed.from === me) continue;
    if (isBounceSender(parsed.from) || isBounceSender(parsed.fromName)) out.bounced = true;
    else if (autoReply(m)) continue; // out-of-office is not a reply (CR L15)
    else {
      out.replied = true;
      if (isUnsubscribeReply(m.snippet ?? "")) out.unsubscribe = true;
    }
  }
  return out;
}

/** Any message FROM the contact since `sinceMs` (any thread) — catches replies that started a new thread. */
export async function searchRepliesFrom(token: string, contactEmail: string, sinceMs: number): Promise<LiveReplyCheck> {
  const email = contactEmail.replace(/[()"\s]/g, "");
  const list = await listMessages(token, { q: `from:(${email}) after:${Math.floor(sinceMs / 1000)} -in:sent -in:chats`, maxResults: 3 });
  const out: LiveReplyCheck = { replied: false, bounced: false, unsubscribe: false };
  for (const ref of list.messages ?? []) {
    let msg: GmailMessage | null = null;
    try {
      msg = await getMessage(token, ref.id, "full");
    } catch {
      /* can't read it: the reply itself is enough to exit (err on the side of not emailing) */
    }
    if (msg && autoReply(msg)) continue; // out-of-office: keep looking
    out.replied = true;
    if (msg && isUnsubscribeReply(stripQuoted(parseGmailMessage(msg).bodyText))) out.unsubscribe = true;
    break;
  }
  return out;
}
