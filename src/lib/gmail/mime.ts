/**
 * Pure RFC 2822 message builder for Gmail users.messages.send (raw = base64url) — unit-tested.
 * Replies keep the thread by passing threadId to the API and setting In-Reply-To / References headers.
 */
import { encodeBase64Url } from "./parse";

export type OutgoingEmail = {
  from: string;
  fromName?: string | null;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
};

/** RFC 2047 encoded-word for non-ASCII header values. */
export function encodeHeaderValue(v: string): string {
  if (/^[\x00-\x7F]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

function sanitizeHeader(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

function formatAddress(email: string, name?: string | null): string {
  const e = sanitizeHeader(email);
  if (!name) return e;
  const n = sanitizeHeader(name).replace(/"/g, "'");
  return /^[\x00-\x7F]*$/.test(n) ? `"${n}" <${e}>` : `${encodeHeaderValue(n)} <${e}>`;
}

export function replySubject(subject: string | null | undefined): string {
  const s = (subject ?? "").trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`.trim();
}

/** Build the References chain for a reply: previous References + the parent Message-ID. */
export function buildReferences(parentReferences: string | null | undefined, parentMessageId: string | null | undefined): string | null {
  const parts = [...(parentReferences ?? "").split(/\s+/), parentMessageId ?? ""].map((s) => s.trim()).filter(Boolean);
  return parts.length ? [...new Set(parts)].join(" ") : null;
}

export function buildRawEmail(msg: OutgoingEmail): string {
  const headers: string[] = [
    `From: ${formatAddress(msg.from, msg.fromName)}`,
    `To: ${msg.to.map((t) => sanitizeHeader(t)).join(", ")}`,
  ];
  if (msg.cc?.length) headers.push(`Cc: ${msg.cc.map((t) => sanitizeHeader(t)).join(", ")}`);
  headers.push(`Subject: ${encodeHeaderValue(sanitizeHeader(msg.subject))}`);
  if (msg.inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeader(msg.inReplyTo)}`);
  if (msg.references) headers.push(`References: ${sanitizeHeader(msg.references)}`);
  headers.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
  const body = Buffer.from(msg.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

export function buildRawEmailBase64Url(msg: OutgoingEmail): string {
  return encodeBase64Url(buildRawEmail(msg));
}
