/**
 * Pure participant → CRM matching used by Gmail, Calendar and transcript ingestion (unit-tested).
 * EML-3 relevance filter: only threads involving a known contact email or account domain are ingested;
 * personal webmail domains only match through an exact contact email; blocklisted senders/domains are never logged;
 * internal-only threads (all participants on RTB domains) are skipped.
 */
import { emailDomain, normalizeDomain } from "@/lib/domain";

export const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "zoho.com",
  "yandex.com",
  "mail.com",
]);

export type DirectoryContact = { id: string; email: string | null; altEmails: string[]; accountId: string | null };
export type DirectoryAccount = { id: string; domain: string | null; altDomains: string[] };

export type Directory = {
  contactsByEmail: Map<string, DirectoryContact>;
  accountsByDomain: Map<string, string>;
};

export function buildDirectory(contacts: DirectoryContact[], accounts: DirectoryAccount[]): Directory {
  const contactsByEmail = new Map<string, DirectoryContact>();
  for (const c of contacts) {
    for (const e of [c.email, ...c.altEmails]) {
      const k = normalizeEmail(e);
      if (k && !contactsByEmail.has(k)) contactsByEmail.set(k, c);
    }
  }
  const accountsByDomain = new Map<string, string>();
  for (const a of accounts) {
    for (const d of [a.domain, ...a.altDomains]) {
      const k = normalizeDomain(d);
      if (k && !accountsByDomain.has(k)) accountsByDomain.set(k, a.id);
    }
  }
  return { contactsByEmail, accountsByDomain };
}

/** Extract and lowercase a bare email from "Name <a@b.com>" or "a@b.com". */
export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = String(input).match(/<([^>]+)>/);
  const raw = (m ? m[1]! : String(input)).trim().toLowerCase().replace(/^mailto:/, "");
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(raw) ? raw : null;
}

/** Blocklist entries: "someone@x.com" (exact sender) or "x.com" / "@x.com" (whole domain incl. subdomains). */
export function normalizeBlocklist(entries: string[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    const t = e.trim().toLowerCase();
    if (!t) continue;
    const email = normalizeEmail(t);
    if (email) {
      out.add(email);
      continue;
    }
    const d = normalizeDomain(t.replace(/^@/, "").replace(/^\*\./, ""));
    if (d) out.add(d);
  }
  return [...out].sort();
}

export function isBlocked(email: string, blocklist: string[]): boolean {
  const e = normalizeEmail(email);
  if (!e) return false;
  const d = emailDomain(e);
  return blocklist.some((b) => (b.includes("@") ? b === e : d != null && (d === b || d.endsWith("." + b))));
}

export function isInternal(email: string, internalDomains: string[]): boolean {
  const d = emailDomain(email);
  return d != null && internalDomains.some((i) => d === i || d.endsWith("." + i));
}

export type MatchResult = {
  relevant: boolean;
  reason: "match" | "blocked" | "internal_only" | "no_match" | "no_participants";
  externalEmails: string[];
  contactIds: string[];
  accountId: string | null;
  /** accountId per external email, for later deal selection */
  accountIds: string[];
};

/**
 * Decide whether a set of participants is relevant and which account/contacts they map to.
 * The account is chosen by (1) matched contacts' accounts, then (2) domain matches, by frequency.
 */
export function matchParticipants(
  emails: (string | null | undefined)[],
  dir: Directory,
  opts: { internalDomains: string[]; blocklist: string[]; ownerEmail?: string | null },
): MatchResult {
  const owner = normalizeEmail(opts.ownerEmail);
  const all = [...new Set(emails.map(normalizeEmail).filter((e): e is string => Boolean(e)))];
  const base = { externalEmails: [] as string[], contactIds: [] as string[], accountId: null, accountIds: [] as string[] };
  if (all.length === 0) return { ...base, relevant: false, reason: "no_participants" };
  if (all.some((e) => isBlocked(e, opts.blocklist))) return { ...base, relevant: false, reason: "blocked" };
  const external = all.filter((e) => e !== owner && !isInternal(e, opts.internalDomains));
  if (external.length === 0) return { ...base, relevant: false, reason: "internal_only" };

  const contactIds: string[] = [];
  const votes = new Map<string, number>();
  const vote = (id: string, w: number) => votes.set(id, (votes.get(id) ?? 0) + w);
  for (const e of external) {
    const c = dir.contactsByEmail.get(e);
    if (c) {
      contactIds.push(c.id);
      if (c.accountId) vote(c.accountId, 3);
      continue;
    }
    const d = emailDomain(e);
    if (!d || PERSONAL_DOMAINS.has(d)) continue;
    const acc = dir.accountsByDomain.get(d) ?? dir.accountsByDomain.get(parentDomain(d) ?? "");
    if (acc) vote(acc, 2);
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const relevant = contactIds.length > 0 || ranked.length > 0;
  return {
    relevant,
    reason: relevant ? "match" : "no_match",
    externalEmails: external,
    contactIds: [...new Set(contactIds)],
    accountId: ranked[0]?.[0] ?? null,
    accountIds: ranked.map(([id]) => id),
  };
}

/** "mail.example.co.uk" → "example.co.uk"; "news.example.com" → "example.com". */
export function parentDomain(d: string): string | null {
  const parts = d.split(".");
  if (parts.length <= 2) return null;
  const sld = parts.slice(-2).join(".");
  const twoLevelTld = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(sld);
  if (twoLevelTld) return parts.length > 3 ? parts.slice(-3).join(".") : null;
  return sld;
}

/** Map a free-text stage suggestion onto a pipeline stage name ("hot" → "Hot", "Contract (redlines)" → "Contract"). */
export function matchStageName(suggestion: string | null | undefined, stageNames: string[]): string | null {
  if (!suggestion) return null;
  const clean = (x: string) =>
    x
      .toLowerCase()
      .replace(/\(.*?\)/g, "")
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const s = clean(suggestion);
  if (!s) return null;
  const words = s.split(" ");
  return (
    stageNames.find((n) => clean(n) === s) ??
    stageNames.find((n) => clean(n).split(" ").some((w) => w.length > 2 && words.includes(w))) ??
    null
  );
}

/** Choose the deal for a thread/meeting: an open deal owned by/split with the user, else the most recently active open deal. */
export function pickDeal<T extends { id: string; ownerId: string | null; splitUserIds: string[]; lastActivityAt: Date | null; updatedAt: Date }>(
  deals: T[],
  userId: string,
): T | null {
  if (deals.length === 0) return null;
  const recency = (d: T) => Math.max(d.lastActivityAt?.getTime() ?? 0, d.updatedAt.getTime());
  const sorted = [...deals].sort((a, b) => recency(b) - recency(a));
  return sorted.find((d) => d.ownerId === userId || d.splitUserIds.includes(userId)) ?? sorted[0]!;
}
