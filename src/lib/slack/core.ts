/**
 * Slack — pure helpers (no DB, no server-only): request signature verification, input validation, slash-command
 * parsing, mrkdwn escaping. Unit tested in src/lib/slack/__tests__/core.test.ts.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack's documented replay window: reject requests whose timestamp is more than 5 minutes off. */
export const SLACK_MAX_SKEW_SEC = 60 * 5;

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing" | "stale" | "malformed" | "mismatch" };

/**
 * Verify `X-Slack-Signature` (v0): HMAC-SHA256(signingSecret, `v0:${timestamp}:${rawBody}`) as hex, compared in
 * constant time. The raw body must be the exact bytes Slack sent (read with `req.text()` before parsing).
 */
export function verifySlackSignature(p: {
  signingSecret: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: string;
  nowSec?: number;
}): SignatureCheck {
  if (!p.signingSecret || !p.timestamp || !p.signature) return { ok: false, reason: "missing" };
  if (!/^\d{1,12}$/.test(p.timestamp)) return { ok: false, reason: "malformed" };
  const now = p.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(p.timestamp)) > SLACK_MAX_SKEW_SEC) return { ok: false, reason: "stale" };
  if (!/^v0=[0-9a-f]{64}$/.test(p.signature)) return { ok: false, reason: "malformed" };
  const expected = `v0=${createHmac("sha256", p.signingSecret).update(`v0:${p.timestamp}:${p.rawBody}`, "utf8").digest("hex")}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(p.signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

/** Sign a body the way Slack does — used by tests and the local smoke script. */
export function signSlackBody(signingSecret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`, "utf8").digest("hex")}`;
}

/**
 * Per-instance memory of recently accepted signatures: a byte-identical request replayed inside the 5-minute window
 * is dropped. (Decisions are idempotent anyway; this just keeps replays from producing duplicate side effects.)
 */
export class ReplayGuard {
  private seen = new Map<string, number>();
  constructor(
    private readonly ttlMs = SLACK_MAX_SKEW_SEC * 1000 * 2,
    private readonly max = 5000,
  ) {}
  /** True the first time a key is seen within the TTL; false for a replay. */
  firstSeen(key: string, now = Date.now()): boolean {
    for (const [k, t] of this.seen) {
      if (now - t <= this.ttlMs && this.seen.size <= this.max) break;
      this.seen.delete(k);
    }
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }
}

/* ───────────── Credentials & channel validation ───────────── */

/** Bot tokens are `xoxb-…`. User tokens (xoxp) or app-level tokens (xapp) are refused. */
export function validateBotToken(t: string): string | null {
  const v = t.trim();
  if (!v) return "Paste the Bot User OAuth Token.";
  if (v.startsWith("xoxp-")) return "That's a user token (xoxp-). Use the Bot User OAuth Token (xoxb-).";
  if (v.startsWith("xapp-")) return "That's an app-level token (xapp-). Use the Bot User OAuth Token (xoxb-).";
  if (!/^xoxb-[A-Za-z0-9-]{20,250}$/.test(v)) return "Bot tokens start with xoxb- (Slack app → OAuth & Permissions).";
  return null;
}

/** Signing secrets are 32 lowercase hex characters (Slack app → Basic Information → App Credentials). */
export function validateSigningSecret(s: string): string | null {
  const v = s.trim();
  if (!v) return "Paste the signing secret.";
  if (!/^[0-9a-f]{32}$/i.test(v)) return "The signing secret is 32 hexadecimal characters (Basic Information → App Credentials).";
  return null;
}

/**
 * Normalize a channel reference typed by an admin: a channel ID (C…/G…, as shown in Slack's channel details) or a
 * name (#sales-wins). Returns null for empty input, or { error }.
 */
export function normalizeChannel(input: string | null | undefined): { value: string | null } | { error: string } {
  const v = (input ?? "").trim();
  if (!v) return { value: null };
  if (/^[CG][A-Z0-9]{8,12}$/.test(v)) return { value: v };
  const name = v.replace(/^#/, "").toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,79}$/.test(name)) return { value: `#${name}` };
  return { error: "Use a channel ID (C0123ABCD) or a name like #sales-wins." };
}

/** A Slack-issued response_url must point at hooks.slack.com over https (never post anywhere else). */
export function isSlackResponseUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 500) return false;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "hooks.slack.com" && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

/** Slack IDs we accept from payloads (users U…/W…, teams T…/E…). */
export const isSlackUserId = (v: unknown): v is string => typeof v === "string" && /^[UW][A-Z0-9]{6,20}$/.test(v);
export const isSlackTeamId = (v: unknown): v is string => typeof v === "string" && /^[TE][A-Z0-9]{6,20}$/.test(v);
export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/* ───────────── Slash command ───────────── */

