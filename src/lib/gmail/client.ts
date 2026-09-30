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

export function sendMessage(token: string, raw: string, threadId?: string | null) {
  return googleFetch<{ id: string; threadId: string; labelIds?: string[] }>(token, `${BASE}/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  });
}
