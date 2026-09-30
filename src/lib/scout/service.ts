import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { getApifyToken } from "@/lib/apify/client";
import { checkRunBudget, consumeOverride } from "./budget";
import { criteriaSchema } from "./criteria";
import { estimateScout, type ScoutPlan } from "./pipeline";
import type { StepState } from "./runs";
import { getScoutSettings } from "./settings";

/**
 * Create a scout run for a search after the cost estimate + budget check (SCOUT-3/21). Blocked attempts are recorded
 * as runs with status "blocked" (cost 0) for governance. Shared by the runSearch action and the weekly cron.
 */
export async function startScoutRunFor(user: { id: string; role: string }, searchId: string): Promise<{ runId: string | null; blocked: boolean; message: string; canRequestMore: boolean; estimateCents: number }> {
  const [search] = await db.select().from(s.scoutSearches).where(eq(s.scoutSearches.id, searchId));
  if (!search) throw new UserError("Search not found.");
  const criteria = criteriaSchema.parse(search.criteria);
  const [settings, token] = await Promise.all([getScoutSettings(), getApifyToken()]);
  const est = await estimateScout(criteria, settings.budget.maxDomainsPerRun, Boolean(token));
  if (!criteria.domains.length && !token) throw new UserError("Connect Apify to discover domains, or add a domain list to score without Apify.");
  const decision = await checkRunBudget(user, est.cents, { entity: "scout_search", entityId: search.id });
  // a search-level budget cap tightens the allowed spend further
  const cap = search.budgetCapCents != null ? Math.min(search.budgetCapCents, decision.maxAllowedCents) : decision.maxAllowedCents;
  if (!decision.allowed) {
    const [blocked] = await db
      .insert(s.enrichmentRuns)
      .values({ kind: "scout", searchId: search.id, requestedBy: user.id, status: "blocked", estimatedCostCents: est.cents, error: decision.message, finishedAt: new Date() })
      .returning({ id: s.enrichmentRuns.id });
    return { runId: blocked!.id, blocked: true, message: decision.message, canRequestMore: decision.canRequestMore, estimateCents: est.cents };
  }
  const plan: ScoutPlan = { maxAllowedCents: cap, estimateCents: est.cents, criteria, overrideApprovalId: decision.overrideApprovalId };
  const planStep: StepState = { key: "plan", label: "Plan & budget", actorId: "", status: "succeeded", output: plan, note: `Estimated $${(est.cents / 100).toFixed(2)}; cap $${(cap / 100).toFixed(2)}`, finishedAt: new Date().toISOString() };
  const [run] = await db
    .insert(s.enrichmentRuns)
    .values({ kind: "scout", searchId: search.id, requestedBy: user.id, status: "queued", estimatedCostCents: est.cents, actors: [planStep] as never, startedAt: new Date() })
    .returning({ id: s.enrichmentRuns.id });
  if (decision.overrideApprovalId) await consumeOverride(decision.overrideApprovalId, run!.id);
  return { runId: run!.id, blocked: false, message: decision.message, canRequestMore: false, estimateCents: est.cents };
}
