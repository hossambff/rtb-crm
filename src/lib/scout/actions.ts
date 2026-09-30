"use server";
import { revalidatePath } from "next/cache";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { aiAvailable, aiObject, modelFor, untrusted } from "@/lib/ai";
import { audit } from "@/lib/audit";
import { ApifyError, getApifyToken, verifyApifyToken } from "@/lib/apify/client";
import { encryptSecret, maskSecret } from "@/lib/crypto";
import { assertCan, canSeeRestricted, dealModule, ForbiddenError, scopeFor, type AppUser } from "@/lib/rbac/server";
import { SCOPE_RANK } from "@/lib/rbac/model";
import { setSetting } from "@/lib/settings";
import { checkRunBudget, consumeOverride, notifyApprovers, pendingBudgetRequest } from "./budget";
import { addBusinessDays, addMonths, REJECT_SUPPRESS_MONTHS, SNOOZE_DAYS, type CrmMatch } from "./core";
import { coerceAiCriteria, criteriaSchema, describeCriteria, heuristicCriteria, nlCriteriaSchema, type Criteria } from "./criteria";
import { matchDomains, suppressedDomains, suppressedEmails } from "./crm-match";
import { runInBackground } from "./dispatch";
import { startScoutRunFor } from "./service";
import { estimateEnrichment, promoteOne, type EnrichPlan } from "./enrichment";
import { FIT_FACTORS } from "./fit";
import { estimateScout } from "./pipeline";
import { MANAGER_ROLES } from "./queries";
import type { StepState } from "./runs";
import { getScoutSettings } from "./settings";

const uuid = z.string().uuid();

/** Criteria is a superset of the jsonb column's declared shape (nullable MUU bounds, manual MUU map, flags). */
function dbCriteria(c: Criteria) {
  return c as unknown as typeof s.scoutSearches.$inferInsert.criteria;
}

function revalidate() {
  revalidatePath("/scout", "layout");
}

async function canEditSearch(user: AppUser, ownerId: string | null) {
  const scope = await scopeFor(user, "scout", "edit");
  if (scope === "all" || scope === "pipeline") return true;
  if (scope === "team") return ownerId != null && user.teamMemberIds.includes(ownerId);
  if (scope === "own") return ownerId === user.id;
  return false;
}

/* ───────────────────────────── Searches ───────────────────────────── */

const searchInput = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(2, "Give the search a name").max(120),
  criteria: criteriaSchema,
  schedule: z.enum(["once", "weekly"]).default("once"),
  budgetCapCents: z.number().int().min(0).max(100_000).nullable().optional(),
});

export const saveSearch = action(searchInput, async (input, user) => {
  await assertCan(user, "scout", "create");
  const sup = await suppressedDomains(input.criteria.domains);
  const criteria: Criteria = { ...input.criteria, domains: input.criteria.domains.filter((d) => !sup.has(d)) };
  if (input.id) {
    const [existing] = await db.select().from(s.scoutSearches).where(eq(s.scoutSearches.id, input.id));
    if (!existing) throw new UserError("Search not found.");
    if (!(await canEditSearch(user, existing.ownerId))) throw new ForbiddenError();
    await db
      .update(s.scoutSearches)
      .set({ name: input.name, criteria: dbCriteria(criteria), schedule: input.schedule, budgetCapCents: input.budgetCapCents ?? null })
      .where(eq(s.scoutSearches.id, input.id));
    await audit({ actorId: user.id, action: "scout_search.update", entity: "scout_search", entityId: input.id, before: existing, after: { name: input.name, criteria, schedule: input.schedule } });
    revalidate();
    return { id: input.id, suppressed: [...sup] };
  }
  const [row] = await db
    .insert(s.scoutSearches)
    .values({ name: input.name, ownerId: user.id, criteria: dbCriteria(criteria), schedule: input.schedule, budgetCapCents: input.budgetCapCents ?? null })
    .returning({ id: s.scoutSearches.id });
  await audit({ actorId: user.id, action: "scout_search.create", entity: "scout_search", entityId: row!.id, after: { name: input.name, criteria, schedule: input.schedule } });
  revalidate();
  return { id: row!.id, suppressed: [...sup] };
});

export const deleteSearch = action(z.object({ id: uuid }), async ({ id }, user) => {
  const [existing] = await db.select().from(s.scoutSearches).where(eq(s.scoutSearches.id, id));
  if (!existing) throw new UserError("Search not found.");
  if (!(await canEditSearch(user, existing.ownerId))) throw new ForbiddenError();
  const [accepted] = await db.select({ n: sql<number>`count(*)::int` }).from(s.scoutCandidates).where(and(eq(s.scoutCandidates.searchId, id), eq(s.scoutCandidates.state, "accepted")));
  if ((accepted?.n ?? 0) > 0) throw new UserError("This search has accepted candidates — keep it for funnel reporting. Set its schedule to once instead.");
  await db.delete(s.scoutSearches).where(eq(s.scoutSearches.id, id));
  await audit({ actorId: user.id, action: "scout_search.delete", entity: "scout_search", entityId: id, before: existing });
  revalidate();
  return { id };
});

