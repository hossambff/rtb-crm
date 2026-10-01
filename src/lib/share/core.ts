/**
 * Partner share links (docs/V2_SPEC.md §C10) — pure, unit tested (src/lib/share/__tests__/core.test.ts).
 *
 * - Tokens: 32 random bytes, base64url (43 chars). Only sha256(token) is stored; the URL is shown once.
 * - Fields: an explicit allow-list. The public projection is built from scratch (never by deleting keys), so a new
 *   deal column can never leak by accident, and no internal IDs are ever part of it.
 */
import { scanMnpi } from "@/lib/copilot/guards";
import { createHash, randomBytes } from "node:crypto";

export { MAX_SHARE_DEALS, SHARE_EXPIRY_DAYS, SHARE_FIELD_LABELS, SHARE_FIELD_SOURCES, SHARE_FIELDS, type ShareField } from "./fields";
import { SHARE_EXPIRY_DAYS, SHARE_FIELDS, type ShareField } from "./fields";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function generateShareToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Cheap syntactic check before any DB lookup (bad shapes never touch the database). */
export function isWellFormedToken(t: unknown): t is string {
  return typeof t === "string" && TOKEN_RE.test(t);
}

/** Keep only known fields, de-duplicated, in canonical order. */
export function normalizeShareFields(input: readonly unknown[]): ShareField[] {
  const set = new Set(input.filter((f): f is ShareField => typeof f === "string" && (SHARE_FIELDS as readonly string[]).includes(f)));
  return SHARE_FIELDS.filter((f) => set.has(f));
}

export type LinkState = "active" | "expired" | "revoked";

export function linkState(l: { expiresAt: Date; revokedAt: Date | null }, now: Date = new Date()): LinkState {
  if (l.revokedAt) return "revoked";
  if (l.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

export function expiryFrom(days: number, now: Date = new Date()): Date {
  const d = (SHARE_EXPIRY_DAYS as readonly number[]).includes(days) ? days : 30;
  return new Date(now.getTime() + d * 86_400_000);
}

/** Coarse audience band so partners never see the exact (internal) MUU estimate. */
export function muuBand(muu: number | null | undefined): string | null {
  if (muu == null || !Number.isFinite(muu) || muu <= 0) return null;
  const bands: [number, string][] = [
    [1e6, "Under 1M"],
    [5e6, "1–5M"],
    [10e6, "5–10M"],
    [25e6, "10–25M"],
    [50e6, "25–50M"],
    [100e6, "50–100M"],
  ];
  for (const [max, label] of bands) if (muu < max) return `${label} monthly users`;
  return "100M+ monthly users";
}

export function firstName(name: string | null | undefined): string | null {
  const f = (name ?? "").trim().split(/\s+/)[0];
  if (!f || f.includes("@") || /placeholder/i.test(name ?? "")) return null;
  return f.slice(0, 40);
}

/** "Nov 2026" — partners see the month, not an internal day-precise date. */
export function closeMonth(d: Date | null | undefined, tz = "America/New_York"): string | null {
  if (!d) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: tz }).format(d);
  } catch {
    return null;
  }
}

/** Input for the public projection: only the columns the allow-list can read (plus the MNPI flag). */
export type ShareSourceDeal = {
  name: string;
  accountName: string | null;
  restricted: boolean;
  deleted: boolean;
  status: string; // open | won | lost | hold
  stageName: string | null;
  stageCategory: string | null;
  nextStep: string | null;
  nextStepDueAt: Date | null;
  expectedCloseDate: Date | null;
  muu: number | null;
  ownerName: string | null;
};

export type ShareCard = {
  title: string;
  status: "open" | "won" | "lost" | "hold";
  stage?: string;
  nextStep?: string;
  nextStepDue?: string;
  closeDate?: string;
  muu?: string;
  owner?: string;
};

/**
 * Public projection of one deal. Restricted or deleted deals return null (never rendered, whatever the link says).
 * Free-text next steps are capped; dates are coarse.
 */
export function projectShareCard(d: ShareSourceDeal, fields: readonly ShareField[], tz = "America/New_York"): ShareCard | null {
  if (d.restricted || d.deleted) return null;
  const status = (["open", "won", "lost", "hold"] as const).find((s) => s === d.status) ?? "open";
  const card: ShareCard = { title: (d.accountName || d.name).slice(0, 120), status };
  const f = new Set(fields);
  if (f.has("stage") && d.stageName) card.stage = d.stageName.slice(0, 60);
  // SEC L-12: the free-text next step leaves the building — drop it when it looks like internal / non-public information.
  if (f.has("nextStep") && d.nextStep && status === "open" && scanMnpi(d.nextStep).length === 0) {
    card.nextStep = d.nextStep.replace(/\s+/g, " ").trim().slice(0, 240);
    const due = closeDay(d.nextStepDueAt, tz);
    if (due) card.nextStepDue = due;
  }
  if (f.has("closeDate")) {
    const m = closeMonth(d.expectedCloseDate, tz);
    if (m && status === "open") card.closeDate = m;
  }
  if (f.has("muu")) {
    const b = muuBand(d.muu);
    if (b) card.muu = b;
  }
  if (f.has("owner")) {
    const o = firstName(d.ownerName);
    if (o) card.owner = o;
  }
  return card;
}

function closeDay(d: Date | null | undefined, tz: string): string | null {
  if (!d) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz }).format(d);
  } catch {
    return null;
  }
}

/**
 * Link-preview bots and crawlers (Slack/Teams/iMessage unfurls, social cards, search engines). They get a neutral
 * page with no data, and their fetches don't count as views — so pasting a link into a chat never leaks a preview.
 */
export function isPreviewBot(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true; // real browsers always send one
  return /bot|crawl|spider|slurp|preview|slack|facebookexternalhit|whatsapp|telegram|discord|skype|teams|linkedin|embedly|iframely|vkshare|pinterest|quora link|outbrain|bitlybot|curl|wget|python-requests|httpclient|go-http-client|headless/i.test(
    userAgent,
  );
}
