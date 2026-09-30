"use server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { auditConfig, requireAdmin } from "@/lib/admin/guard";
import { claimSchema, idSchema } from "./config-schemas";

const PATH = "/admin/claims";

export const saveClaim = action(claimSchema, async (input, user) => {
  await requireAdmin(user);
  if (input.productId) {
    const [p] = await db.select({ id: s.products.id }).from(s.products).where(eq(s.products.id, input.productId));
    if (!p) throw new UserError("Selected product no longer exists.");
  }
  const values = {
    text: input.text,
    pattern: input.pattern,
    status: input.status,
    approvedAlternative: input.approvedAlternative,
    evidence: input.evidence,
    productId: input.productId,
    expiresAt: input.expiresAt ? new Date(`${input.expiresAt}T23:59:59Z`) : null,
  };
  if (input.id) {
    const [before] = await db.select().from(s.claims).where(eq(s.claims.id, input.id));
    if (!before) throw new UserError("Claim not found.");
    // The approver is whoever last set the status.
    const approverId = before.status !== input.status ? user.id : before.approverId;
    const [after] = await db
      .update(s.claims)
      .set({ ...values, approverId })
      .where(eq(s.claims.id, input.id))
      .returning();
    await auditConfig(user, "admin.claim.update", "claim", before.id, before, after, PATH);
    return { id: before.id };
  }
  const [row] = await db
    .insert(s.claims)
    .values({ ...values, approverId: user.id })
    .returning();
  await auditConfig(user, "admin.claim.create", "claim", row!.id, null, row, PATH);
  return { id: row!.id };
});

export const deleteClaim = action(idSchema, async (input, user) => {
  await requireAdmin(user);
  const [before] = await db.select().from(s.claims).where(eq(s.claims.id, input.id));
  if (!before) throw new UserError("Claim not found.");
  await db.delete(s.claims).where(eq(s.claims.id, input.id));
  await auditConfig(user, "admin.claim.delete", "claim", before.id, before, null, PATH);
  return { id: before.id };
});
