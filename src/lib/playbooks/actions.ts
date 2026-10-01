"use server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { auditConfig, requireAdmin } from "@/lib/admin/guard";
import { playbookInputSchema } from "./core";

const PATH = "/admin/playbooks";

/** Create or replace the playbook of a stage (one per stage). Admin: configure. Audited with before/after. */
export const savePlaybook = action(playbookInputSchema, async (input, user) => {
  await requireAdmin(user);
  const [stage] = await db.select({ id: s.stages.id, name: s.stages.name }).from(s.stages).where(eq(s.stages.id, input.stageId));
  if (!stage) throw new UserError("That stage no longer exists.");
  const [before] = await db.select().from(s.stagePlaybooks).where(eq(s.stagePlaybooks.stageId, input.stageId));
  const values = {
    stageId: input.stageId,
    name: input.name,
    guidance: input.guidance?.trim() || null,
    tasks: input.tasks.map((t) => ({ ...t, description: t.description?.trim() || undefined })),
    emailTemplates: input.emailTemplates,
    active: input.active,
    updatedBy: user.id,
  };
  const [row] = await db
    .insert(s.stagePlaybooks)
    .values(values)
    .onConflictDoUpdate({ target: s.stagePlaybooks.stageId, set: { ...values, updatedAt: new Date() } })
    .returning({ id: s.stagePlaybooks.id });
  await auditConfig(
    user,
    before ? "admin.playbook.update" : "admin.playbook.create",
    "stage_playbook",
    row!.id,
    before ? { name: before.name, guidance: before.guidance, tasks: before.tasks, emailTemplates: before.emailTemplates, active: before.active } : null,
    { stage: stage.name, ...values },
    PATH,
  );
  return { id: row!.id };
});

export const setPlaybookActive = action(z.object({ stageId: z.string().uuid(), active: z.boolean() }), async ({ stageId, active }, user) => {
  await requireAdmin(user);
  const [before] = await db.select({ id: s.stagePlaybooks.id, active: s.stagePlaybooks.active }).from(s.stagePlaybooks).where(eq(s.stagePlaybooks.stageId, stageId));
  if (!before) throw new UserError("This stage has no playbook yet.");
  await db.update(s.stagePlaybooks).set({ active, updatedBy: user.id, updatedAt: new Date() }).where(eq(s.stagePlaybooks.id, before.id));
  await auditConfig(user, active ? "admin.playbook.enable" : "admin.playbook.disable", "stage_playbook", before.id, { active: before.active }, { active }, PATH);
  return { active };
});