export type RtbCommand = { kind: "deal"; query: string } | { kind: "approvals" } | { kind: "help" } | { kind: "unknown"; text: string };

/** `/rtb deal <name>` · `/rtb approvals` · `/rtb help` (empty → help). */
export function parseRtbCommand(text: string | null | undefined): RtbCommand {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t || /^(help|\?)$/i.test(t)) return { kind: "help" };
  const m = /^(deal|d)\s+(.+)$/i.exec(t);
  if (m) {
    const query = m[2]!.trim().slice(0, 80);
    return query.length >= 2 ? { kind: "deal", query } : { kind: "help" };
  }
  if (/^deals?$/i.test(t)) return { kind: "help" };
  if (/^approvals?$/i.test(t)) return { kind: "approvals" };
  return { kind: "unknown", text: t.slice(0, 40) };
}

/* ───────────── mrkdwn ───────────── */

/** Escape user text for Slack mrkdwn (&, <, > are control characters; this also neutralizes <!channel> pings). */
export function escapeMrkdwn(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function truncate(s: string | null | undefined, n: number): string {
  const v = (s ?? "").trim();
  return v.length > n ? `${v.slice(0, Math.max(0, n - 1)).trimEnd()}…` : v;
}

/** Plain-text fields (headers, buttons) have hard limits and no markup. */
export function plain(s: string | null | undefined, n = 150): string {
  return truncate((s ?? "").replace(/\s+/g, " "), n) || " ";
}

/** Absolute app link for an in-app href; refuses anything that isn't a same-app relative path. */
export function appLink(appUrl: string, href: string | null | undefined): string | null {
  if (!href || !href.startsWith("/") || href.startsWith("//")) return null;
  try {
    const base = new URL(appUrl);
    const u = new URL(href, base);
    return u.origin === base.origin ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Approval id carried in notification hrefs: /tasks?tab=approvals&approval=<uuid>. */
export function approvalIdFromHref(href: string | null | undefined): string | null {
  if (!href || !href.startsWith("/tasks")) return null;
  try {
    const id = new URL(href, "http://x").searchParams.get("approval");
    return isUuid(id) ? id : null;
  } catch {
    return null;
  }
}

export const approvalHref = (id: string) => `/tasks?tab=approvals&approval=${id}`;

/* ───────────── Identity (SEC M-4) ───────────── */

/** Case-insensitive email equality for Slack ↔ Roundtable identity; empty emails never match. */
export function slackEmailMatches(appEmail: string | null | undefined, slackEmail: string | null | undefined): boolean {
  const a = (appEmail ?? "").trim().toLowerCase();
  const b = (slackEmail ?? "").trim().toLowerCase();
  return Boolean(a) && a === b;
}

/**
 * Of the app users whose prefs claim a Slack member ID, the one whose email matches the Slack profile email (exactly one,
 * else null). Self-declared claims on someone else's ID never win, and duplicates can't lock the real owner out.
 */
export function pickVerifiedClaimant(claims: { userId: string; email: string | null }[], slackProfileEmail: string | null): string | null {
  const ok = claims.filter((c) => slackEmailMatches(c.email, slackProfileEmail));
  return ok.length === 1 ? ok[0]!.userId : null;
}

/* ───────────── Approval notifications without an approval link (QA MAJ-15) ───────────── */

export type ApprovalLookup = { kinds: string[]; entity?: string; entityId?: string };

/**
 * Some approval notifications link to the subject instead of the request (probability override → /deals/<id>,
 * proposal → /proposals/<id>, lead registration, scout). Map such an href to the pending approval to look up, so Slack
 * can still render Approve / Reject. Null when the href can't identify one. Pure.
 */
export function approvalLookupFromHref(href: string | null | undefined): ApprovalLookup | null {
  if (!href || !href.startsWith("/") || href.startsWith("//")) return null;
  let u: URL;
  try {
    u = new URL(href, "http://x");
  } catch {
    return null;
  }
  const path = u.pathname.replace(/\/+$/, "");
  const deal = /^\/deals\/([0-9a-f-]{36})$/i.exec(path);
  if (deal && isUuid(deal[1])) return { kinds: ["probability_override", "stage_gate"], entity: "deal", entityId: deal[1]!.toLowerCase() };
  const proposal = /^\/proposals\/(?:term-sheets\/)?([0-9a-f-]{36})$/i.exec(path);
  if (proposal && isUuid(proposal[1])) return { kinds: ["proposal"], entity: "proposal", entityId: proposal[1]!.toLowerCase() };
  if (path === "/commissions" && u.searchParams.get("tab") === "registrations") return { kinds: ["lead_registration"] };
  if (path === "/scout" && u.searchParams.get("tab") === "budget") return { kinds: ["scout_budget"] };
  if (path === "/scout" && !u.searchParams.get("tab")) return { kinds: ["scout_accept"] };
  return null;
}