/** Natural-language → structured criteria (SCOUT-2). Shown to the user for confirmation; never runs anything. */
export const parseNaturalLanguage = action(z.object({ text: z.string().trim().min(5).max(1000) }), async ({ text }, user) => {
  await assertCan(user, "scout", "create");
  const fallback = () => ({ criteria: heuristicCriteria(text), engine: "heuristic" as string });
  if (!aiAvailable() || SCOPE_RANK[await scopeFor(user, "copilot", "use_ai")] === 0) return { ...fallback(), summary: describeCriteria(heuristicCriteria(text)) };
  try {
    const settings = await getScoutSettings();
    const raw = await aiObject({
      kind: "scout_nl_search",
      userId: user.id,
      tier: "fast",
      schema: nlCriteriaSchema,
      prompt: [
        "Translate the seller's request into Lead Scout search filters for RTB (publisher platform deals sized by monthly unique users, MUU).",
        `Known verticals: ${settings.coreVerticals.join(", ")}, plus others. Use ISO country codes (UK → GB).`,
        "keywords: 1–3 short Google queries that would surface matching publisher websites (e.g. 'independent crypto news site').",
        "Only include filters the request states or clearly implies; leave others empty/null.",
        untrusted("seller_request", text, 2000),
      ].join("\n"),
    });
    const criteria = coerceAiCriteria(raw);
    return { criteria, engine: `ai:${await modelFor("fast")}`, summary: describeCriteria(criteria) };
  } catch {
    const f = fallback();
    return { ...f, summary: describeCriteria(f.criteria) };
  }
});

/** Cost estimate + budget decision before running (SCOUT-3). */
export const previewSearchRun = action(z.object({ searchId: uuid.optional(), criteria: criteriaSchema.optional() }), async (input, user) => {
  await assertCan(user, "scout", "create");
  let criteria = input.criteria;
  let entityId = input.searchId ?? "draft";
  if (input.searchId) {
    const [row] = await db.select().from(s.scoutSearches).where(eq(s.scoutSearches.id, input.searchId));
    if (!row) throw new UserError("Search not found.");
    criteria = criteriaSchema.parse(row.criteria);
    entityId = row.id;
  }
  if (!criteria) throw new UserError("Nothing to estimate.");
  const [settings, token] = await Promise.all([getScoutSettings(), getApifyToken()]);
  const est = await estimateScout(criteria, settings.budget.maxDomainsPerRun, Boolean(token));
  const budget = await checkRunBudget(user, est.cents, { entity: "scout_search", entityId });
  const pending = input.searchId ? await pendingBudgetRequest(user.id, "scout_search", input.searchId) : null;
  return { estimate: est, budget, pendingRequest: Boolean(pending), maxDomainsPerRun: settings.budget.maxDomainsPerRun };
});

/** Save + run. Actual execution happens after the response (per-step progress persisted on the run). */
export const runSearch = action(z.object({ searchId: uuid }), async ({ searchId }, user) => {
  await assertCan(user, "scout", "create");
  const [search] = await db.select({ ownerId: s.scoutSearches.ownerId }).from(s.scoutSearches).where(eq(s.scoutSearches.id, searchId));
  if (!search) throw new UserError("Search not found.");
  if (search.ownerId !== user.id && !(await canEditSearch(user, search.ownerId))) throw new ForbiddenError();
  const r = await startScoutRunFor(user, searchId);
  await audit({ actorId: user.id, action: r.blocked ? "scout_run.blocked" : "scout_run.start", entity: "scout_search", entityId: searchId, after: { runId: r.runId, estimateCents: r.estimateCents, message: r.message } });
  if (!r.blocked && r.runId) runInBackground(r.runId);
  revalidate();
  return r;
});

/** "Request more budget" → approvals row for an SVP (kind scout_budget). */
export const requestMoreBudget = action(
  z.object({ entity: z.enum(["scout_search", "account"]), entityId: z.string().min(1).max(64), amountCents: z.number().int().min(1).max(100_000), reason: z.string().trim().max(500).optional() }),
  async (input, user) => {
    const pending = await pendingBudgetRequest(user.id, input.entity, input.entityId);
    if (pending) return { id: pending.id, duplicate: true };
    const [row] = await db
      .insert(s.approvals)
      .values({ kind: "scout_budget", entity: input.entity, entityId: input.entityId, requestedBy: user.id, approverRole: "sales_leader", payload: { amountCents: input.amountCents, reason: input.reason ?? null, requesterName: user.name } })
      .returning({ id: s.approvals.id });
    await notifyApprovers(["sales_leader"], "Lead Scout budget request", `${user.name} requests $${(input.amountCents / 100).toFixed(2)} of Apify budget${input.reason ? `: ${input.reason}` : ""}`, "/scout?tab=budget");
    await audit({ actorId: user.id, action: "scout_budget.request", entity: "approval", entityId: row!.id, after: input });
    revalidate();
    return { id: row!.id, duplicate: false };
  },
);

