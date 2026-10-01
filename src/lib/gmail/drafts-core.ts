/**
 * Follow-up drafts (V2 A1) — pure helpers, unit-tested. Drafts are NEVER sent by automation: a clean draft lands in the
 * rep's Gmail Drafts (gmail.compose); anything flagged by the claims or MNPI guardrail stays in-app, where the composer
 * re-runs the claims check on send.
 */
import type { ClaimHit } from "@/lib/claims-core";

export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

export type DraftGuard = {
  /** ok → may go to Gmail; flagged → keep in-app for review; blocked → banned claim in block mode (in-app, must edit). */
  status: "ok" | "flagged" | "blocked";
  warnings: string[];
};

export function evaluateDraftGuard(claimHits: Pick<ClaimHit, "status" | "match" | "alternative">[], claimsMode: "warn" | "block", mnpiWarnings: string[]): DraftGuard {
  const warnings = [
    ...claimHits.map((h) => `${h.status === "banned" ? "Banned" : "Restricted"} claim “${h.match}”${h.alternative ? ` — use “${h.alternative}”` : ""}`),
    ...mnpiWarnings.map((w) => `Possible confidential info: ${w}`),
  ];
  if (claimsMode === "block" && claimHits.some((h) => h.status === "banned")) return { status: "blocked", warnings };
  return { status: warnings.length ? "flagged" : "ok", warnings };
}

/** Fill the {{first_name}} merge field; an unknown name becomes "there" ("Hi there,"). Other merge fields are left for the rep. */
export function personalizeDraft(body: string, firstName: string | null | undefined): string {
  const name = (firstName ?? "").trim().split(/\s+/)[0] || "there";
  return body.replace(/\{\{\s*first_name\s*\}\}/gi, name);
}

/** Append the user's email signature once (same rule as the composer's send path). */
export function withSignature(body: string, signature: string | null | undefined): string {
  const sig = (signature ?? "").trim();
  return sig && !body.includes(sig) ? `${body}\n\n${sig}` : body;
}

/** A first name guessed from a mailbox local part ("jane.doe@x.com" → "Jane"); null for role mailboxes. */
export function firstNameFromEmail(email: string | null | undefined): string | null {
  const local = (email ?? "").split("@")[0]?.toLowerCase() ?? "";
  if (!local || /^(info|hello|hi|team|contact|sales|admin|support|office|press|news|editor|partnerships?|marketing|noreply|no-reply)$/.test(local)) return null;
  const first = local.split(/[._-]/)[0] ?? "";
  if (!/^[a-z]{2,20}$/.test(first)) return null;
  return first[0]!.toUpperCase() + first.slice(1);
}

export type StoredDraft = {
  to: string[];
  subject: string;
  body: string;
  location: "gmail" | "app";
  gmailDraftId: string | null;
  status: DraftGuard["status"];
  warnings: string[];
  /** Gmail compose permission missing → show "Reconnect Gmail to get drafts in Gmail". */
  needsReconnect: boolean;
  createdAt: string;
  createdBy: string;
  auto: boolean;
  /** Gmail draft resource id (users.drafts id, for delete on undo). `gmailDraftId` holds the message id (for the link). */
  gmailDraftResourceId?: string | null;
  /** No verified recipient: the draft stays in-app until the rep adds one (QA MIN-22 — never claim "drafted in Gmail"). */
  needsRecipients?: boolean;
  /** Addresses from the transcript that matched no contact / meeting attendee (SEC L-8) — shown, never pre-addressed. */
  unverified?: string[];
};

/**
 * Recipients for an automatic follow-up (SEC L-8): calendar attendees are trusted; transcript participants are
 * untrusted text and only count when they match a CRM contact the owner can see. Internal addresses are dropped.
 */
export function verifiedRecipients(f: { attendees: string[]; participants: string[]; knownContacts: Set<string>; isInternal: (email: string) => boolean; max?: number }): { to: string[]; unverified: string[] } {
  const norm = (e: string) => e.trim().toLowerCase();
  const valid = (e: string) => /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i.test(e);
  const attendees = new Set(f.attendees.map(norm).filter(valid));
  const to: string[] = [];
  const unverified: string[] = [];
  for (const raw of [...f.attendees, ...f.participants]) {
    const e = norm(raw);
    if (!valid(e) || f.isInternal(e) || to.includes(e) || unverified.includes(e)) continue;
    if (attendees.has(e) || f.knownContacts.has(e)) to.push(e);
    else unverified.push(e);
  }
  return { to: to.slice(0, f.max ?? 5), unverified: unverified.slice(0, 5) };
}

/** Gmail web link to a draft (opens Drafts with the message). */
export function gmailDraftUrl(gmailMessageId: string | null | undefined): string {
  return gmailMessageId ? `https://mail.google.com/mail/u/0/#drafts?compose=${encodeURIComponent(gmailMessageId)}` : "https://mail.google.com/mail/u/0/#drafts";
}
