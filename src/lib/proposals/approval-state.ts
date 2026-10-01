import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { requestApproval } from "@/lib/approvals/service";
import type { AppUser } from "@/lib/rbac/server";
import { isSensitiveEntity } from "@/lib/notifications/sensitive";
import { scheduleApprovalCardRefresh } from "@/lib/slack/card-refresh";

/**
 * Write a proposal version's approval state (PRO-3) for any proposal kind:
 * - reasons → status pending_approval + one pending approvals row (payload refreshed if it already exists);
 * - no reasons → back to draft, and any pending request is withdrawn.
 * Restricted deals (or deals on a restricted account): approvers are notified by role and may not be on the access
 * list → neutral title, no reasons, and the deal name is NOT stored in the approval payload (QA MIN-36).
 * Used by every proposal kind (pro forma and term sheets) so approvals, Slack buttons and SLA behave the same.
 */
export async function syncProposalApproval(
  user: AppUser,
  p: { id: string; version: number; kindLabel: string },
  deal: { name: string; restricted: boolean },
  reasons: string[],
) {
  const pending = await db
    .select({ id: s.approvals.id })
    .from(s.approvals)
    .where(and(eq(s.approvals.kind, "proposal"), eq(s.approvals.entityId, p.id), eq(s.approvals.status, "pending")));
  const restricted = deal.restricted || (await isSensitiveEntity("proposal", p.id).catch(() => true));
  const payload = { reasons, version: p.version, dealName: restricted ? null : deal.name, kind: p.kindLabel };
  if (reasons.length) {
    await db.update(s.proposals).set({ status: "pending_approval", approvalReason: reasons.join("; ") }).where(eq(s.proposals.id, p.id));
    if (pending.length) await db.update(s.approvals).set({ payload }).where(inArray(s.approvals.id, pending.map((x) => x.id)));
    else
      await requestApproval({
        kind: "proposal",
        entity: "proposal",
        entityId: p.id,
        requestedBy: user.id,
        approverRole: "executive",
        payload,
        note: restricted ? null : reasons.join("; "),
        title: `${p.kindLabel} approval: ${restricted ? "restricted deal" : deal.name} v${p.version}`,
      });
  } else {
    await db.update(s.proposals).set({ status: "draft", approvalReason: null }).where(eq(s.proposals.id, p.id));
    if (pending.length)
      await db
        .update(s.approvals)
        .set({ status: "rejected", note: "Withdrawn: no longer requires approval", decidedAt: new Date() })
        .where(inArray(s.approvals.id, pending.map((x) => x.id)));
    if (pending.length) scheduleApprovalCardRefresh({ ids: pending.map((x) => x.id) });
  }
  return reasons;
}