/* ───────────────────────────── Review queue ───────────────────────────── */

async function loadCandidates(user: AppUser, ids: string[], needEdit = true) {
  const rows = await db
    .select({ c: s.scoutCandidates, ownerId: s.scoutSearches.ownerId })
    .from(s.scoutCandidates)
    .innerJoin(s.scoutSearches, eq(s.scoutSearches.id, s.scoutCandidates.searchId))
    .where(inArray(s.scoutCandidates.id, ids));
  if (needEdit) {
    if (SCOPE_RANK[await scopeFor(user, "scout", "edit")] === 0) throw new ForbiddenError("Your role can suggest targets only — your SVP reviews them.");
    for (const r of rows) if (!(await canEditSearch(user, r.ownerId))) throw new ForbiddenError("You can only review candidates from your own searches.");
  }
  return rows;
}

const ids = z.array(uuid).min(1).max(200);

export const rejectCandidates = action(z.object({ ids, reason: z.string().trim().min(2).max(60), note: z.string().trim().max(300).optional() }), async (input, user) => {
  const rows = await loadCandidates(user, input.ids);
  const until = addMonths(new Date(), REJECT_SUPPRESS_MONTHS).toISOString();
  for (const { c } of rows) {
    await db
      .update(s.scoutCandidates)
      .set({
        state: "rejected",
        rejectReason: input.note ? `${input.reason}: ${input.note}` : input.reason,
        reviewerId: user.id,
        reviewedAt: new Date(),
        raw: { ...(c.raw ?? {}), suppressedUntil: until },
      })
      .where(eq(s.scoutCandidates.id, c.id));
  }
  await audit({ actorId: user.id, action: "scout_candidate.reject", entity: "scout_candidate", entityId: input.ids.join(",").slice(0, 200), after: { reason: input.reason, count: rows.length } });
  revalidate();
  return { count: rows.length };
});

export const snoozeCandidates = action(z.object({ ids, days: z.number().int().min(1).max(365).default(SNOOZE_DAYS) }), async (input, user) => {
  const rows = await loadCandidates(user, input.ids);
  const until = new Date(Date.now() + input.days * 86_400_000).toISOString();
  for (const { c } of rows)
    await db.update(s.scoutCandidates).set({ state: "snoozed", reviewerId: user.id, reviewedAt: new Date(), raw: { ...(c.raw ?? {}), snoozedUntil: until } }).where(eq(s.scoutCandidates.id, c.id));
  await audit({ actorId: user.id, action: "scout_candidate.snooze", entity: "scout_candidate", entityId: input.ids.join(",").slice(0, 200), after: { until } });
  revalidate();
  return { count: rows.length };
});

export const markDuplicate = action(z.object({ ids, duplicateOf: z.string().trim().max(200).optional() }), async (input, user) => {
  const rows = await loadCandidates(user, input.ids);
  for (const { c } of rows)
    await db.update(s.scoutCandidates).set({ state: "duplicate", reviewerId: user.id, reviewedAt: new Date(), raw: { ...(c.raw ?? {}), duplicateOf: input.duplicateOf ?? null } }).where(eq(s.scoutCandidates.id, c.id));
  await audit({ actorId: user.id, action: "scout_candidate.duplicate", entity: "scout_candidate", entityId: input.ids.join(",").slice(0, 200), after: { duplicateOf: input.duplicateOf } });
  revalidate();
  return { count: rows.length };
});

export const restoreCandidates = action(z.object({ ids }), async (input, user) => {
  const rows = await loadCandidates(user, input.ids);
  for (const { c } of rows) {
    if (c.state === "accepted") continue;
    const raw = { ...(c.raw ?? {}) };
    delete raw.snoozedUntil;
    delete raw.suppressedUntil;
    await db.update(s.scoutCandidates).set({ state: "new", rejectReason: null, raw }).where(eq(s.scoutCandidates.id, c.id));
  }
  revalidate();
  return { count: rows.length };
});

const acceptInput = z.object({
  ids,
  pipelineKey: z.enum(["NET", "SPT", "ENT"]).optional(), // omitted → per-candidate routing suggestion
  ownerId: z.string().min(1).max(64).optional(),
  enrich: z.boolean().default(false),
});

type AcceptOutcome = { domain: string; ok: boolean; message: string; accountId?: string; dealId?: string; runId?: string | null };

/**
 * Accept → create/update Account + Target-stage deal (SCOUT-13), ownership protection (SCOUT-14), routing (SCOUT-15).
 * Interns / roles without scout edit get "suggest only": an approval request for an SVP.
 */
