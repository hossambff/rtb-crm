import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { getApifyToken } from "@/lib/apify/client";
import { reserveRun } from "./budget";
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
  // Budget check + run insert are serialized; the run reserves its full cap until it finishes (H-04).
  const { decision, runId } = await reserveRun(user, est.cents, { entity: "scout_search", entityId: search.id }, (d) => {
    if (!d.allowed)
      return { kind: "scout", searchId: search.id, requestedBy: user.id, status: "blocked", estimatedCostCents: est.cents, error: d.message, finishedAt: new Date() };
    // a search-level budget cap tightens the allowed spend further
    const cap = search.budgetCapCents != null ? Math.min(search.budgetCapCents, d.maxAllowedCents) : d.maxAllowedCents;
    const plan: ScoutPlan = { maxAllowedCents: cap, estimateCents: est.cents, criteria, overrideApprovalId: d.overrideApprovalId };
    const planStep: StepState = { key: "plan", label: "Plan & budget", actorId: "", status: "succeeded", output: plan, note: `Estimated $${(est.cents / 100).toFixed(2)}; cap $${(cap / 100).toFixed(2)}`, finishedAt: new Date().toISOString() };
    return { kind: "scout", searchId: search.id, requestedBy: user.id, status: "queued", estimatedCostCents: est.cents, actors: [planStep] as never, startedAt: new Date() };
  });
  if (!decision.allowed) return { runId, blocked: true, message: decision.message, canRequestMore: decision.canRequestMore, estimateCents: est.cents };
  return { runId, blocked: false, message: decision.message, canRequestMore: false, estimateCents: est.cents };
}
