"use server";
import { and, asc, count, eq, max, or, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { auditConfig, requireAdmin } from "@/lib/admin/guard";
import { setSetting } from "@/lib/settings";
import {
  DEAL_FIELD_KEYS,
  idSchema,
  isUniqueViolation,
  moveItem,
  pipelineUpdateSchema,
  presetApplySchema,
  slugify,
  stageCreateSchema,
  stageMoveSchema,
  stageUpdateSchema,
} from "./config-schemas";
import { presetSettingKey, previewPreset } from "./presets";

const PATH = "/admin/pipelines";

async function loadStage(id: string) {
  const [row] = await db.select().from(s.stages).where(eq(s.stages.id, id));
  if (!row) throw new UserError("Stage not found.");
  return row;
}

export const updatePipeline = action(pipelineUpdateSchema, async (input, user) => {
  await requireAdmin(user);
  const [before] = await db.select().from(s.pipelines).where(eq(s.pipelines.id, input.id));
  if (!before) throw new UserError("Pipeline not found.");
  const patch = {
    name: input.name,
    description: input.description,
    color: input.color,
    usdPerMuu: input.usdPerMuu,
    defaultRevSharePct: input.defaultRevSharePct,
    active: input.active,
  };
  const [after] = await db.update(s.pipelines).set(patch).where(eq(s.pipelines.id, input.id)).returning();
  await auditConfig(user, "admin.pipeline.update", "pipeline", before.id, pick(before, patch), pick(after!, patch), PATH);
  return { id: before.id };
});

export const createStage = action(stageCreateSchema, async (input, user) => {
  await requireAdmin(user);
  const [pipe] = await db.select({ id: s.pipelines.id }).from(s.pipelines).where(eq(s.pipelines.id, input.pipelineId));
  if (!pipe) throw new UserError("Pipeline not found.");
  const key = slugify(input.name);
  const [dupe] = await db
    .select({ id: s.stages.id })
    .from(s.stages)
    .where(and(eq(s.stages.pipelineId, input.pipelineId), eq(s.stages.key, key)));
  if (dupe) throw new UserError(`A stage with key "${key}" already exists in this pipeline. Use a different name.`);
  const [{ top }] = await db.select({ top: max(s.stages.sortOrder) }).from(s.stages).where(eq(s.stages.pipelineId, input.pipelineId));
  try {
    const [row] = await db
      .insert(s.stages)
      .values({
        pipelineId: input.pipelineId,
        key,
        name: input.name,
        sortOrder: (top ?? -1) + 1,
        probability: input.probability,
        category: input.category,
        slaDays: input.slaDays,
      })
      .returning();
    await auditConfig(user, "admin.stage.create", "stage", row!.id, null, row, PATH);
    return { id: row!.id, key };
  } catch (e) {
    if (isUniqueViolation(e)) throw new UserError(`A stage with key "${key}" already exists in this pipeline.`);
    throw e;
  }
});

export const updateStage = action(stageUpdateSchema, async (input, user) => {
  await requireAdmin(user);
  const before = await loadStage(input.id);
  const [pipe] = await db.select({ key: s.pipelines.key }).from(s.pipelines).where(eq(s.pipelines.id, before.pipelineId));
  const custom = await db
    .select({ key: s.customFieldDefs.key })
    .from(s.customFieldDefs)
    .where(and(eq(s.customFieldDefs.entity, "deal"), or(isNull(s.customFieldDefs.pipelineKey), eq(s.customFieldDefs.pipelineKey, pipe?.key ?? ""))));
  const allowed = new Set([...DEAL_FIELD_KEYS, ...custom.map((c) => c.key)]);
  const unknown = input.requiredFields.filter((f) => !allowed.has(f));
  if (unknown.length) throw new UserError(`Unknown required field(s): ${unknown.join(", ")}.`);
  const patch = {
    name: input.name,
    probability: input.probability,
    category: input.category,
    slaDays: input.slaDays,
    requiredFields: Array.from(new Set(input.requiredFields)),
    requiresApproval: input.requiresApproval,
    importAliases: input.importAliases,
  };
  const [after] = await db.update(s.stages).set(patch).where(eq(s.stages.id, input.id)).returning();
  await auditConfig(user, "admin.stage.update", "stage", before.id, pick(before, patch), pick(after!, patch), PATH);
  return { id: before.id };
});

export const moveStage = action(stageMoveSchema, async (input, user) => {
  await requireAdmin(user);
  const stage = await loadStage(input.id);
  const siblings = await db
    .select({ id: s.stages.id, key: s.stages.key, sortOrder: s.stages.sortOrder })
    .from(s.stages)
    .where(eq(s.stages.pipelineId, stage.pipelineId))
    .orderBy(asc(s.stages.sortOrder), asc(s.stages.createdAt));
  const next = moveItem(siblings, input.id, input.direction);
  if (next === siblings) return { moved: false };
  await db.transaction(async (tx) => {
    for (const [i, st] of next.entries()) {
      if (st.sortOrder !== i) await tx.update(s.stages).set({ sortOrder: i }).where(eq(s.stages.id, st.id));
    }
  });
  await auditConfig(
    user,
    "admin.stage.reorder",
    "pipeline",
    stage.pipelineId,
    { order: siblings.map((x) => x.key) },
    { order: next.map((x) => x.key) },
    PATH,
  );
  return { moved: true };
});

export const deleteStage = action(idSchema, async (input, user) => {
  await requireAdmin(user);
  const before = await loadStage(input.id);
  const [[deals], [history]] = await Promise.all([
    db.select({ n: count() }).from(s.deals).where(eq(s.deals.stageId, input.id)),
    db
      .select({ n: count() })
      .from(s.dealStageHistory)
      .where(or(eq(s.dealStageHistory.toStageId, input.id), eq(s.dealStageHistory.fromStageId, input.id))),
  ]);
  const n = Number(deals?.n ?? 0);
  if (n > 0) throw new UserError(`${n} deal${n === 1 ? "" : "s"} are in "${before.name}". Move them to another stage before deleting it.`);
  if (Number(history?.n ?? 0) > 0)
    throw new UserError(`"${before.name}" appears in deal stage history, so it can't be deleted. Rename it or stop using it instead.`);
  await db.delete(s.stages).where(eq(s.stages.id, input.id));
  // Close the gap in sortOrder.
  const rest = await db
    .select({ id: s.stages.id, sortOrder: s.stages.sortOrder })
    .from(s.stages)
    .where(eq(s.stages.pipelineId, before.pipelineId))
    .orderBy(asc(s.stages.sortOrder));
  await db.transaction(async (tx) => {
    for (const [i, st] of rest.entries()) if (st.sortOrder !== i) await tx.update(s.stages).set({ sortOrder: i }).where(eq(s.stages.id, st.id));
  });
  await auditConfig(user, "admin.stage.delete", "stage", before.id, before, null, PATH);
  return { id: before.id };
});

export const applyProbabilityPreset = action(presetApplySchema, async (input, user) => {
  await requireAdmin(user);
  const [pipe] = await db.select().from(s.pipelines).where(eq(s.pipelines.id, input.pipelineId));
  if (!pipe) throw new UserError("Pipeline not found.");
  if (pipe.unit !== "muu") throw new UserError("Probability presets apply to MUU pipelines only.");
  const stageRows = await db.select().from(s.stages).where(eq(s.stages.pipelineId, pipe.id)).orderBy(asc(s.stages.sortOrder));
  const changes = previewPreset(input.preset, stageRows);
  const [prevPreset] = await db.select().from(s.appSettings).where(eq(s.appSettings.key, presetSettingKey(pipe.key)));
  await db.transaction(async (tx) => {
    for (const c of changes) if (c.changed) await tx.update(s.stages).set({ probability: c.after }).where(eq(s.stages.id, c.id));
  });
  await setSetting(presetSettingKey(pipe.key), input.preset, user.id);
  await auditConfig(
    user,
    "admin.pipeline.preset_apply",
    "pipeline",
    pipe.id,
    { preset: prevPreset?.value ?? null, probabilities: Object.fromEntries(changes.map((c) => [c.key, c.before])) },
    { preset: input.preset, probabilities: Object.fromEntries(changes.map((c) => [c.key, c.after])) },
    PATH,
  );
  return { changed: changes.filter((c) => c.changed).length };
});

function pick<T extends Record<string, unknown>>(row: T, shape: Record<string, unknown>): Partial<T> {
  return Object.fromEntries(Object.keys(shape).map((k) => [k, row[k]])) as Partial<T>;
}