export const acceptCandidates = action(acceptInput, async (input, user) => {
  const editScope = await scopeFor(user, "scout", "edit");
  if (SCOPE_RANK[editScope] === 0) {
    await assertCan(user, "scout", "create");
    const rows = await loadCandidates(user, input.ids, false);
    const mine = rows.filter((r) => r.ownerId === user.id);
    if (!mine.length) throw new ForbiddenError();
    const [row] = await db
      .insert(s.approvals)
      .values({ kind: "scout_accept", entity: "scout_candidate", entityId: mine[0]!.c.id, requestedBy: user.id, approverRole: "sales_leader", payload: { candidateIds: mine.map((r) => r.c.id), domains: mine.map((r) => r.c.domain), pipelineKey: input.pipelineKey ?? null } })
      .returning({ id: s.approvals.id });
    await notifyApprovers(["sales_leader"], "Lead Scout targets suggested", `${user.name} suggests ${mine.length} target${mine.length > 1 ? "s" : ""}: ${mine.map((r) => r.c.domain).slice(0, 3).join(", ")}`, "/scout");
    await audit({ actorId: user.id, action: "scout_candidate.suggest", entity: "approval", entityId: row!.id, after: { domains: mine.map((r) => r.c.domain) } });
    revalidate();
    return { suggested: mine.length, outcomes: [] as AcceptOutcome[] };
  }
  const rows = await loadCandidates(user, input.ids);
  const ownerId = input.ownerId ?? user.id;
  const isManager = MANAGER_ROLES.includes(user.role);
  const [owner] = await db.select({ id: s.user.id, teamId: s.user.teamId, role: s.user.role, name: s.user.name }).from(s.user).where(eq(s.user.id, ownerId));
  if (!owner || owner.role === "pending") throw new UserError("Choose a valid owner.");
  await assertCan(user, "accounts", "create");
  const outcomes: AcceptOutcome[] = [];
  const pipes = await db.select().from(s.pipelines).where(inArray(s.pipelines.key, ["NET", "SPT", "ENT"]));
  const settings = await getScoutSettings();

  for (const { c } of rows) {
    const raw = (c.raw ?? {}) as { routing?: string; muuConfidence?: string; factorUsed?: number | null; doNotContact?: boolean };
    const pipelineKey = input.pipelineKey ?? (raw.routing as "NET" | "SPT" | "ENT" | undefined) ?? "NET";
    try {
      if (c.state === "accepted") {
        outcomes.push({ domain: c.domain, ok: true, message: "Already accepted" });
        continue;
      }
      const mod = dealModule(pipelineKey);
      const createScope = await scopeFor(user, mod, "create");
      if (SCOPE_RANK[createScope] === 0) throw new UserError(`You can't create ${pipelineKey} deals.`);
      if (ownerId !== user.id) {
        const [a1, a2] = await Promise.all([scopeFor(user, mod, "assign"), scopeFor(user, "scout", "assign")]);
        if (SCOPE_RANK[a1] === 0 && SCOPE_RANK[a2] === 0) throw new UserError("You can only accept targets to yourself.");
        if (a1 === "team" && !user.teamMemberIds.includes(ownerId)) throw new UserError("You can only assign to your team.");
      }
      if ((await suppressedDomains([c.domain])).size) throw new UserError("Domain is on the suppression list.");
      const pipe = pipes.find((p) => p.key === pipelineKey);
      if (!pipe) throw new UserError(`Pipeline ${pipelineKey} is not configured.`);
      const [target] = await db.select().from(s.stages).where(and(eq(s.stages.pipelineId, pipe.id), eq(s.stages.key, "target")));
      if (!target) throw new UserError(`${pipelineKey} has no Target stage.`);

      const match = (await matchDomains([c.domain])).get(c.domain);
      let existing: typeof s.accounts.$inferSelect | undefined;
      if (match?.accountId) [existing] = await db.select().from(s.accounts).where(eq(s.accounts.id, match.accountId));
      if (existing?.restricted && !(await canSeeRestricted(user, "account", existing.id))) throw new UserError("This account is restricted — ask an admin.");

      // SCOUT-14 ownership protection
      if (!isManager) {
        if (existing?.ownerId && existing.ownerId !== ownerId) throw new UserError("Account already has an owner — a manager must override.");
        if (existing) {
          const [reg] = await db
            .select({ userId: s.leadRegistrations.userId })
            .from(s.leadRegistrations)
            .where(and(eq(s.leadRegistrations.accountId, existing.id), eq(s.leadRegistrations.status, "approved"), gt(s.leadRegistrations.protectedUntil, new Date())));
          if (reg && reg.userId !== ownerId) throw new UserError("A commission rep has an approved registration on this account — a manager must override.");
        }
        if (match?.status === "open_deal" && match.ownerId && match.ownerId !== ownerId) throw new UserError(`Open deal owned by ${match.ownerName ?? "someone else"} — a manager must override.`);
      }

      const muuConfidence = (raw.muuConfidence === "reported" ? "reported" : raw.muuConfidence === "verified" ? "verified" : "estimate") as "estimate" | "reported" | "verified";
      const now = new Date();
      const result = await db.transaction(async (tx) => {
        let accountId: string;
        if (existing) {
          accountId = existing.id;
          const keepMuu = existing.muuConfidence === "verified" || (existing.muuConfidence === "reported" && muuConfidence === "estimate");
          const patch: Partial<typeof s.accounts.$inferInsert> = {
            category: existing.category ?? c.category,
            country: existing.country ?? c.country,
            ownership: existing.ownership ?? c.ownership,
            techStack: existing.techStack.length ? existing.techStack : c.techStack,
            fitScore: c.fitScore,
            fitExplanation: c.fitExplanation,
            ownerId: existing.ownerId ?? ownerId,
          };
          if (!keepMuu && c.estMuu != null) Object.assign(patch, { muu: c.estMuu, muuSource: c.muuSource, muuConfidence, monthlyVisits: c.monthlyVisits ?? existing.monthlyVisits });
          await tx.update(s.accounts).set(patch).where(eq(s.accounts.id, accountId));
        } else {
          if (!(await canCreateAccountFor(user, ownerId))) throw new ForbiddenError();
          const [a] = await tx
            .insert(s.accounts)
            .values({
              name: c.name?.trim() || c.domain,
              domain: c.domain,
              website: `https://${c.domain}`,
              type: "publisher",
              category: c.category,
              country: c.country,
              ownership: c.ownership,
              lifecycle: "target",
              ownerId,
              teamId: owner.teamId,
              muu: c.estMuu,
              muuSource: c.muuSource,
              muuConfidence: c.estMuu != null ? muuConfidence : null,
              monthlyVisits: c.monthlyVisits,
              techStack: c.techStack,
              fitScore: c.fitScore,
              fitExplanation: c.fitExplanation,
              source: "Lead Scout",
              createdBy: user.id,
            })
            .onConflictDoNothing()
            .returning({ id: s.accounts.id });
          if (a) accountId = a.id;
          else {
            const [again] = await tx.select({ id: s.accounts.id }).from(s.accounts).where(and(eq(s.accounts.domain, c.domain), isNull(s.accounts.deletedAt)));
            if (!again) throw new UserError("Could not create the account.");
            accountId = again.id;
          }
        }
        // audience provenance (SCOUT-7): visits + derived MUU, or the manual MUU
        const period = now.toISOString().slice(0, 7);
        if (c.monthlyVisits != null && c.muuSource === "Similarweb via Apify")
          await tx.insert(s.audienceMetrics).values({ accountId, metric: "visits", value: c.monthlyVisits, derivedMuu: c.estMuu, factorUsed: raw.factorUsed ?? null, period, source: "Similarweb via Apify", confidence: "estimate", enteredBy: user.id });
        else if (c.estMuu != null && c.muuSource === "Manual entry")
          await tx.insert(s.audienceMetrics).values({ accountId, metric: "muu", value: c.estMuu, derivedMuu: c.estMuu, period, source: "Manual (Lead Scout)", confidence: "reported", enteredBy: user.id });

        // never duplicate an open deal in the same pipeline (AT-11)
        const [openDeal] = await tx
          .select({ id: s.deals.id })
          .from(s.deals)
          .where(and(eq(s.deals.accountId, accountId), eq(s.deals.pipelineId, pipe.id), inArray(s.deals.status, ["open", "hold"]), isNull(s.deals.deletedAt)));
        let dealId: string;
        let created = false;
        if (openDeal) dealId = openDeal.id;
        else {
          const [d] = await tx
            .insert(s.deals)
            .values({
              name: c.name?.trim() || c.domain,
              pipelineId: pipe.id,
              stageId: target.id,
              status: "open",
              accountId,
              ownerId,
              teamId: owner.teamId,
              source: "Lead Scout",
              muu: c.estMuu,
              nextStep: "First outreach",
              nextStepDueAt: addBusinessDays(now, 2),
              stageEnteredAt: now,
              createdBy: user.id,
              customFields: { leadScout: { candidateId: c.id, searchId: c.searchId, fitScore: c.fitScore, estValueCents: c.estValueCents, estValueLabel: "estimate", usdPerMuu: settings.usdPerMuu } },
            })
            .returning({ id: s.deals.id });
          dealId = d!.id;
          created = true;
          await tx.insert(s.dealStageHistory).values({ dealId, fromStageId: null, toStageId: target.id, changedBy: user.id, reason: "Created from Lead Scout" });
          await tx.insert(s.activities).values({ type: "system", source: "system", subject: "Created from Lead Scout", body: c.fitExplanation, actorId: user.id, dealId, accountId, metadata: { candidateId: c.id, fitScore: c.fitScore } });
        }
        const crmMatch: CrmMatch = { status: "open_deal", accountId, dealId, ownerId, ownerName: owner.name, stage: target.name, pipelineKey };
        await tx.update(s.scoutCandidates).set({ state: "accepted", reviewerId: user.id, reviewedAt: now, crmMatch: crmMatch as never }).where(eq(s.scoutCandidates.id, c.id));
        return { accountId, dealId, created, accountCreated: !existing };
      });
      await audit({ actorId: user.id, action: "scout_candidate.accept", entity: "deal", entityId: result.dealId, after: { candidateId: c.id, domain: c.domain, pipelineKey, ownerId, accountId: result.accountId, dealCreated: result.created, accountCreated: result.accountCreated } });
      let runId: string | null = null;
      let msg = result.created ? `Target deal created in ${pipelineKey}` : "Linked to the existing open deal";
      if (input.enrich) {
        if (raw.doNotContact) msg += " · enrichment skipped (do-not-contact)";
        else {
          try {
            const r = await startEnrichmentFor(user, { accountId: result.accountId, dealId: result.dealId, candidateId: c.id, targetRoles: settings.targetRoles[pipelineKey] ?? [] });
            runId = r.runId;
            msg += r.blocked ? ` · enrichment blocked: ${r.message}` : " · enrichment started";
          } catch (e) {
            msg += ` · enrichment not started: ${e instanceof UserError || e instanceof ForbiddenError ? e.message : "error"}`;
          }
        }
      }
      outcomes.push({ domain: c.domain, ok: true, message: msg, accountId: result.accountId, dealId: result.dealId, runId });
    } catch (e) {
      if (e instanceof UserError || e instanceof ForbiddenError) outcomes.push({ domain: c.domain, ok: false, message: e.message });
      else {
        console.error("[scout] accept failed", c.domain, e instanceof Error ? e.message : "");
        outcomes.push({ domain: c.domain, ok: false, message: "Could not accept — try again." });
      }
    }
  }
  revalidate();
  revalidatePath("/pipelines", "layout");
  revalidatePath("/accounts", "layout");
  return { suggested: 0, outcomes };
});

