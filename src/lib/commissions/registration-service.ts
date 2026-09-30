import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db, type Tx } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { getSetting } from "@/lib/settings";
import type { AppUser } from "@/lib/rbac/server";
import { protectUntil } from "./registration";

/**
 * Decide a lead registration (PRD COM-6) — the single path used by the Commissions → Registrations queue and by the
 * Tasks → Approvals tab (lead_registration approval handler). Callers check permissions (accounts.assign = all).
 * `syncApproval`: also close the matching pending approvals row (the approvals service does that itself).
 */
export async function applyRegistrationDecision(
  user: AppUser,
  id: string,
  decision: "approved" | "rejected",
  note: string | null,
  opts: { syncApproval: boolean; withinTx?: (tx: Tx) => Promise<void> },
) {
  const [reg] = await db.select().from(s.leadRegistrations).where(eq(s.leadRegistrations.id, id));
  if (!reg) throw new UserError("Registration not found.");
  if (reg.status !== "pending") throw new UserError("This registration was already decided.");
  const now = new Date();
  const days = Number(await getSetting<number>("commission.registration_protect_days", 90)) || 90;
  const patch = {
    status: decision,
    decidedBy: user.id,
    protectedUntil: decision === "approved" ? protectUntil(now, days) : null,
    note: note ? `${reg.note ? `${reg.note}\n` : ""}Decision (${user.name}): ${note}` : reg.note,
  };
  await db.transaction(async (tx) => {
    // Conditional on still pending: a concurrent decision can't apply twice.
    const claimed = await tx
      .update(s.leadRegistrations)
      .set(patch)
      .where(and(eq(s.leadRegistrations.id, id), eq(s.leadRegistrations.status, "pending")))
      .returning({ id: s.leadRegistrations.id });
    if (!claimed.length) throw new UserError("This registration was already decided.");
    if (opts.syncApproval)
      await tx
        .update(s.approvals)
        .set({ status: decision, decidedBy: user.id, decidedAt: now, note: note ?? null })
        .where(and(eq(s.approvals.kind, "lead_registration"), eq(s.approvals.entityId, id), eq(s.approvals.status, "pending")));
    if (decision === "approved") {
      await tx.update(s.accounts).set({ ownerId: reg.userId }).where(and(eq(s.accounts.id, reg.accountId), isNull(s.accounts.ownerId)));
    }
    await tx.insert(s.notifications).values({
      userId: reg.userId,
      kind: "approval",
      title: decision === "approved" ? `Registration approved · protected ${days} days` : "Registration rejected",
      body: note ?? null,
      href: "/commissions?tab=registrations",
    });
    await audit({ actorId: user.id, action: `lead_registration.${decision}`, entity: "lead_registration", entityId: id, before: reg, after: patch }, tx);
    await opts.withinTx?.(tx);
  });
  return { id, status: decision };
}
