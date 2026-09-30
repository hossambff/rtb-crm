/**
 * Pure Gmail REST parsing (users.messages.get format=full|metadata) — unit-tested with fixtures.
 * https://developers.google.com/gmail/api/reference/rest/v1/users.messages
 */
import { normalizeEmail } from "@/lib/integrations/matching-core";

export type GmailHeader = { name: string; value: string };
export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};
export type GmailMessage = {
  id: string;
  threadId: string;
  historyId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
};

export type ParsedMessage = {
  id: string;
  threadId: string;
  historyId: string | null;
  labelIds: string[];
  subject: string | null;
  from: string | null;
  fromName: string | null;
  to: string[];
  cc: string[];
  sentAt: Date | null;
  messageIdHeader: string | null;
  references: string | null;
  snippet: string | null;
  bodyText: string;
};

export function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}
export function encodeBase64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function header(headers: GmailHeader[] | undefined, name: string): string | null {
  const h = headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

/** Split an address-list header respecting quoted display names: `"Doe, Jane" <j@x.com>, b@y.com`. */
export function parseAddressList(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of value) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;
    if (ch === "," && !inQuote && !inAngle) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return [...new Set(out.map((s) => normalizeEmail(s)).filter((e): e is string => Boolean(e)))];
}

export function displayName(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/^\s*"?([^"<]*?)"?\s*</);
  const name = m?.[1]?.trim();
  return name ? name : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Very small HTML → text: drops style/script/head, converts block tags to newlines, decodes common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (ENTITIES[k]) return ENTITIES[k]!;
      if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith("#")) return String.fromCodePoint(Number(k.slice(1)));
      return m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walk(part: GmailPart | undefined, acc: { plain: string[]; html: string[] }) {
  if (!part) return;
  const mime = (part.mimeType ?? "").toLowerCase();
  const isAttachment = Boolean(part.filename) || Boolean(part.body?.attachmentId);
  if (!isAttachment && part.body?.data) {
    if (mime === "text/plain") acc.plain.push(decodeBase64Url(part.body.data));
    else if (mime === "text/html") acc.html.push(decodeBase64Url(part.body.data));
  }
  for (const p of part.parts ?? []) walk(p, acc);
}

/** text/plain body; falls back to stripped HTML. */
export function extractBody(payload: GmailPart | undefined): string {
  const acc = { plain: [] as string[], html: [] as string[] };
  walk(payload, acc);
  const text = acc.plain.length ? acc.plain.join("\n") : acc.html.length ? htmlToText(acc.html.join("\n")) : "";
  return text.replace(/\r\n/g, "\n").trim();
}

export function parseGmailMessage(m: GmailMessage): ParsedMessage {
  const h = m.payload?.headers;
  const fromRaw = header(h, "From");
  const dateHeader = header(h, "Date");
  const internal = m.internalDate ? new Date(Number(m.internalDate)) : null;
  const parsedDate = dateHeader ? new Date(dateHeader) : null;
  const sentAt = internal && !Number.isNaN(internal.getTime()) ? internal : parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null;
  return {
    id: m.id,
    threadId: m.threadId,
    historyId: m.historyId ?? null,
    labelIds: m.labelIds ?? [],
    subject: header(h, "Subject"),
    from: normalizeEmail(fromRaw),
    fromName: displayName(fromRaw),
    to: parseAddressList(header(h, "To")),
    cc: parseAddressList(header(h, "Cc")),
    sentAt,
    messageIdHeader: header(h, "Message-ID") ?? header(h, "Message-Id"),
    references: header(h, "References"),
    snippet: m.snippet ?? null,
    bodyText: extractBody(m.payload),
  };
}

/** Labels that are never ingested. */
export const SKIP_LABELS = new Set(["SPAM", "TRASH", "DRAFT", "CHAT"]);
export function shouldSkipLabels(labels: string[]): boolean {
  return labels.some((l) => SKIP_LABELS.has(l));
}

/** Remove quoted history ("On … wrote:", "> …", Outlook "From: … Sent:" blocks) so analysis only sees the new text. */
export function stripQuoted(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^On .{4,200}wrote:\s*$/.test(line.trim())) break;
    if (/^On .{4,200}$/.test(line.trim()) && /wrote:\s*$/.test(lines[i + 1] ?? "")) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From: .+/.test(line) && lines.slice(i + 1, i + 5).some((l) => /^(Sent|Date): /.test(l))) break;
    if (/^>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

export type Direction = "inbound" | "outbound";
export function messageDirection(p: Pick<ParsedMessage, "from" | "labelIds">, ownerEmails: string[]): Direction {
  if (p.labelIds.includes("SENT")) return "outbound";
  return p.from && ownerEmails.map((e) => e.toLowerCase()).includes(p.from) ? "outbound" : "inbound";
}

/** Awaiting-reply state from the last message: inbound → we owe a reply; outbound → they do. */
export function computeAwaiting(
  messages: { direction: string | null; sentAt: Date | null; intent?: string | null }[],
): "us" | "them" | "none" {
  const sorted = [...messages].filter((m) => m.direction).sort((a, b) => (a.sentAt?.getTime() ?? 0) - (b.sentAt?.getTime() ?? 0));
  const last = sorted[sorted.length - 1];
  if (!last) return "none";
  if (last.direction === "inbound") return last.intent === "ooo" || last.intent === "not_interested" ? "none" : "us";
  return "them";
}