async function canCreateAccountFor(user: AppUser, ownerId: string) {
  const scope = await scopeFor(user, "accounts", "create");
  if (scope === "all" || scope === "pipeline") return true;
  if (scope === "team") return user.teamMemberIds.includes(ownerId);
  if (scope === "own") return ownerId === user.id || SCOPE_RANK[await scopeFor(user, "scout", "assign")] > 0;
  return false;
}

/* ───────────────────────────── Enrichment ───────────────────────────── */

const enrichInput = z.object({
  accountId: uuid,
  dealId: uuid.optional(),
  candidateId: uuid.optional(),
  targetRoles: z.array(z.string().trim().min(2).max(60)).min(1, "Pick at least one role").max(15),
});

async function assertEnrichable(user: AppUser, accountId: string) {
  const scope = await assertCan(user, "enrichment", "create");
  const [acct] = await db.select().from(s.accounts).where(and(eq(s.accounts.id, accountId), isNull(s.accounts.deletedAt)));
  if (!acct) throw new UserError("Account not found.");
  if (acct.restricted && !(await canSeeRestricted(user, "account", acct.id))) throw new ForbiddenError();
  if (scope === "own" && acct.ownerId !== user.id) {
    const [d] = await db.select({ id: s.deals.id }).from(s.deals).where(and(eq(s.deals.accountId, acct.id), eq(s.deals.ownerId, user.id), isNull(s.deals.deletedAt))).limit(1);
    if (!d) throw new ForbiddenError("You can enrich accounts you own or have a deal on.");
  }
  if (!acct.domain) throw new UserError("Add a website domain to the account first.");
  if (acct.doNotContact) throw new UserError("This account is marked do-not-contact.");
  if ((await suppressedDomains([acct.domain])).size) throw new UserError("This domain is on the suppression list.");
  return acct;
}

