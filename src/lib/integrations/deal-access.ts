import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealAccessWhere, type AppUser } from "@/lib/rbac/server";

/** A deal the user may view/edit (per-pipeline scope, ownership/splits/team, restricted access list), or null. */
export async function getAccessibleDeal(user: AppUser, dealId: string, action: "view" | "edit" = "view") {
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
}
