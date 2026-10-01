import "server-only";
import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealAccessWhere, type AppUser } from "@/lib/rbac/server";

/**
 * A deal the user may view/edit (per-pipeline scope, ownership/splits/team, restricted access list), or null.
 * Request-memoized (React cache, keyed by the cached user object + id + action): several slots of one page and the
 * transcript apply → stage change path ask the same question. Callers treat the row as read-only (access check +
 * pipeline/stage ids), so sharing it is safe; outside a React request (cron, scripts) cache is a pass-through.
 */
export const getAccessibleDeal = cache(async (user: AppUser, dealId: string, action: "view" | "edit" = "view") => {
  const where = await dealAccessWhere(user, action);
  const [d] = await db
    .select({
      id: s.deals.id,
      name: s.deals.name,
      stageId: s.deals.stageId,
      pipelineId: s.deals.pipelineId,
      pipelineKey: s.pipelines.key,
      accountId: s.deals.accountId,
      ownerId: s.deals.ownerId,
      status: s.deals.status,
      muu: s.deals.muu,
      nextStep: s.deals.nextStep,
      expectedCloseDate: s.deals.expectedCloseDate,
    })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .where(and(eq(s.deals.id, dealId), where))
    .limit(1);
  return d ?? null;
});