async function startEnrichmentFor(user: AppUser, input: z.infer<typeof enrichInput>): Promise<{ runId: string | null; blocked: boolean; message: string; canRequestMore: boolean; estimateCents: number }> {
  await assertEnrichable(user, input.accountId);
  if (!(await getApifyToken())) throw new UserError("Connect Apify to find executives.");
  const est = await estimateEnrichment();
  const decision = await checkRunBudget(user, est.cents, { entity: "account", entityId: input.accountId });
  if (!decision.allowed) {
    const [b] = await db
      .insert(s.enrichmentRuns)
      .values({ kind: "enrich", accountId: input.accountId, requestedBy: user.id, targetRoles: input.targetRoles, status: "blocked", estimatedCostCents: est.cents, error: decision.message, finishedAt: new Date() })
      .returning({ id: s.enrichmentRuns.id });
    return { runId: b!.id, blocked: true, message: decision.message, canRequestMore: decision.canRequestMore, estimateCents: est.cents };
  }
  const plan: EnrichPlan = { maxAllowedCents: decision.maxAllowedCents, estimateCents: est.cents, dealId: input.dealId ?? null, candidateId: input.candidateId ?? null, overrideApprovalId: decision.overrideApprovalId };
  const planStep: StepState = { key: "plan", label: "Plan & budget", actorId: "", status: "succeeded", output: plan, finishedAt: new Date().toISOString() };
  const [run] = await db
    .insert(s.enrichmentRuns)
    .values({ kind: "enrich", accountId: input.accountId, requestedBy: user.id, targetRoles: input.targetRoles, status: "queued", estimatedCostCents: est.cents, actors: [planStep] as never, startedAt: new Date() })
    .returning({ id: s.enrichmentRuns.id });
  if (decision.overrideApprovalId) await consumeOverride(decision.overrideApprovalId, run!.id);
  await audit({ actorId: user.id, action: "enrichment.start", entity: "account", entityId: input.accountId, after: { runId: run!.id, roles: input.targetRoles, estimateCents: est.cents, dealId: input.dealId } });
  runInBackground(run!.id);
  return { runId: run!.id, blocked: false, message: decision.message, canRequestMore: false, estimateCents: est.cents };
}

