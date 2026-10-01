import "server-only";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import * as s from "@/db/schema";
import { can, scopeFor, type AppUser } from "@/lib/rbac/server";
import { GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from "@/lib/integrations/core";
import { googleScopeStatus } from "@/lib/integrations/google";

/** Admins (admin.configure = all) may edit any sequence and enroll on behalf of another sender. */
export async function isSequenceAdmin(user: AppUser): Promise<boolean> {
  return can(user, "admin", "configure", "all");
}

/** Sequences a user can see / enroll into: shared ones and their own (admins: all). Never deleted ones. */
export async function sequenceVisibleWhere(user: AppUser): Promise<SQL> {
  if (await isSequenceAdmin(user)) return isNull(s.sequences.deletedAt);
  return and(isNull(s.sequences.deletedAt), or(eq(s.sequences.shared, true), eq(s.sequences.ownerId, user.id))!)!;
}

export function canEditSequence(user: AppUser, admin: boolean, seq: { ownerId: string | null }): boolean {
  return admin || seq.ownerId === user.id;
}

/**
 * Enrollments a user may see/manage: by mailbox (sender) per the `email` view scope — own → sent from my mailbox or
 * enrolled by me; team → my team's mailboxes; all → everything. Contact visibility is applied separately by joins.
 */
export async function enrollmentScopeWhere(user: AppUser): Promise<SQL> {
  const scope = await scopeFor(user, "email", "view");
  if (scope === "all") return sql`true`;
  const mine = or(eq(s.sequenceEnrollments.senderId, user.id), eq(s.sequenceEnrollments.enrolledBy, user.id))!;
  if (scope === "team" || scope === "pipeline") return or(mine, inArray(s.sequenceEnrollments.senderId, user.teamMemberIds.length ? user.teamMemberIds : [user.id]))!;
  if (scope === "own") return mine;
  return sql`false`;
}

export const GMAIL_CONNECT_HREF = "/settings#connections";
export const GMAIL_REQUIRED_MESSAGE = "Sequences send from your own Gmail. Connect your inbox (read + send permissions) in Settings → Connections first.";

export async function gmailStatus(userId: string): Promise<{ canSend: boolean; canRead: boolean }> {
  try {
    const st = await googleScopeStatus(userId, [GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE]);
    return { canSend: st.linked && Boolean(st.granted[GMAIL_SEND_SCOPE]), canRead: st.linked && Boolean(st.granted[GMAIL_READ_SCOPE]) };
  } catch {
    return { canSend: false, canRead: false };
  }
}
