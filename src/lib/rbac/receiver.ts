import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { accountVisibilityWhere } from "@/lib/accounts/queries";
import { canSeeRestricted, dealAccessWhere, loadAppUserById, type AppUser } from "./server";

/**
 * Hand-over checks (SEC M-1 / M-2): when one user gives another a task, an alert or similar work item about a deal or
 * account, the RECEIVER must be able to open that (live) deal / account with their own read rules — including
 * restricted (MNPI) access lists. Shared by tasks (saveTask), alert reassignment and the Today queue's delegate.
 */

/** The receiver as a session-equivalent AppUser (null → banned / expired / pending / disallowed domain). */
export async function loadReceiver(userId: string, noun = "work"): Promise<AppUser> {
  const target = await loadAppUserById(userId);
  if (!target) throw new UserError(`That user can't receive ${noun}.`);
  return target;
}

/** Throws a UserError naming the receiver when they can't see the subject's deal or account. Deleted subjects pass. */
export async function assertReceiverCanSee(receiver: AppUser, subject: { dealId?: string | null; accountId?: string | null }, noun = "this item"): Promise<void> {
  const first = receiver.name.split(/\s+/)[0] || receiver.name;
  if (subject.dealId) {
    const [live] = await db
      .select({ id: s.deals.id, accountId: s.deals.accountId, accountRestricted: s.accounts.restricted })
      .from(s.deals)
      .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
      .where(and(eq(s.deals.id, subject.dealId), isNull(s.deals.deletedAt)));
    if (live) {
      const [ok] = await db.select({ id: s.deals.id }).from(s.deals).where(and(eq(s.deals.id, subject.dealId), await dealAccessWhere(receiver, "view")));
      // A deal on a restricted (MNPI) account is restricted too: the receiver must also be on the account's access list.
      const accountOk = !live.accountRestricted || !live.accountId || (await canSeeRestricted(receiver, "account", live.accountId));
      if (!ok || !accountOk) throw new UserError(`${first} can't see ${noun}'s deal — pick someone who works on it.`);
    }
  }
  if (subject.accountId) {
    const [live] = await db.select({ id: s.accounts.id }).from(s.accounts).where(and(eq(s.accounts.id, subject.accountId), isNull(s.accounts.deletedAt)));
    if (live) {
      const [ok] = await db.select({ id: s.accounts.id }).from(s.accounts).where(and(eq(s.accounts.id, subject.accountId), await accountVisibilityWhere(receiver, "view")));
      if (!ok) throw new UserError(`${first} can't see ${noun}'s account — pick someone who works on it.`);
    }
  }
}
