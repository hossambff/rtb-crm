"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, canSeeRestricted, dealAccessWhere, ForbiddenError, inScope, type AppUser } from "@/lib/rbac/server";
import { MIGRATION_STAGES, stageTransition } from "./calc";
import { ensureMigrationProject } from "./service";

const toDate = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00Z`) : null);

async function editableProject(user: AppUser, id: string) {
  const scope = await assertCan(user, "onboarding", "edit");
  const [p] = await db.select().from(s.migrationProjects).where(eq(s.migrationProjects.id, id));
  if (!p) throw new UserError("Migration project not found.");
  if (!inScope(user, scope, { ownerId: p.ownerId })) throw new ForbiddenError();
  if (p.dealId) {
    const [d] = await db.select({ restricted: s.deals.restricted }).from(s.deals).where(eq(s.deals.id, p.dealId));
    if (d?.restricted && !(await canSeeRestricted(user, "deal", p.dealId))) throw new ForbiddenError();
  }
  return p;
}

/** Create a migration project for a won NET/ENT/SPT deal (ONB-1). Also usable by an automation after Deal → Won. */
export const createProject = action(
  z.object({ dealId: z.uuid("Pick a won deal"), ownerId: z.string().min(1).nullable().optional(), targetGoLive: z.iso.date().nullable().optional() }),
  async (input, user) => {
    await assertCan(user, "onboarding", "create");
    const [deal] = await db
      .select({ deal: s.deals, key: s.pipelines.key })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .where(and(eq(s.deals.id, input.dealId), await dealAccessWhere(user, "view")));
    if (!deal) throw new UserError("Deal not found.");
    if (deal.deal.status !== "won") throw new UserError("Only won deals can start a migration.");
    if (!["NET", "ENT", "SPT"].includes(deal.key)) throw new UserError("Migrations apply to NetDev, Enterprise and Sports deals.");
    const [existing] = await db.select({ id: s.migrationProjects.id }).from(s.migrationProjects).where(eq(s.migrationProjects.dealId, input.dealId));
    if (existing) throw new UserError("This deal already has a migration project.");
    const res = await ensureMigrationProject(input.dealId, { actorId: user.id, ownerId: input.ownerId ?? null, targetGoLive: toDate(input.targetGoLive) });
    if (!res) throw new UserError("This deal can't start a migration.");
    const row = res.project;
    revalidatePath("/onboarding");
    return { id: row.id };
  },
);

export const updateProject = action(
  z.object({
    id: z.uuid(),
    ownerId: z.string().min(1).nullable(),
    targetGoLive: z.iso.date().nullable(),
    actualGoLive: z.iso.date().nullable(),
    cloneUrl: z.union([z.url({ protocol: /^https?$/ }), z.literal("")]).nullable(),
    liveUrl: z.union([z.url({ protocol: /^https?$/ }), z.literal("")]).nullable(),
    blockers: z.string().max(4000).nullable(),
    notes: z.string().max(8000).nullable(),
    launched: z.boolean(),
  }),
  async (input, user) => {
    const before = await editableProject(user, input.id);
    const patch = {
      ownerId: input.ownerId,
      targetGoLive: toDate(input.targetGoLive),
      actualGoLive: toDate(input.actualGoLive) ?? (input.launched && !before.actualGoLive ? new Date() : before.launched && !input.launched ? null : before.actualGoLive),
      cloneUrl: input.cloneUrl || null,
      liveUrl: input.liveUrl || null,
      blockers: input.blockers?.trim() || null,
      notes: input.notes?.trim() || null,
      launched: input.launched,
    };
    await db.update(s.migrationProjects).set(patch).where(eq(s.migrationProjects.id, input.id));
    await audit({ actorId: user.id, action: "migration.update", entity: "migration", entityId: input.id, before, after: patch });
    revalidatePath("/onboarding");
    return { id: input.id };
  },
);

export const moveProject = action(z.object({ id: z.uuid(), stage: z.enum(MIGRATION_STAGES) }), async ({ id, stage }, user) => {
  const before = await editableProject(user, id);
  if (before.stage === stage) return { id, stage };
  const now = new Date();
  const t = stageTransition(before, stage, now);
  const patch = { stage, stageEnteredAt: now, launched: t.launched, actualGoLive: t.actualGoLive };
  await db.update(s.migrationProjects).set(patch).where(eq(s.migrationProjects.id, id));
  await audit({ actorId: user.id, action: "migration.stage_change", entity: "migration", entityId: id, before: { stage: before.stage, launched: before.launched }, after: patch });
  revalidatePath("/onboarding");
  return { id, stage };
});

export const updateChecklist = action(
  z.object({
    id: z.uuid(),
    checklist: z.array(z.object({ item: z.string().trim().min(1).max(200), done: z.boolean() })).max(60),
  }),
  async ({ id, checklist }, user) => {
    const before = await editableProject(user, id);
    await db.update(s.migrationProjects).set({ checklist }).where(eq(s.migrationProjects.id, id));
    await audit({ actorId: user.id, action: "migration.checklist", entity: "migration", entityId: id, before: before.checklist, after: checklist });
    revalidatePath("/onboarding");
    return { id };
  },
);
