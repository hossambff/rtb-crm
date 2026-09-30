import "server-only";
import { eq } from "drizzle-orm";
import { db, type Executor } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { defaultChecklist } from "./calc";

/**
 * ONB-1 automation hook: create the migration project for a won NET/ENT/SPT deal (idempotent — returns the existing
 * project if there is one). No permission check: callers (stage-change automation, the createProject action) must have
 * authorized the deal transition already. Pass `q` (a transaction) when called inside the stage-change transaction —
 * the deals module's onDealWon does this, so there is one creation path. Returns null for deals that don't hand off to onboarding.
 * Every query (audit included) runs on `q`, so no second pooled connection is needed while the caller's transaction is open.
 */
export async function ensureMigrationProject(dealId: string, opts: { actorId: string | null; ownerId?: string | null; targetGoLive?: Date | null }, q: Executor = db) {
  const [row] = await q
    .select({ deal: s.deals, key: s.pipelines.key })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .where(eq(s.deals.id, dealId));
  if (!row || row.deal.status !== "won" || !["NET", "ENT", "SPT"].includes(row.key)) return null;
  const [existing] = await q.select().from(s.migrationProjects).where(eq(s.migrationProjects.dealId, dealId));
  if (existing) return { project: existing, created: false };
  // unique migration_projects(deal_id): a concurrent won move waits on the other insert, then does nothing (H-11).
  const [project] = await q
    .insert(s.migrationProjects)
    .values({
      dealId,
      accountId: row.deal.accountId,
      name: row.deal.name,
      // QA-26: default the migration owner to the deal owner (the person who closed it) until onboarding reassigns.
      ownerId: opts.ownerId ?? row.deal.ownerId ?? null,
      targetGoLive: opts.targetGoLive ?? null,
      checklist: defaultChecklist(),
    })
    .onConflictDoNothing()
    .returning();
  if (!project) {
    const [again] = await q.select().from(s.migrationProjects).where(eq(s.migrationProjects.dealId, dealId));
    return again ? { project: again, created: false } : null;
  }
  await audit({ actorId: opts.actorId, actorKind: opts.actorId ? "user" : "system", action: "migration.create", entity: "migration", entityId: project.id, after: project }, q);
  return { project, created: true };
}
