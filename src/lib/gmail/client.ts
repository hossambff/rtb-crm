import "server-only";
import { googleFetch } from "@/lib/integrations/google";
import type { GmailMessage } from "./parse";

/** Thin Gmail REST v1 wrappers (no googleapis dependency). https://developers.google.com/gmail/api/reference/rest */
const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export type MessageRef = { id: string; threadId: string };

export function getProfile(token: string) {
  return googleFetch<{ emailAddress: string; historyId: string; messagesTotal?: number }>(token, `${BASE}/profile`);
}

export function listMessages(token: string, opts: { q: string; pageToken?: string | null; maxResults?: number }) {
  const p = new URLSearchParams({ q: opts.q, maxResults: String(opts.maxResults ?? 100), includeSpamTrash: "false" });
  if (opts.pageToken) p.set("pageToken", opts.pageToken);
  return googleFetch<{ messages?: MessageRef[]; nextPageToken?: string; resultSizeEstimate?: number }>(token, `${BASE}/messages?${p}`);
}

export const METADATA_HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-ID", "References"];

export function getMessage(token: string, id: string, format: "full" | "metadata" = "full") {
  const p = new URLSearchParams({ format });
  if (format === "metadata") for (const h of METADATA_HEADERS) p.append("metadataHeaders", h);
  return googleFetch<GmailMessage>(token, `${BASE}/messages/${encodeURIComponent(id)}?${p}`);
}

export type HistoryPage = {
  history?: { id: string; messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[] }[];
  nextPageToken?: string;
  historyId?: string;
};

export function listHistory(token: string, startHistoryId: string, pageToken?: string | null) {
  const p = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", maxResults: "500" });
  if (pageToken) p.set("pageToken", pageToken);
  return googleFetch<HistoryPage>(token, `${BASE}/history?${p}`);
}

/**
 * Send. NEVER retried here (CR H-1): Gmail can deliver a message and still answer 5xx. Callers own retries — the
 * sequence runner reconciles its intent ledger against Sent before any second attempt.
 */
export function sendMessage(token: string, raw: string, threadId?: string | null) {
  return googleFetch<{ id: string; threadId: string; labelIds?: string[] }>(
    token,
    `${BASE}/messages/send`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(threadId ? { raw, threadId } : { raw }) },
    0,
  );
}

/**
 * V2 A1: create a draft in the user's mailbox (users.drafts.create; needs gmail.compose). Never sends — the rep reviews
 * and sends from Gmail (or from the app composer). `threadId` keeps a reply in its thread.
 */
export function createDraft(token: string, raw: string, threadId?: string | null) {
  // not retried (CR H-1): a retried create can leave duplicate drafts in the rep's mailbox
  return googleFetch<{ id: string; message: { id: string; threadId: string } }>(
    token,
    `${BASE}/drafts`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: threadId ? { raw, threadId } : { raw } }) },
    0,
  );
}

/** Delete a draft (used by post-call autopilot undo). Idempotent from our side: a 404 means it's already gone. */
export function deleteDraft(token: string, draftId: string) {
  return googleFetch<void>(token, `${BASE}/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" }, 0);
}
