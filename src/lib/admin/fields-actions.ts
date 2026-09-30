"use server";
import { and, asc, eq, max } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { auditConfig, requireAdmin } from "@/lib/admin/guard";
import {
  fieldDefSchema,
  idSchema,
  isUniqueViolation,
  moveItem,
  picklistActiveSchema,
  picklistAddSchema,
  picklistLabelSchema,
  stageMoveSchema,
} from "./config-schemas";

const PATH = "/admin/fields";

/* ───────────────────────────── Custom field definitions ───────────────────────────── */

async function checkPipelineAndStages(pipelineKey: string | null, requiredAtStages: string[]) {
  if (!pipelineKey) return;
  const [pipe] = await db.select({ id: s.pipelines.id }).from(s.pipelines).where(eq(s.pipelines.key, pipelineKey));
  if (!pipe) throw new UserError(`Unknown pipeline "${pipelineKey}".`);
  if (!requiredAtStages.length) return;
  const rows = await db.select({ key: s.stages.key }).from(s.stages).where(eq(s.stages.pipelineId, pipe.id));
  const keys = new Set(rows.map((r) => r.key));
  const bad = requiredAtStages.filter((k) => !keys.has(k));
  if (bad.length) throw new UserError(`Unknown stage(s) for ${pipelineKey}: ${bad.join(", ")}.`);
}

export const saveFieldDef = action(fieldDefSchema, async (input, user) => {
  await requireAdmin(user);
  await checkPipelineAndStages(input.pipelineKey, input.requiredAtStages);
  const values = {
    entity: input.entity,
    pipelineKey: input.pipelineKey,
    label: input.label,
    fieldType: input.fieldType,
    options: input.options,
    requiredAtStages: Array.from(new Set(input.requiredAtStages)),
    helpText: input.helpText,
    sortOrder: input.sortOrder,
  };
  try {
    if (input.id) {
      const [before] = await db.select().from(s.customFieldDefs).where(eq(s.customFieldDefs.id, input.id));
      if (!before) throw new UserError("Field not found.");
      if (before.key !== input.key || before.entity !== input.entity)
        throw new UserError("A field's key and object can't change after creation (existing data is stored under the key).");
      const [after] = await db.update(s.customFieldDefs).set(values).where(eq(s.customFieldDefs.id, input.id)).returning();
      await auditConfig(user, "admin.custom_field.update", "custom_field_def", before.id, before, after, PATH);
      return { id: before.id };
    }
    const [row] = await db
      .insert(s.customFieldDefs)
      .values({ ...values, key: input.key })
      .returning();
    await auditConfig(user, "admin.custom_field.create", "custom_field_def", row!.id, null, row, PATH);
    return { id: row!.id };
  } catch (e) {
    if (isUniqueViolation(e)) throw new UserError(`A ${input.entity} field with key "${input.key}" already exists.`);
    throw e;
  }
});

export const deleteFieldDef = action(idSchema, async (input, user) => {
  await requireAdmin(user);
  const [before] = await db.select().from(s.customFieldDefs).where(eq(s.customFieldDefs.id, input.id));
  if (!before) throw new UserError("Field not found.");
  await db.delete(s.customFieldDefs).where(eq(s.customFieldDefs.id, input.id));
  await auditConfig(user, "admin.custom_field.delete", "custom_field_def", before.id, before, null, PATH);
  return { id: before.id };
});

/* ───────────────────────────── Picklists ───────────────────────────── */

async function loadValue(id: string) {
  const [row] = await db.select().from(s.picklists).where(eq(s.picklists.id, id));
  if (!row) throw new UserError("Picklist value not found.");
  return row;
}

export const addPicklistValue = action(picklistAddSchema, async (input, user) => {
  await requireAdmin(user);
  const [{ top }] = await db.select({ top: max(s.picklists.sortOrder) }).from(s.picklists).where(eq(s.picklists.list, input.list));
  try {
    const [row] = await db
      .insert(s.picklists)
      .values({ list: input.list, value: input.value, label: input.label || input.value, sortOrder: (top ?? -1) + 1 })
      .returning();
    await auditConfig(user, "admin.picklist.add", "picklist", row!.id, null, row, PATH);
    return { id: row!.id };
  } catch (e) {
    if (isUniqueViolation(e)) throw new UserError(`"${input.value}" is already in the ${input.list} list.`);
    throw e;
  }
});

export const updatePicklistLabel = action(picklistLabelSchema, async (input, user) => {
  await requireAdmin(user);
  const before = await loadValue(input.id);
  await db.update(s.picklists).set({ label: input.label }).where(eq(s.picklists.id, input.id));
  await auditConfig(user, "admin.picklist.update", "picklist", before.id, { label: before.label }, { label: input.label }, PATH);
  return { id: before.id };
});

export const setPicklistActive = action(picklistActiveSchema, async (input, user) => {
  await requireAdmin(user);
  const before = await loadValue(input.id);
  await db.update(s.picklists).set({ active: input.active }).where(eq(s.picklists.id, input.id));
  await auditConfig(user, input.active ? "admin.picklist.activate" : "admin.picklist.deactivate", "picklist", before.id, { active: before.active }, { active: input.active }, PATH);
  return { id: before.id };
});

export const movePicklistValue = action(stageMoveSchema, async (input, user) => {
  await requireAdmin(user);
  const value = await loadValue(input.id);
  const siblings = await db
    .select({ id: s.picklists.id, value: s.picklists.value, sortOrder: s.picklists.sortOrder })
    .from(s.picklists)
    .where(eq(s.picklists.list, value.list))
    .orderBy(asc(s.picklists.sortOrder), asc(s.picklists.label));
  const next = moveItem(siblings, input.id, input.direction);
  if (next === siblings) return { moved: false };
  await db.transaction(async (tx) => {
    for (const [i, v] of next.entries()) if (v.sortOrder !== i) await tx.update(s.picklists).set({ sortOrder: i }).where(eq(s.picklists.id, v.id));
  });
  await auditConfig(user, "admin.picklist.reorder", "picklist_list", value.list, { order: siblings.map((v) => v.value) }, { order: next.map((v) => v.value) }, PATH);
  return { moved: true };
});

export const deletePicklistValue = action(idSchema, async (input, user) => {
  await requireAdmin(user);
  const before = await loadValue(input.id);
  await db.delete(s.picklists).where(and(eq(s.picklists.id, input.id), eq(s.picklists.list, before.list)));
  await auditConfig(user, "admin.picklist.delete", "picklist", before.id, before, null, PATH);
  return { id: before.id };
});
