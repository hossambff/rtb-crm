import "server-only";
import { and, asc, eq, exists, inArray, isNull, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { can, dealAccessWhere, inScope, scopeFor, type AppUser } from "@/lib/rbac/server";
import type { Scope } from "@/lib/rbac/model";
import { checklistProgress, daysInStage, hasSlipped, isStalled, type MigrationStage } from "./calc";

export type ProjectRow = {
  id: string;
  name: string;
  dealId: string | null;
  dealName: string | null;
  pipelineKey: string | null;
  accountName: string | null;
  stage: MigrationStage;
  launched: boolean;
  ownerId: string | null;
  ownerName: string | null;
  targetGoLive: string | null;
  actualGoLive: string | null;
  cloneUrl: string | null;
  liveUrl: string | null;
  blockers: string | null;
  notes: string | null;
  checklist: { item: string; done: boolean }[];
  progress: { done: number; total: number; pct: number };
  daysInStage: number;
  stalled: boolean;
  slipped: boolean;
  canEdit: boolean;
};

/** Projects of restricted deals are hidden unless the user is on the access list. */
function restrictedOk(user: AppUser): SQL {
  if (user.role === "super_admin") return sql`true`;
  return or(
    isNull(s.migrationProjects.dealId),
    eq(s.deals.restricted, false),
    exists(
      db
        .select({ x: sql`1` })
        .from(s.restrictedAccess)
        .where(and(eq(s.restrictedAccess.entity, "deal"), eq(s.restrictedAccess.entityId, s.deals.id), eq(s.restrictedAccess.userId, user.id))),
    ),
  )!;
}

export function projectScopeWhere(user: AppUser, scope: Scope): SQL {
  switch (scope) {
    case "all":
    case "pipeline":
      return sql`true`;
    case "team":
      return inArray(s.migrationProjects.ownerId, user.teamMemberIds.length ? user.teamMemberIds : [user.id]);
    case "own":
      return eq(s.migrationProjects.ownerId, user.id);
    default:
      return sql`false`;
  }
}

export async function getOnboardingData(user: AppUser) {
  const now = new Date();
  const [viewScope, editScope, canCreate] = await Promise.all([
    scopeFor(user, "onboarding", "view"),
    scopeFor(user, "onboarding", "edit"),
    can(user, "onboarding", "create"),
  ]);
  const rows = await db
    .select({
      p: s.migrationProjects,
      dealName: s.deals.name,
      pipelineKey: s.pipelines.key,
      accountName: s.accounts.name,
      ownerName: s.user.name,
    })
    .from(s.migrationProjects)
    .leftJoin(s.deals, eq(s.deals.id, s.migrationProjects.dealId))
    .leftJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.migrationProjects.accountId))
    .leftJoin(s.user, eq(s.user.id, s.migrationProjects.ownerId))
    .where(and(projectScopeWhere(user, viewScope), restrictedOk(user)))
    .orderBy(asc(s.migrationProjects.targetGoLive), asc(s.migrationProjects.name))
    .limit(2000);

  const projects: ProjectRow[] = rows.map(({ p, dealName, pipelineKey, accountName, ownerName }) => {
    const checklist = Array.isArray(p.checklist) ? p.checklist : [];
    return {
      id: p.id,
      name: p.name,
      dealId: p.dealId,
      dealName,
      pipelineKey,
      accountName,
      stage: p.stage,
      launched: p.launched,
      ownerId: p.ownerId,
      ownerName,
      targetGoLive: p.targetGoLive?.toISOString() ?? null,
      actualGoLive: p.actualGoLive?.toISOString() ?? null,
      cloneUrl: p.cloneUrl,
      liveUrl: p.liveUrl,
      blockers: p.blockers,
      notes: p.notes,
      checklist,
      progress: checklistProgress(checklist),
      daysInStage: daysInStage(p.stageEnteredAt, now),
      stalled: isStalled(p, now),
      slipped: hasSlipped(p, now),
      canEdit: editScope !== "none" && inScope(user, editScope, { ownerId: p.ownerId }),
    };
  });

  let wonDeals: { id: string; name: string; pipelineKey: string }[] = [];
  let owners: { id: string; name: string }[] = [];
  if (canCreate || editScope !== "none") {
    const access = await dealAccessWhere(user, "view");
    wonDeals = canCreate
      ? await db
          .select({ id: s.deals.id, name: s.deals.name, pipelineKey: s.pipelines.key })
          .from(s.deals)
          .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
          .where(
            and(
              access,
              eq(s.deals.status, "won"),
              inArray(s.pipelines.key, ["NET", "ENT", "SPT"]),
              notExists(db.select({ x: sql`1` }).from(s.migrationProjects).where(eq(s.migrationProjects.dealId, s.deals.id))),
            ),
          )
          .orderBy(asc(s.deals.name))
          .limit(500)
      : [];
    owners = await db
      .select({ id: s.user.id, name: s.user.name })
      .from(s.user)
      .where(and(ne(s.user.role, "pending"), or(isNull(s.user.banned), eq(s.user.banned, false))))
      .orderBy(asc(s.user.name));
  }

  return {
    projects,
    wonDeals,
    owners,
    perms: { canCreate, canEdit: editScope !== "none" },
    stats: {
      active: projects.filter((p) => !p.launched && p.stage !== "paused").length,
      stalled: projects.filter((p) => p.stalled).length,
      slipped: projects.filter((p) => p.slipped).length,
      launched: projects.filter((p) => p.launched).length,
    },
  };
}
