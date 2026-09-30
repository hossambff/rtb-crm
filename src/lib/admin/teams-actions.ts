"use server";
import { count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { auditConfig, requireAdmin } from "@/lib/admin/guard";
import { idSchema, teamSchema } from "./config-schemas";

const PATH = "/admin/teams";

export const saveTeam = action(teamSchema, async (input, user) => {
  await requireAdmin(user);
  if (input.leadId) {
    const [lead] = await db.select({ id: s.user.id, role: s.user.role, banned: s.user.banned }).from(s.user).where(eq(s.user.id, input.leadId));
    if (!lead || lead.role === "pending" || lead.banned) throw new UserError("Choose an active user as team lead.");
  }
  const pipelineTypes = Array.from(new Set(input.pipelineTypes));
  if (pipelineTypes.length) {
    const rows = await db.select({ key: s.pipelines.key }).from(s.pipelines).where(inArray(s.pipelines.key, pipelineTypes));
    const known = new Set(rows.map((r) => r.key));
    const bad = pipelineTypes.filter((k) => !known.has(k));
    if (bad.length) throw new UserError(`Unknown pipeline(s): ${bad.join(", ")}.`);
  }
  const values = {
    name: input.name,
    leadId: input.leadId,
    pipelineTypes,
    territory: { regions: input.regions, verticals: input.verticals, leagues: input.leagues },
  };
  if (input.id) {
    const [before] = await db.select().from(s.teams).where(eq(s.teams.id, input.id));
    if (!before) throw new UserError("Team not found.");
    const [after] = await db.update(s.teams).set(values).where(eq(s.teams.id, input.id)).returning();
    await auditConfig(user, "admin.team.update", "team", before.id, before, after, PATH);
    return { id: before.id };
  }
  const [row] = await db.insert(s.teams).values(values).returning();
  await auditConfig(user, "admin.team.create", "team", row!.id, null, row, PATH);
  return { id: row!.id };
});

export const deleteTeam = action(idSchema, async (input, user) => {
  await requireAdmin(user);
  const [before] = await db.select().from(s.teams).where(eq(s.teams.id, input.id));
  if (!before) throw new UserError("Team not found.");
  const [{ n }] = await db.select({ n: count() }).from(s.user).where(eq(s.user.teamId, input.id));
  const members = Number(n);
  if (members > 0)
    throw new UserError(`"${before.name}" still has ${members} member${members === 1 ? "" : "s"}. Reassign them to another team (Admin → Users) first.`);
  await db.delete(s.teams).where(eq(s.teams.id, input.id));
  await auditConfig(user, "admin.team.delete", "team", before.id, before, null, PATH);
  return { id: before.id };
});
