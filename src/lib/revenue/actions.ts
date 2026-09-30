"use server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, canSeeRestricted, ForbiddenError, inScope, type AppUser } from "@/lib/rbac/server";
import { assertRevenueDeal } from "./access";

const money = z.number().int().min(1, "Amount must be positive").max(100_000_000_000);
const dateStr = z.iso.date("Pick a date");
const toDate = (d: string) => new Date(`${d}T12:00:00Z`);

async function loadInvoice(user: AppUser, id: string, act: "edit" | "delete") {
  await assertCan(user, "revenue", act);
  const [inv] = await db.select().from(s.invoices).where(eq(s.invoices.id, id));
  if (!inv) throw new UserError("Invoice not found.");
  if (!(await assertRevenueDeal(user, inv.dealId, act))) throw new ForbiddenError();
  return inv;
}

const invoiceFields = {
  amountCents: money,
  dueAt: dateStr,
  paidInKind: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
};

export const createInvoice = action(z.object({ dealId: z.uuid("Pick a deal"), ...invoiceFields }), async (input, user) => {
  await assertCan(user, "revenue", "create");
  if (!(await assertRevenueDeal(user, input.dealId, "create"))) throw new ForbiddenError();
  const [row] = await db
    .insert(s.invoices)
    .values({ dealId: input.dealId, amountCents: input.amountCents, dueAt: toDate(input.dueAt), paidInKind: input.paidInKind || null, notes: input.notes || null })
    .returning();
  await audit({ actorId: user.id, action: "invoice.create", entity: "invoice", entityId: row!.id, after: row });
  revalidatePath("/revenue");
  return { id: row!.id };
});

export const updateInvoice = action(z.object({ id: z.uuid(), ...invoiceFields }), async (input, user) => {
  const before = await loadInvoice(user, input.id, "edit");
  const patch = { amountCents: input.amountCents, dueAt: toDate(input.dueAt), paidInKind: input.paidInKind || null, notes: input.notes || null };
  await db.update(s.invoices).set(patch).where(eq(s.invoices.id, input.id));
  await audit({ actorId: user.id, action: "invoice.update", entity: "invoice", entityId: input.id, before, after: patch });
  revalidatePath("/revenue");
  return { id: input.id };
});

export const setInvoiceStatus = action(
  z.object({ id: z.uuid(), status: z.enum(["scheduled", "sent", "paid", "written_off"]), paidAt: dateStr.optional() }),
  async ({ id, status, paidAt }, user) => {
    const before = await loadInvoice(user, id, "edit");
    const patch = {
      status,
      paidAt: status === "paid" ? (paidAt ? toDate(paidAt) : new Date()) : null,
    };
    await db.update(s.invoices).set(patch).where(eq(s.invoices.id, id));
    await audit({ actorId: user.id, action: `invoice.${status}`, entity: "invoice", entityId: id, before: { status: before.status, paidAt: before.paidAt }, after: patch });
    revalidatePath("/revenue");
    revalidatePath("/commissions");
    return { id, status };
  },
);

export const deleteInvoice = action(z.object({ id: z.uuid() }), async ({ id }, user) => {
  const before = await loadInvoice(user, id, "delete");
  if (before.status === "paid") throw new UserError("Paid invoices can't be deleted — write them off instead.");
  await db.delete(s.invoices).where(eq(s.invoices.id, id));
  await audit({ actorId: user.id, action: "invoice.delete", entity: "invoice", entityId: id, before, after: null });
  revalidatePath("/revenue");
  return { id };
});

/** ADS-2 billing schedule fields on the deal (requires deals_ADS edit on the record). */
export const updateBilling = action(
  z.object({
    dealId: z.uuid(),
    annualizedValueCents: z.number().int().min(0).max(100_000_000_000).nullable(),
    nextPaymentCents: z.number().int().min(0).max(100_000_000_000).nullable(),
    nextPaymentAt: dateStr.nullable(),
    renewalAt: dateStr.nullable(),
  }),
  async (input, user) => {
    const scope = await assertCan(user, "deals_ADS", "edit");
    const [row] = await db
      .select({ deal: s.deals, key: s.pipelines.key })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .where(eq(s.deals.id, input.dealId));
    if (!row || row.deal.deletedAt || row.key !== "ADS") throw new UserError("Sponsorship deal not found.");
    const splits = await db.select({ userId: s.dealSplits.userId }).from(s.dealSplits).where(eq(s.dealSplits.dealId, input.dealId));
    if (!inScope(user, scope, { ownerId: row.deal.ownerId, teamId: row.deal.teamId, splitUserIds: splits.map((x) => x.userId), pipelineKey: "ADS" }))
      throw new ForbiddenError();
    if (row.deal.restricted && !(await canSeeRestricted(user, "deal", row.deal.id))) throw new ForbiddenError();
    const patch = {
      annualizedValueCents: input.annualizedValueCents,
      nextPaymentCents: input.nextPaymentCents,
      nextPaymentAt: input.nextPaymentAt ? toDate(input.nextPaymentAt) : null,
      renewalAt: input.renewalAt ? toDate(input.renewalAt) : null,
    };
    await db.update(s.deals).set(patch).where(eq(s.deals.id, input.dealId));
    const d = row.deal;
    await audit({
      actorId: user.id,
      action: "deal.billing_update",
      entity: "deal",
      entityId: input.dealId,
      before: { annualizedValueCents: d.annualizedValueCents, nextPaymentCents: d.nextPaymentCents, nextPaymentAt: d.nextPaymentAt, renewalAt: d.renewalAt },
      after: patch,
    });
    revalidatePath("/revenue");
    return { id: input.dealId };
  },
);
