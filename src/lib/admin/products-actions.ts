"use server";
import { count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { auditConfig, requireAdmin } from "@/lib/admin/guard";
import { idSchema, parseJsonObject, productSchema } from "./config-schemas";

const PATH = "/admin/products";

async function checkPipelineKeys(keys: string[]) {
  if (!keys.length) return;
  const rows = await db.select({ key: s.pipelines.key }).from(s.pipelines).where(inArray(s.pipelines.key, keys));
  const known = new Set(rows.map((r) => r.key));
  const bad = keys.filter((k) => !known.has(k));
  if (bad.length) throw new UserError(`Unknown pipeline(s): ${bad.join(", ")}.`);
}

export const saveProduct = action(productSchema, async (input, user) => {
  await requireAdmin(user);
  const pipelineKeys = Array.from(new Set(input.pipelineKeys));
  await checkPipelineKeys(pipelineKeys);
  const terms = parseJsonObject(input.defaultTermsText);
  if (!terms.ok) throw new UserError(terms.error);
  const values = {
    family: input.family,
    name: input.name,
    sku: input.sku,
    description: input.description,
    pipelineKeys,
    pricingModel: input.pricingModel,
    status: input.status,
    active: input.active,
    defaultTerms: terms.value,
  };
  if (input.id) {
    const [before] = await db.select().from(s.products).where(eq(s.products.id, input.id));
    if (!before) throw new UserError("Product not found.");
    const [after] = await db.update(s.products).set(values).where(eq(s.products.id, input.id)).returning();
    await auditConfig(user, "admin.product.update", "product", before.id, before, after, PATH);
    return { id: before.id };
  }
  const [row] = await db.insert(s.products).values(values).returning();
  await auditConfig(user, "admin.product.create", "product", row!.id, null, row, PATH);
  return { id: row!.id };
});

export const deleteProduct = action(idSchema, async (input, user) => {
  await requireAdmin(user);
  const [before] = await db.select().from(s.products).where(eq(s.products.id, input.id));
  if (!before) throw new UserError("Product not found.");
  const [[lines], [claimRefs]] = await Promise.all([
    db.select({ n: count() }).from(s.dealLineItems).where(eq(s.dealLineItems.productId, input.id)),
    db.select({ n: count() }).from(s.claims).where(eq(s.claims.productId, input.id)),
  ]);
  const used = Number(lines?.n ?? 0);
  if (used > 0) throw new UserError(`"${before.name}" is on ${used} deal line item${used === 1 ? "" : "s"}. Mark it inactive or retired instead.`);
  if (Number(claimRefs?.n ?? 0) > 0) throw new UserError(`"${before.name}" is referenced by claims in the library. Unlink them first or mark the product inactive.`);
  await db.delete(s.products).where(eq(s.products.id, input.id));
  await auditConfig(user, "admin.product.delete", "product", before.id, before, null, PATH);
  return { id: before.id };
});
