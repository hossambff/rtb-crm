import "server-only";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, canSeeRestricted, dealModule, ForbiddenError, scopeFor, type AppUser } from "@/lib/rbac/server";
import { SCOPE_RANK } from "@/lib/rbac/model";
import { addBusinessDays, type CrmMatch } from "./core";
import { matchDomains, suppressedDomains } from "./crm-match";
import { MANAGER_ROLES } from "./queries";
import { getScoutSettings } from "./settings";

/**
 * Candidate review core (SCOUT-13/14/15) shared by the review-queue actions and the scout_accept approval handler
 * (an SVP approving an intern's suggested targets). Callers are server-side only.
 */

const uuid = z.string().uuid();
const ids = z.array(uuid).min(1).max(200);

export async function canEditSearch(user: AppUser, ownerId: string | null) {
  const scope = await scopeFor(user, "scout", "edit");
  if (scope === "all" || scope === "pipeline") return true;
  if (scope === "team") return ownerId != null && user.teamMemberIds.includes(ownerId);
  if (scope === "own") return ownerId === user.id;
  return false;
}

export async function loadCandidates(user: AppUser, ids: string[], needEdit = true) {
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

export const acceptInput = z.object({
  ids,
  pipelineKey: z.enum(["NET", "SPT", "ENT"]).optional(), // omitted → per-candidate routing suggestion
  ownerId: z.string().min(1).max(64).optional(),
  enrich: z.boolean().default(false),
});

export type AcceptOutcome = { domain: string; ok: boolean; message: string; accountId?: string; dealId?: string; runId?: string | null };

export type EnrichStarter = (user: AppUser, input: { accountId: string; dealId?: string; candidateId?: string; targetRoles: string[] }) => Promise<{ runId: string | null; blocked: boolean; message: string }>;

/** Accept candidates as `user` (who must hold scout edit scope). `enrich` starts enrichment when input.enrich is set. */
export async function acceptCandidatesAs(user: AppUser, input: z.infer<typeof acceptInput>, enrich?: EnrichStarter): Promise<AcceptOutcome[]> {
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
      // Permission check before the transaction: scopeFor reads through the pool, never inside an open tx (QA-01).
      if (!existing && !(await canCreateAccountFor(user, ownerId))) throw new ForbiddenError();
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
        else if (!enrich) msg += " · enrichment not started";
        else {
          try {
            const r = await enrich(user, { accountId: result.accountId, dealId: result.dealId, candidateId: c.id, targetRoles: settings.targetRoles[pipelineKey] ?? [] });
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
  return outcomes;
}

async function canCreateAccountFor(user: AppUser, ownerId: string) {
  const scope = await scopeFor(user, "accounts", "create");
  if (scope === "all" || scope === "pipeline") return true;
  if (scope === "team") return user.teamMemberIds.includes(ownerId);
  if (scope === "own") return ownerId === user.id || SCOPE_RANK[await scopeFor(user, "scout", "assign")] > 0;
  return false;
}
