import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { defaultChecklist } from "./calc";

/**
 * ONB-1 automation hook: create the migration project for a won NET/ENT/SPT deal (idempotent — returns the existing
 * project if there is one). No permission check: callers (stage-change automation, the createProject action) must have
 * authorized the deal transition already. Returns null for deals that don't hand off to onboarding.
 */
export async function ensureMigrationProject(dealId: string, opts: { actorId: string | null; ownerId?: string | null; targetGoLive?: Date | null }) {
  const [row] = await db
    .select({ deal: s.deals, key: s.pipelines.key })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .where(eq(s.deals.id, dealId));
  if (!row || row.deal.status !== "won" || !["NET", "ENT", "SPT"].includes(row.key)) return null;
  const [existing] = await db.select().from(s.migrationProjects).where(eq(s.migrationProjects.dealId, dealId));
  if (existing) return { project: existing, created: false };
  const [project] = await db
    .insert(s.migrationProjects)
    .values({
      dealId,
      accountId: row.deal.accountId,
      name: row.deal.name,
      ownerId: opts.ownerId ?? null,
      targetGoLive: opts.targetGoLive ?? null,
      checklist: defaultChecklist(),
    })
    .returning();
  await audit({ actorId: opts.actorId, actorKind: opts.actorId ? "user" : "system", action: "migration.create", entity: "migration", entityId: project!.id, after: project });
  return { project: project!, created: true };
}