/** Preview for the EnrichButton dialog: default roles for the motion, estimate, budget, Apify status. */
export const getEnrichmentPreview = action(z.object({ accountId: uuid, motion: z.string().max(10).optional() }), async ({ accountId, motion }, user) => {
  const acct = await assertEnrichable(user, accountId);
  const [settings, token, est] = await Promise.all([getScoutSettings(), getApifyToken(), estimateEnrichment()]);
  const budget = await checkRunBudget(user, est.cents, { entity: "account", entityId: accountId });
  const pending = await pendingBudgetRequest(user.id, "account", accountId);
  const key = motion && settings.targetRoles[motion] ? motion : "NET";
  return {
    accountName: acct.name,
    domain: acct.domain,
    apifyConnected: Boolean(token),
    defaultRoles: settings.targetRoles[key] ?? [],
    motion: key,
    estimate: est,
    budget,
    pendingRequest: Boolean(pending),
  };
});

export const startEnrichment = action(enrichInput, async (input, user) => {
  const r = await startEnrichmentFor(user, input);
  revalidate();
  return r;
});

async function loadStaged(user: AppUser, idsIn: string[]) {
  const rows = await db.select({ ec: s.enrichedContacts, requestedBy: s.enrichmentRuns.requestedBy }).from(s.enrichedContacts).innerJoin(s.enrichmentRuns, eq(s.enrichmentRuns.id, s.enrichedContacts.runId)).where(inArray(s.enrichedContacts.id, idsIn));
  const scope = await scopeFor(user, "contacts", "create");
  if (SCOPE_RANK[scope] === 0) throw new ForbiddenError();
  const all = MANAGER_ROLES.includes(user.role);
  for (const r of rows) if (!all && r.requestedBy !== user.id) throw new ForbiddenError("You can only review your own enrichment runs.");
  return rows;
}

export const promoteEnriched = action(z.object({ ids }), async (input, user) => {
  const rows = await loadStaged(user, input.ids);
  const emails = rows.map((r) => r.ec.email).filter((e): e is string => Boolean(e));
  const sup = await suppressedEmails(emails);
  let promoted = 0;
  let skipped = 0;
  for (const { ec } of rows) {
    if (ec.state !== "staged" || (ec.email && sup.has(ec.email.toLowerCase()))) {
      skipped++;
      continue;
    }
    await promoteOne(ec, user.id);
    promoted++;
  }
  revalidate();
  revalidatePath("/contacts", "layout");
  return { promoted, skipped };
});

export const discardEnriched = action(z.object({ ids }), async (input, user) => {
  const rows = await loadStaged(user, input.ids);
  const toDiscard = rows.filter((r) => r.ec.state === "staged").map((r) => r.ec.id);
  if (toDiscard.length) await db.update(s.enrichedContacts).set({ state: "discarded" }).where(inArray(s.enrichedContacts.id, toDiscard));
  await audit({ actorId: user.id, action: "enrichment.discard", entity: "enriched_contact", entityId: toDiscard.join(",").slice(0, 200), after: { count: toDiscard.length } });
  revalidate();
  return { discarded: toDiscard.length };
});

/** Resume a stalled run (idempotent: finished steps are skipped). */
export const resumeRunAction = action(z.object({ runId: uuid }), async ({ runId }, user) => {
  const [run] = await db.select().from(s.enrichmentRuns).where(eq(s.enrichmentRuns.id, runId));
  if (!run) throw new UserError("Run not found.");
  if (run.requestedBy !== user.id && !MANAGER_ROLES.includes(user.role)) throw new ForbiddenError();
  if (!["queued", "running"].includes(run.status)) throw new UserError("This run has already finished.");
  runInBackground(runId);
  return { runId };
});

/* ───────────────────────────── Settings (admin) ───────────────────────────── */

async function assertConfigure(user: AppUser) {
  await assertCan(user, "admin", "configure", "all");
}

