import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { checkClaimsWith, loadClaimRules } from "@/lib/claims";
import { scanMnpi } from "@/lib/copilot/guards";
import { getGoogleAccessToken } from "@/lib/integrations/google";
import { internalDomains } from "@/lib/integrations/directory";
import { isInternal, normalizeEmail } from "@/lib/integrations/matching-core";
import { IntegrationAuthError, getPrefs as getMailPrefs } from "@/lib/integrations/store";
import { createDraft, deleteDraft } from "@/lib/gmail/client";
import { contactVisibilityWhere } from "@/lib/contacts/queries";
import type { AppUser } from "@/lib/rbac/server";
import { buildRawEmailBase64Url } from "@/lib/gmail/mime";
import { evaluateDraftGuard, firstNameFromEmail, GMAIL_COMPOSE_SCOPE, personalizeDraft, verifiedRecipients, withSignature, type StoredDraft } from "@/lib/gmail/drafts-core";

/**
 * V2 A1 follow-up drafts. The draft is scanned by the claims + MNPI guardrails; only a clean draft is written to the
 * rep's Gmail Drafts (gmail.compose). Flagged/blocked drafts — and every draft when Gmail compose isn't granted — are
 * stored in-app on the transcript (analysis.draft). Nothing is ever sent from here.
 */

type Owner = { id: string; name: string; email: string };

/**
 * External recipients for a call follow-up (≤ 5), minus RTB domains. SEC L-8: transcript participants are untrusted —
 * only meeting attendees and addresses of contacts the owner can see are used; the rest come back as `unverified`.
 */
export async function followUpRecipients(t: { participants: string[]; meetingId: string | null }, owner: AppUser): Promise<{ to: string[]; unverified: string[] }> {
  const [m] = t.meetingId ? await db.select({ attendees: s.meetings.attendees }).from(s.meetings).where(eq(s.meetings.id, t.meetingId)) : [];
  const internal = await internalDomains(owner.email);
  const participants = [...new Set(t.participants.map((p) => normalizeEmail(p)).filter((e): e is string => Boolean(e)))].slice(0, 50);
  const known = participants.length
    ? await db
        .select({ email: s.contacts.email })
        .from(s.contacts)
        .where(and(sql`lower(${s.contacts.email}) in (${sql.join(participants.map((e) => sql`${e}`), sql`, `)})`, isNull(s.contacts.deletedAt), await contactVisibilityWhere(owner)))
    : [];
  return verifiedRecipients({
    attendees: (m?.attendees ?? []).map((a) => normalizeEmail(a)).filter((e): e is string => Boolean(e)),
    participants,
    knownContacts: new Set(known.map((k) => (k.email ?? "").toLowerCase()).filter(Boolean)),
    isInternal: (e) => isInternal(e, internal),
  });
}

/** Remove an autopilot-created Gmail draft (undo). Never throws: a draft the rep already sent/deleted is simply gone. */
export async function deleteGmailDraft(ownerId: string, draftResourceId: string): Promise<boolean> {
  try {
    const token = await getGoogleAccessToken(ownerId, GMAIL_COMPOSE_SCOPE);
    await deleteDraft(token, draftResourceId);
    return true;
  } catch {
    return false;
  }
}

async function firstNameFor(email: string | undefined): Promise<string | null> {
  if (!email) return null;
  const [c] = await db
    .select({ firstName: s.contacts.firstName, fullName: s.contacts.fullName })
    .from(s.contacts)
    .where(and(eq(s.contacts.email, email), isNull(s.contacts.deletedAt)))
    .limit(1);
  return c?.firstName ?? c?.fullName?.split(/\s+/)[0] ?? firstNameFromEmail(email);
}

/** Store (merge) one key of transcripts.analysis without clobbering concurrent writers of other keys. */
export async function setAnalysisKey(transcriptId: string, key: "draft" | "autopilot", value: unknown) {
  await db
    .update(s.transcripts)
    .set({ analysis: sql`coalesce(${s.transcripts.analysis}, '{}'::jsonb) || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb)` })
    .where(eq(s.transcripts.id, transcriptId));
}

export async function saveFollowUpDraft(
  owner: Owner,
  transcriptId: string,
  input: { to: string[]; subject: string; body: string; unverified?: string[] },
  opts: { auto: boolean },
): Promise<StoredDraft> {
  const to = [...new Set(input.to.map((e) => normalizeEmail(e)).filter((e): e is string => Boolean(e)))].slice(0, 10);
  const mailPrefs = await getMailPrefs(owner.id).catch(() => null);
  const body = withSignature(personalizeDraft(input.body, to.length === 1 ? await firstNameFor(to[0]) : null), mailPrefs?.signature);
  const subject = input.subject.trim().slice(0, 300) || "Follow-up";

  const rules = await loadClaimRules();
  const claims = checkClaimsWith(`${subject}\n${body}`, rules);
  const guard = evaluateDraftGuard(claims.hits, claims.mode, scanMnpi(`${subject}\n${body}`));

  let location: StoredDraft["location"] = "app";
  let gmailDraftId: string | null = null;
  let gmailDraftResourceId: string | null = null;
  let needsReconnect = false;
  if (guard.status === "ok" && to.length) {
    try {
      const token = await getGoogleAccessToken(owner.id, GMAIL_COMPOSE_SCOPE);
      const raw = buildRawEmailBase64Url({ from: owner.email, fromName: owner.name, to, subject, body });
      const d = await createDraft(token, raw);
      location = "gmail";
      gmailDraftId = d.message?.id ?? d.id;
      gmailDraftResourceId = d.id ?? null;
    } catch (e) {
      needsReconnect = e instanceof IntegrationAuthError;
      if (!needsReconnect) console.error("[drafts] gmail draft failed", (e as Error).message?.slice(0, 200));
    }
  }
  const draft: StoredDraft = {
    to,
    subject,
    body,
    location,
    gmailDraftId,
    gmailDraftResourceId,
    needsRecipients: to.length === 0,
    unverified: (input.unverified ?? []).slice(0, 5),
    status: guard.status,
    warnings: guard.warnings,
    needsReconnect,
    createdAt: new Date().toISOString(),
    createdBy: owner.id,
    auto: opts.auto,
  };
  await setAnalysisKey(transcriptId, "draft", draft);
  await audit({
    actorId: owner.id,
    actorKind: opts.auto ? "agent" : "user",
    action: "transcript.follow_up_draft",
    entity: "transcript",
    entityId: transcriptId,
    // no body/recipients in the audit trail — counts + outcome only
    after: { location, status: guard.status, recipients: to.length, warnings: guard.warnings.length, needsReconnect },
  });
  return draft;
}
