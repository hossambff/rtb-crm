"use server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { setSetting } from "@/lib/settings";
import { assertCan } from "@/lib/rbac/server";
import { rollbackBatch } from "./engine";
import { assertCanRollback, loadTemplates, TEMPLATES_KEY, type ImportTemplate } from "./server";

export const saveImportTemplate = action(
  z.object({
    name: z.string().trim().min(1, "Name the template").max(80),
    target: z.enum(["accounts_deals", "contacts", "r100", "ads"]),
    pipelineKey: z.string().max(20).nullable(),
    mapping: z.record(z.string().max(200), z.string().max(60)),
  }),
  async (input, user) => {
    await assertCan(user, "import", "import");
    const all = await loadTemplates();
    const existing = all.find((t) => t.name.toLowerCase() === input.name.toLowerCase() && t.target === input.target);
    const tpl: ImportTemplate = {
      id: existing?.id ?? crypto.randomUUID(),
      name: input.name,
      target: input.target,
      pipelineKey: input.pipelineKey,
      mapping: Object.fromEntries(Object.entries(input.mapping).filter(([, v]) => v)),
      createdBy: user.id,
      createdAt: new Date().toISOString(),
    };
    const next = [...all.filter((t) => t.id !== tpl.id), tpl].slice(-100);
    await setSetting(TEMPLATES_KEY, next, user.id);
    await audit({ actorId: user.id, action: existing ? "import_template.update" : "import_template.create", entity: "app_setting", entityId: TEMPLATES_KEY, before: existing ?? null, after: tpl });
    return tpl;
  },
);

export const deleteImportTemplate = action(z.object({ id: z.string().uuid() }), async (input, user) => {
  await assertCan(user, "import", "import");
  const all = await loadTemplates();
  const tpl = all.find((t) => t.id === input.id);
  if (!tpl) return { ok: true };
  if (tpl.createdBy !== user.id && (await assertCan(user, "import", "import")) !== "all") throw new UserError("Only the author or an admin can delete this template.");
  await setSetting(TEMPLATES_KEY, all.filter((t) => t.id !== input.id), user.id);
  await audit({ actorId: user.id, action: "import_template.delete", entity: "app_setting", entityId: TEMPLATES_KEY, before: tpl });
  return { ok: true };
});

export const rollbackImport = action(z.object({ batchId: z.string().uuid() }), async (input, user) => {
  const [batch] = await db.select().from(s.importBatches).where(eq(s.importBatches.id, input.batchId));
  if (!batch) throw new UserError("Import not found.");
  if (batch.status === "rolled_back") throw new UserError("This import was already rolled back.");
  await assertCanRollback(user, batch.createdBy);
  const res = await rollbackBatch(db, batch.id, user.id); // writes its own audit entry (import.rollback)
  revalidatePath("/import");
  revalidatePath("/import/history");
  revalidatePath("/accounts");
  revalidatePath("/contacts");
  return res;
});