export const saveApifyToken = action(z.object({ token: z.string().trim().min(20, "That doesn't look like an Apify token").max(200) }), async ({ token }, user) => {
  await assertConfigure(user);
  let username: string | null = null;
  let lastError: string | null = null;
  try {
    username = (await verifyApifyToken(token)).username;
  } catch (e) {
    if (e instanceof ApifyError && (e.status === 401 || e.status === 403)) throw new UserError("Apify rejected this token.");
    lastError = "Saved, but Apify couldn't be reached to verify it.";
  }
  const values = { provider: "apify", userId: null, status: "connected", secretEncrypted: encryptSecret(token), config: { masked: maskSecret(token), username }, lastError, lastSyncAt: new Date() };
  const [existing] = await db.select({ id: s.integrationConnections.id }).from(s.integrationConnections).where(and(eq(s.integrationConnections.provider, "apify"), isNull(s.integrationConnections.userId)));
  if (existing) await db.update(s.integrationConnections).set(values).where(eq(s.integrationConnections.id, existing.id));
  else await db.insert(s.integrationConnections).values(values);
  await audit({ actorId: user.id, action: "integration.apify.connect", entity: "integration", entityId: "apify", after: { masked: maskSecret(token), username } });
  revalidate();
  return { username, warning: lastError };
});

export const removeApifyToken = action(z.object({}), async (_i, user) => {
  await assertConfigure(user);
  await db
    .update(s.integrationConnections)
    .set({ status: "revoked", secretEncrypted: null, config: {} })
    .where(and(eq(s.integrationConnections.provider, "apify"), isNull(s.integrationConnections.userId)));
  await audit({ actorId: user.id, action: "integration.apify.disconnect", entity: "integration", entityId: "apify" });
  revalidate();
  return { ok: true };
});

export const testApifyConnection = action(z.object({}), async (_i, user) => {
  await assertConfigure(user);
  const t = await getApifyToken();
  if (!t) throw new UserError("No Apify token configured.");
  try {
    const me = await verifyApifyToken(t.token);
    return { username: me.username, plan: me.plan };
  } catch (e) {
    throw new UserError(e instanceof ApifyError ? e.message : "Could not reach Apify.");
  }
});

const settingsInput = z.object({
  visitsPerUnique: z.number().min(1).max(20),
  visitsPerUniqueByCategory: z.record(z.string().trim().min(1).max(60), z.number().min(1).max(20)),
  fitWeights: z.object(Object.fromEntries(FIT_FACTORS.map((f) => [f, z.number().min(0).max(100)])) as Record<(typeof FIT_FACTORS)[number], z.ZodNumber>),
  targetRoles: z.record(z.enum(["NET", "SPT", "ENT", "R100"]), z.array(z.string().trim().min(2).max(60)).max(20)),
  budget: z.object({
    orgMonthlyCents: z.number().int().min(0).max(1_000_000),
    userMonthlyCents: z.number().int().min(0).max(1_000_000),
    execMonthlyCents: z.number().int().min(0).max(1_000_000),
    perRunMaxCents: z.number().int().min(1).max(1_000_000),
    maxDomainsPerRun: z.number().int().min(1).max(500),
  }),
  autoPromoteValidSenior: z.boolean(),
});

export const saveScoutSettings = action(settingsInput, async (input, user) => {
  await assertConfigure(user);
  const total = FIT_FACTORS.reduce((a, f) => a + input.fitWeights[f], 0);
  if (total <= 0) throw new UserError("At least one Fit Score weight must be above zero.");
  const before = await getScoutSettings();
  await setSetting("scout.visits_per_unique", input.visitsPerUnique, user.id);
  await setSetting("scout.visits_per_unique_by_category", input.visitsPerUniqueByCategory, user.id);
  await setSetting("scout.fit_weights", input.fitWeights, user.id);
  await setSetting("scout.target_roles", input.targetRoles, user.id);
  await setSetting("scout.budget", input.budget, user.id);
  await setSetting("scout.auto_promote_valid_senior", input.autoPromoteValidSenior, user.id);
  await audit({ actorId: user.id, action: "settings.scout.update", entity: "app_settings", entityId: "scout.*", before: { ...before, rawFitWeights: undefined }, after: input });
  revalidate();
  return { ok: true };
});

export const updateActor = action(z.object({ id: uuid, enabled: z.boolean().optional(), compliant: z.boolean().optional(), costPerResultUsd: z.number().min(0).max(10).optional() }), async (input, user) => {
  await assertConfigure(user);
  const [before] = await db.select().from(s.actorRegistry).where(eq(s.actorRegistry.id, input.id));
  if (!before) throw new UserError("Actor not found.");
  const patch: Partial<typeof s.actorRegistry.$inferInsert> = {};
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.compliant !== undefined) patch.compliant = input.compliant;
  if (input.costPerResultUsd !== undefined) patch.costPerResultUsd = input.costPerResultUsd;
  await db.update(s.actorRegistry).set(patch).where(eq(s.actorRegistry.id, input.id));
  await audit({ actorId: user.id, action: "actor_registry.update", entity: "actor_registry", entityId: input.id, before, after: patch });
  revalidate();
  return { ok: true };
});
