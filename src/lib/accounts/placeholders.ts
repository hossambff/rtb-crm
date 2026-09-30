import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { isPlaceholderEmail } from "@/lib/import/owners";

/**
 * Hand everything a spreadsheet placeholder rep owns over to the real user (PRD IMP-4 review queue).
 * Re-points ownership, splits (merging percentages if both already split a deal), relationship owner, task assignee,
 * activity actor, migration/meeting owner. The placeholder stays banned and is marked as claimed. Audited.
 *
 * For the admin module: call after verifying the caller can configure users (assertCan(user, "admin", "configure")).
 */
export async function claimPlaceholder(placeholderId: string, realUserId: string, actorId: string | null = null) {
  if (placeholderId === realUserId) throw new Error("Pick a different user");
  const [ph] = await db.select().from(s.user).where(eq(s.user.id, placeholderId));
  const [real] = await db.select().from(s.user).where(eq(s.user.id, realUserId));
  if (!ph || !isPlaceholderEmail(ph.email)) throw new Error("Not a placeholder user");
  if (!real) throw new Error("Target user not found");

  const counts: Record<string, number> = {};
  const repoint = async (label: string, run: () => Promise<{ id: unknown }[]>) => {
    counts[label] = (await run()).length;
  };
  await repoint("accounts", () => db.update(s.accounts).set({ ownerId: real.id }).where(eq(s.accounts.ownerId, ph.id)).returning({ id: s.accounts.id }));
  await repoint("deals", () => db.update(s.deals).set({ ownerId: real.id }).where(eq(s.deals.ownerId, ph.id)).returning({ id: s.deals.id }));
  await repoint("contacts", () => db.update(s.contacts).set({ ownerId: real.id }).where(eq(s.contacts.ownerId, ph.id)).returning({ id: s.contacts.id }));
  await repoint("contactRelationships", () =>
    db.update(s.contacts).set({ relationshipOwnerId: real.id }).where(eq(s.contacts.relationshipOwnerId, ph.id)).returning({ id: s.contacts.id }),
  );
  await repoint("tasks", () => db.update(s.tasks).set({ assigneeId: real.id }).where(eq(s.tasks.assigneeId, ph.id)).returning({ id: s.tasks.id }));
  await repoint("activities", () => db.update(s.activities).set({ actorId: real.id }).where(eq(s.activities.actorId, ph.id)).returning({ id: s.activities.id }));
  await repoint("migrationProjects", () =>
    db.update(s.migrationProjects).set({ ownerId: real.id }).where(eq(s.migrationProjects.ownerId, ph.id)).returning({ id: s.migrationProjects.id }),
  );
  await repoint("meetings", () => db.update(s.meetings).set({ ownerId: real.id }).where(eq(s.meetings.ownerId, ph.id)).returning({ id: s.meetings.id }));
  await repoint("leadRegistrations", () =>
    db.update(s.leadRegistrations).set({ userId: real.id }).where(eq(s.leadRegistrations.userId, ph.id)).returning({ id: s.leadRegistrations.id }),
  );

  // deal splits: PK (dealId, userId) — merge pct where the real user already has a split on the same deal
  const phSplits = await db.select().from(s.dealSplits).where(eq(s.dealSplits.userId, ph.id));
  const both = phSplits.length
    ? await db.select().from(s.dealSplits).where(and(eq(s.dealSplits.userId, real.id), inArray(s.dealSplits.dealId, phSplits.map((x) => x.dealId))))
    : [];
  const realByDeal = new Map(both.map((x) => [x.dealId, x]));
  for (const sp of phSplits) {
    const existing = realByDeal.get(sp.dealId);
    if (existing) {
      await db
        .update(s.dealSplits)
        .set({ pct: Math.min(100, existing.pct + sp.pct) })
        .where(and(eq(s.dealSplits.dealId, sp.dealId), eq(s.dealSplits.userId, real.id)));
      await db.delete(s.dealSplits).where(and(eq(s.dealSplits.dealId, sp.dealId), eq(s.dealSplits.userId, ph.id)));
    } else {
      await db.update(s.dealSplits).set({ userId: real.id }).where(and(eq(s.dealSplits.dealId, sp.dealId), eq(s.dealSplits.userId, ph.id)));
    }
  }
  counts.dealSplits = phSplits.length;

  // carry the placeholder's employment data over when the real profile has none
  if (!real.employmentType || real.employmentType === "staff") {
    if (ph.employmentType && ph.employmentType !== "staff") await db.update(s.user).set({ employmentType: ph.employmentType }).where(eq(s.user.id, real.id));
  }
  await db.update(s.user).set({ banned: true, banReason: `Claimed by ${real.email} on ${new Date().toISOString().slice(0, 10)}` }).where(eq(s.user.id, ph.id));
  await audit({ actorId, action: "user.claim_placeholder", entity: "user", entityId: real.id, before: { placeholderId: ph.id, placeholderEmail: ph.email }, after: counts });
  return counts;
}

/** Placeholder users (for the admin "claim" UI). */
export async function listPlaceholders() {
  const users = await db.select({ id: s.user.id, name: s.user.name, email: s.user.email, employmentType: s.user.employmentType, banReason: s.user.banReason }).from(s.user);
  return users.filter((u) => isPlaceholderEmail(u.email));
}
