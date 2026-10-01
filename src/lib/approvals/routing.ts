import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { resolveSubject } from "@/lib/notifications/sensitive";
import { activeUserWhere } from "@/lib/users";
import { routeRestrictedApprovers, type RestrictionFacts } from "./routing-core";

/** Access facts for the deal/account behind an approval's entity. Null = no deal/account behind it (or not found). */
async function restrictionFacts(entity: string, entityId: string): Promise<RestrictionFacts | null> {
  const subject = await resolveSubject(entity, entityId);
  if (!subject || (!subject.dealId && !subject.accountId)) return null;
  let dealRestricted = false;
  let accountId = subject.accountId;
  if (subject.dealId) {
    const [d] = await db.select({ restricted: s.deals.restricted, accountId: s.deals.accountId }).from(s.deals).where(eq(s.deals.id, subject.dealId));
    dealRestricted = Boolean(d?.restricted);
    accountId = accountId ?? d?.accountId ?? null;
  }
  let accountRestricted = false;
  if (accountId) {
    const [a] = await db.select({ restricted: s.accounts.restricted }).from(s.accounts).where(eq(s.accounts.id, accountId));
    accountRestricted = Boolean(a?.restricted);
  }
  const ids = [subject.dealId, accountId].filter((x): x is string => Boolean(x));
  const grants = await db
    .select({ entity: s.restrictedAccess.entity, entityId: s.restrictedAccess.entityId, userId: s.restrictedAccess.userId })
    .from(s.restrictedAccess)
    .where(inArray(s.restrictedAccess.entityId, ids));
  const supers = await db.select({ id: s.user.id }).from(s.user).where(and(eq(s.user.role, "super_admin"), activeUserWhere));
  return {
    dealRestricted,
    accountRestricted,
    dealList: new Set(grants.filter((g) => g.entity === "deal" && g.entityId === subject.dealId).map((g) => g.userId)),
    accountList: new Set(grants.filter((g) => g.entity === "account" && g.entityId === accountId).map((g) => g.userId)),
    superAdmins: new Set(supers.map((u) => u.id)),
  };
}

/**
 * Narrow approval recipients for a restricted subject (QA MIN-36): only people on the access list (or super_admin);
 * none → super_admins with `fallback: true` (caller uses a neutral title). Fails closed: on a lookup error only the
 * super_admins are notified.
 */
export async function routeRestrictedApproval(
  approval: { entity: string; entityId: string; requestedBy: string },
  candidates: string[],
): Promise<{ recipients: string[]; fallback: boolean }> {
  try {
    const facts = await restrictionFacts(approval.entity, approval.entityId);
    if (!facts) return { recipients: candidates.filter((id) => id !== approval.requestedBy), fallback: false };
    return routeRestrictedApprovers(candidates, facts, approval.requestedBy);
  } catch {
    const supers = await db.select({ id: s.user.id }).from(s.user).where(and(eq(s.user.role, "super_admin"), activeUserWhere)).catch(() => []);
    return { recipients: supers.map((u) => u.id).filter((id) => id !== approval.requestedBy), fallback: true };
  }
}
