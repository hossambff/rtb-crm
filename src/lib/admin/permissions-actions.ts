"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { DEFAULT_MATRIX } from "@/lib/rbac/defaults";
import { ACTIONS, MODULES, ROLES, SCOPES, type Action, type Module, type Role } from "@/lib/rbac/model";
import { requireSuperAdmin } from "./guard";
import { FIELD_ACCESS, FIELD_ENTITIES } from "./permissions-core";

const PATH = "/admin/roles";
const EDITABLE_ROLES = ROLES.filter((r) => r !== "super_admin" && r !== "pending") as [string, ...string[]];

const cellSchema = z.object({
  role: z.enum(EDITABLE_ROLES),
  module: z.enum(MODULES),
  action: z.enum(ACTIONS),
  scope: z.enum(SCOPES),
});

/**
 * Set one cell of the module × action × scope matrix for a role (PRD §7). Setting a cell back to its default removes
 * the override row. Super admin only (security); super_admin's own matrix is locked to avoid lock-out.
 */
export const setRolePermission = action(cellSchema, async (input, user) => {
  await requireSuperAdmin(user);
  const def = DEFAULT_MATRIX[input.role as Role]?.[input.module as Module]?.[input.action as Action] ?? "none";
  const [before] = await db
    .select()
    .from(s.rolePermissions)
    .where(and(eq(s.rolePermissions.role, input.role), eq(s.rolePermissions.module, input.module), eq(s.rolePermissions.action, input.action)));
  if (input.scope === def) {
    await db
      .delete(s.rolePermissions)
      .where(and(eq(s.rolePermissions.role, input.role), eq(s.rolePermissions.module, input.module), eq(s.rolePermissions.action, input.action)));
  } else {
    await db
      .insert(s.rolePermissions)
      .values({ role: input.role, module: input.module, action: input.action, scope: input.scope, updatedBy: user.id })
      .onConflictDoUpdate({
        target: [s.rolePermissions.role, s.rolePermissions.module, s.rolePermissions.action],
        set: { scope: input.scope, updatedBy: user.id },
      });
  }
  await audit({
    actorId: user.id,
    action: "admin.permission.set",
    entity: "role_permission",
    entityId: `${input.role}:${input.module}:${input.action}`,
    before: { scope: before?.scope ?? def, override: Boolean(before) },
    after: { scope: input.scope, override: input.scope !== def, default: def },
  });
  revalidatePath(PATH);
  return { scope: input.scope, override: input.scope !== def };
});

export const resetRolePermissions = action(z.object({ role: z.enum(EDITABLE_ROLES), module: z.enum(MODULES).optional() }), async (input, user) => {
  await requireSuperAdmin(user);
  const where = input.module
    ? and(eq(s.rolePermissions.role, input.role), eq(s.rolePermissions.module, input.module))
    : eq(s.rolePermissions.role, input.role);
  const removed = await db.delete(s.rolePermissions).where(where).returning();
  if (!removed.length) throw new UserError("Nothing to reset — this role already uses the defaults.");
  await audit({
    actorId: user.id,
    action: "admin.permission.reset",
    entity: "role_permission",
    entityId: input.module ? `${input.role}:${input.module}` : input.role,
    before: removed.map((r) => ({ module: r.module, action: r.action, scope: r.scope })),
    after: null,
  });
  revalidatePath(PATH);
  return { removed: removed.length };
});

const fieldSchema = z.object({
  role: z.enum(EDITABLE_ROLES),
  entity: z.enum(FIELD_ENTITIES),
  field: z
    .string()
    .trim()
    .min(1, "Enter a field name.")
    .max(64)
    .regex(/^(\*|[a-zA-Z][a-zA-Z0-9_]*)$/, "Use the field's API name (e.g. revSharePct) or *."),
  access: z.enum(FIELD_ACCESS),
});

/** Field-level security override (PRD §7.1) stored in field_permissions. */
export const setFieldPermission = action(fieldSchema, async (input, user) => {
  await requireSuperAdmin(user);
  const key = and(eq(s.fieldPermissions.role, input.role), eq(s.fieldPermissions.entity, input.entity), eq(s.fieldPermissions.field, input.field));
  const [before] = await db.select().from(s.fieldPermissions).where(key);
  await db
    .insert(s.fieldPermissions)
    .values(input)
    .onConflictDoUpdate({ target: [s.fieldPermissions.role, s.fieldPermissions.entity, s.fieldPermissions.field], set: { access: input.access } });
  await audit({
    actorId: user.id,
    action: "admin.field_permission.set",
    entity: "field_permission",
    entityId: `${input.role}:${input.entity}.${input.field}`,
    before: before ?? null,
    after: input,
  });
  revalidatePath(PATH);
  return input;
});

export const deleteFieldPermission = action(fieldSchema.omit({ access: true }), async (input, user) => {
  await requireSuperAdmin(user);
  const key = and(eq(s.fieldPermissions.role, input.role), eq(s.fieldPermissions.entity, input.entity), eq(s.fieldPermissions.field, input.field));
  const [before] = await db.delete(s.fieldPermissions).where(key).returning();
  if (!before) throw new UserError("Override not found.");
  await audit({
    actorId: user.id,
    action: "admin.field_permission.delete",
    entity: "field_permission",
    entityId: `${input.role}:${input.entity}.${input.field}`,
    before,
    after: null,
  });
  revalidatePath(PATH);
  return { ok: true };
});
