import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { getApifyToken } from "@/lib/apify/client";
import { isPlatformDomain, type LookalikeRecord, type SerpRecord, type TechStackRecord, type TrafficRecord } from "@/lib/apify/mappers";
import { actorsFor } from "@/lib/apify/registry";
import { normalizeDomain } from "@/lib/domain";
import { domainsWithinBudget, estimateCents } from "./budget-core";
import { addMonths, REJECT_SUPPRESS_MONTHS } from "./core";
import { criteriaSchema, serpQueries, type Criteria } from "./criteria";
import { matchDomains, recentlyRejected, suppressedDomains, wonCategories } from "./crm-match";
import { computeFit, estimateMuu } from "./fit";
import { actorStep, loadRun, localStep, saveSteps, skipStep, stepsOf, withRunLock, type StepCtx } from "./runs";
import { getScoutSettings } from "./settings";

/** Expected discovery yield per seed / per SERP page, for estimates. */
const LOOKALIKES_PER_SEED = 10;
const DOMAINS_PER_SERP_PAGE = 8;

export type CostLine = { purpose: string; actorId: string | null; results: number; costPerResultUsd: number; cents: number };
export type ScoutEstimate = { cents: number; lines: CostLine[]; domainsExpected: number; needsApify: boolean; apifyConnected: boolean; cappedDomains: number };

/** Cost estimate shown before every run (SCOUT-3): expected results × actor cost per result. */
export async function estimateScout(criteria: Criteria, maxDomains: number, apifyConnected: boolean): Promise<ScoutEstimate> {
  const queries = serpQueries(criteria);
  const listCount = criteria.domains.length;
  const seeds = criteria.seedDomains.length;
  const discovered = seeds * LOOKALIKES_PER_SEED + queries.length * DOMAINS_PER_SERP_PAGE;
  const domainsExpected = Math.min(maxDomains, listCount + (apifyConnected ? discovered : 0));
  const lines: CostLine[] = [];
  const add = async (purpose: "lookalike" | "serp" | "traffic" | "tech_stack", results: number) => {
    if (results <= 0) return;
    const [a] = await actorsFor(purpose);
    const per = a?.costPerResultUsd ?? 0;
    lines.push({ purpose, actorId: a?.actorId ?? null, results, costPerResultUsd: per, cents: estimateCents(results, per) });
  };
  if (apifyConnected) {
    await add("lookalike", seeds);
    await add("serp", queries.length);
    await add("traffic", domainsExpected);
    if (criteria.includeTechStack) await add("tech_stack", domainsExpected);
  }
  const needsApify = seeds > 0 || queries.length > 0;
  return {
    cents: lines.reduce((a, l) => a + l.cents, 0),
    lines,
    domainsExpected,
    needsApify,
    apifyConnected,
    cappedDomains: Math.max(0, listCount + (apifyConnected ? discovered : 0) - maxDomains),
  };
}

type Collected = { domain: string; source: "list" | "lookalike" | "serp"; seed?: string | null; similarity?: number | null; serpTitle?: string | null; manualMuu?: number | null };

/** Plan step output written by the action that starts the run. */
export type ScoutPlan = { maxAllowedCents: number; estimateCents: number; criteria: Criteria; overrideApprovalId?: string | null };

/**
 * Discovery pipeline (PRD M25.1): domains (list / lookalikes / SERP) → normalize → dedupe → traffic → MUU estimate →
 * optional tech stack → CRM match → Fit Score → scout_candidates. Resumable; capped to the run budget.
 */
export async function runScout(runId: string): Promise<void> {
  await withRunLock(runId, () => runScoutInner(runId));
}

async function runScoutInner(runId: string): Promise<void> {
  const run = await loadRun(runId);
  if (!run || run.kind !== "scout" || !run.searchId) return;
  if (run.status === "succeeded" || run.status === "failed" || run.status === "blocked") return;
  const [search] = await db.select().from(s.scoutSearches).where(eq(s.scoutSearches.id, run.searchId));
  if (!search) {
    await saveSteps(runId, stepsOf(run), { status: "failed", error: "Search was deleted", finishedAt: new Date() });
    return;
  }
  const steps = stepsOf(run);
  const plan = steps.find((x) => x.key === "plan")?.output as ScoutPlan | undefined;
  const criteria = criteriaSchema.parse(plan?.criteria ?? search.criteria ?? {});
  const settings = await getScoutSettings();
  const tokenInfo = await getApifyToken();
  const maxAllowedCents = plan?.maxAllowedCents ?? 0;
  if (run.status === "queued") await saveSteps(runId, steps, { status: "running", startedAt: run.startedAt ?? new Date() });

  const ctx: StepCtx = {
    runId,
    token: tokenInfo?.token ?? "",
    steps,
    remainingUsd: () => Math.max(0, maxAllowedCents / 100 - ctx.steps.reduce((a, st) => a + (st.costUsd ?? 0), 0)),
  };
  const errors: string[] = [];
  const hasToken = Boolean(tokenInfo);

  // 1) lookalike discovery from seed domains
  let lookalikes: LookalikeRecord[] = [];
  if (criteria.seedDomains.length && hasToken) {
    try {
      const r = await actorStep(ctx, "lookalike", "Lookalike discovery", "lookalike", {
        domains: criteria.seedDomains,
        urls: criteria.seedDomains.map((d) => `https://${d}`),
        domain: criteria.seedDomains[0],
      }, { expectedResults: criteria.seedDomains.length });
      if (r.state === "waiting") return;
      if (r.state === "done") lookalikes = r.records;
    } catch (e) {
      errors.push(`Lookalikes: ${(e as Error).message}`);
    }
  } else if (criteria.seedDomains.length) await skipStep(ctx, "lookalike", "Lookalike discovery", "Skipped — connect Apify to find lookalikes");

  // 2) keyword / SERP discovery
  let serp: SerpRecord[] = [];
  const queries = serpQueries(criteria);
  if (queries.length && hasToken) {
    try {
      const r = await actorStep(ctx, "serp", "Keyword discovery (Google)", "serp", { query: queries.join("\n"), queries, country: criteria.countries[0]?.toLowerCase() ?? "us" }, { expectedResults: queries.length });
      if (r.state === "waiting") return;
      if (r.state === "done") serp = r.records;
    } catch (e) {
      errors.push(`SERP: ${(e as Error).message}`);
    }
  } else if (queries.length) await skipStep(ctx, "serp", "Keyword discovery (Google)", "Skipped — connect Apify for keyword discovery");

  // 3) collect → normalize → dedupe → exclusions → cap
  const collected =
    (await localStep<Collected[]>(ctx, "collect", "Collect & dedupe domains", async () => {
      const bag = new Map<string, Collected>();
      for (const d of criteria.domains) bag.set(d, { domain: d, source: "list", manualMuu: criteria.manualMuu[d] ?? null });
      for (const l of lookalikes) if (!bag.has(l.domain) && !criteria.seedDomains.includes(l.domain)) bag.set(l.domain, { domain: l.domain, source: "lookalike", seed: l.seed, similarity: l.similarity ?? 0.6 });
      for (const r of serp) if (!bag.has(r.domain) && !isPlatformDomain(r.domain)) bag.set(r.domain, { domain: r.domain, source: "serp", serpTitle: r.title });
      const all = [...bag.keys()];
      const exclude = new Set(criteria.excludeDomains);
      const [suppressed, rejected, existing] = await Promise.all([
        suppressedDomains(all),
        recentlyRejected(all, addMonths(new Date(), -REJECT_SUPPRESS_MONTHS)),
        db.select({ d: s.scoutCandidates.domain }).from(s.scoutCandidates).where(and(eq(s.scoutCandidates.searchId, search.id), inArray(s.scoutCandidates.domain, all.length ? all : ["-"]))),
      ]);
      const existingSet = new Set(existing.map((e) => e.d));
      let openDealDomains = new Set<string>();
      if (criteria.notInPipeline && all.length) {
        const m = await matchDomains(all);
        openDealDomains = new Set([...m.entries()].filter(([, v]) => v.status === "open_deal").map(([k]) => k));
      }
      let kept = [...bag.values()].filter((c) => !exclude.has(c.domain) && !suppressed.has(c.domain) && !rejected.has(c.domain) && !existingSet.has(c.domain) && !openDealDomains.has(c.domain));
      const dropped = bag.size - kept.length;
      const max = Math.min(settings.budget.maxDomainsPerRun, criteria.limit ?? settings.budget.maxDomainsPerRun);
      // cap to budget: traffic (+ tech stack) cost per domain
      let perDomainCents = 0;
      if (hasToken) {
        const [t] = await actorsFor("traffic");
        perDomainCents += (t?.costPerResultUsd ?? 0) * 100;
        if (criteria.includeTechStack) {
          const [ts] = await actorsFor("tech_stack");
          perDomainCents += (ts?.costPerResultUsd ?? 0) * 100;
        }
      }
      const affordable = hasToken ? domainsWithinBudget(ctx.remainingUsd() * 100, perDomainCents, max) : max;
      const before = kept.length;
      // list domains first, then lookalikes by similarity, then SERP order
      kept = kept.sort((a, b) => rank(a) - rank(b)).slice(0, affordable);
      const notes = [`${kept.length} domain${kept.length === 1 ? "" : "s"} to score`];
      if (dropped) notes.push(`${dropped} excluded (already scouted, suppressed, rejected <6 mo, or excluded)`);
      if (before > kept.length) notes.push(`${before - kept.length} over the per-run cap/budget`);
      return { output: kept, note: notes.join("; ") };
    })) ?? [];

  const domains = collected.map((c) => c.domain);

  // 4) traffic → MUU estimate
  let traffic: TrafficRecord[] = [];
  if (domains.length && hasToken) {
    try {
      const r = await actorStep(ctx, "traffic", "Traffic (Similarweb)", "traffic", { domains, urls: domains.map((d) => `https://${d}`) }, { expectedResults: domains.length, maxItems: domains.length });
      if (r.state === "waiting") return;
      if (r.state === "done") traffic = r.records;
    } catch (e) {
      errors.push(`Traffic: ${(e as Error).message}`);
    }
  } else if (domains.length) await skipStep(ctx, "traffic", "Traffic (Similarweb)", "Skipped — no Apify token; MUU from CRM/manual entry or marked unknown");

  // 5) optional tech stack
  let tech: TechStackRecord[] = [];
  if (criteria.includeTechStack && domains.length && hasToken) {
    try {
      const r = await actorStep(ctx, "tech_stack", "Tech stack", "tech_stack", { domains, urls: domains.map((d) => `https://${d}`) }, { expectedResults: domains.length, maxItems: domains.length });
      if (r.state === "waiting") return;
      if (r.state === "done") tech = r.records;
    } catch (e) {
      errors.push(`Tech stack: ${(e as Error).message}`);
    }
  }

  // 6) CRM match + Fit Score → candidates
  const inserted =
    (await localStep<number>(ctx, "score", "CRM match & Fit Score", async () => {
      if (!domains.length) return { output: 0, note: "Nothing new to score" };
      const trafficBy = new Map(traffic.map((t) => [t.domain, t]));
      const techBy = new Map(tech.map((t) => [t.domain, t]));
      const [crm, won] = await Promise.all([matchDomains(domains), wonCategories()]);
      const rows: (typeof s.scoutCandidates.$inferInsert)[] = [];
      let filtered = 0;
      for (const c of collected) {
        const t = trafficBy.get(c.domain);
        const m = crm.get(c.domain);
        const acct = m?.account;
        // a single-vertical discovery search implies the vertical; explicitly listed domains never inherit filters
        const category = t?.category ?? acct?.category ?? (c.source !== "list" && criteria.categories.length === 1 ? criteria.categories[0]! : null);
        const est = estimateMuu(t?.monthlyVisits ?? null, category, settings.visitsPerUnique, settings.visitsPerUniqueByCategory);
        let estMuu = est.muu;
        let muuSource: string | null = null;
        let confidence: "estimate" | "reported" | "verified" | "unknown" = "unknown";
        if (estMuu != null) {
          muuSource = "Similarweb via Apify";
          confidence = "estimate";
        } else if (c.manualMuu != null) {
          estMuu = c.manualMuu;
          muuSource = "Manual entry";
          confidence = "reported";
        } else if (acct?.muu != null) {
          estMuu = acct.muu;
          muuSource = "CRM";
          confidence = (acct.muuConfidence as "estimate" | "reported" | "verified" | null) ?? "estimate";
        }
        // discovery filters (never drop explicitly listed domains)
        if (c.source !== "list") {
          if (estMuu != null && ((criteria.muuMin != null && estMuu < criteria.muuMin) || (criteria.muuMax != null && estMuu > criteria.muuMax))) {
            filtered++;
            continue;
          }
          const country = t?.topCountry ?? acct?.country ?? null;
          if (criteria.countries.length && country && !criteria.countries.includes(country === "UK" ? "GB" : country)) {
            filtered++;
            continue;
          }
        }
        const techStack = techBy.get(c.domain)?.technologies ?? [];
        const similarity = c.similarity ?? (category && won.has(category.toLowerCase()) ? 0.5 : null);
        const country = t?.topCountry ?? acct?.country ?? null;
        const ownership = acct?.ownership ?? null; // unknown unless the CRM knows it — never inferred from filters
        const fit = computeFit(
          { estMuu, category, ownership, country, trendPct: t?.trendPct ?? null, techStack, lookalikeSimilarity: similarity, hasRelationship: m?.hasRelationship ?? false },
          { weights: settings.fitWeights, sweetSpot: settings.sweetSpot, coreVerticals: settings.coreVerticals, supportedCountries: settings.supportedCountries, usdPerMuu: settings.usdPerMuu },
        );
        const { account: _a, hasRelationship: _h, ...crmMatch } = m ?? { status: "new" as const, hasRelationship: false };
        void _a;
        void _h;
        rows.push({
          searchId: search.id,
          domain: c.domain,
          name: t?.name ?? acct?.name ?? c.serpTitle?.split(/[|–—-]/)[0]?.trim().slice(0, 120) ?? null,
          category,
          country,
          language: null,
          monthlyVisits: t?.monthlyVisits != null ? Math.round(t.monthlyVisits) : null,
          estMuu,
          muuSource,
          trendPct: t?.trendPct ?? null,
          techStack,
          ownership,
          fitScore: fit.score,
          fitFactors: fit.factors,
          fitExplanation: fit.explanation,
          estValueCents: fit.estValueUsd != null ? Math.round(fit.estValueUsd * 100) : null,
          crmMatch: { status: "new", ...crmMatch } as never,
          raw: {
            runId,
            source: c.source,
            seed: c.seed ?? null,
            similarity,
            serpTitle: c.serpTitle ?? null,
            muuConfidence: confidence,
            factorUsed: est.muu != null ? est.factor : null,
            routing: fit.routing,
            routingReason: fit.routingReason,
            signals: fit.signals,
            displaceable: fit.displaceableVendors,
            series: t?.series ?? [],
            globalRank: t?.globalRank ?? null,
            doNotContact: acct?.doNotContact ?? false,
          },
        });
      }
      let n = 0;
      for (let i = 0; i < rows.length; i += 100) {
        const res = await db.insert(s.scoutCandidates).values(rows.slice(i, i + 100)).onConflictDoNothing().returning({ id: s.scoutCandidates.id });
        n += res.length;
      }
      return { output: n, note: `${n} candidate${n === 1 ? "" : "s"} added${filtered ? `; ${filtered} outside the MUU/country filters` : ""}` };
    })) ?? 0;

  await db.update(s.scoutSearches).set({ lastRunAt: new Date() }).where(eq(s.scoutSearches.id, search.id));
  await saveSteps(runId, ctx.steps, { status: "succeeded", resultsCount: inserted, finishedAt: new Date(), error: errors.length ? errors.join(" · ").slice(0, 1000) : null });
}

function rank(c: Collected): number {
  if (c.source === "list") return 0;
  if (c.source === "lookalike") return 1 + (1 - (c.similarity ?? 0.5));
  return 3;
}

/** Normalize & validate a raw domain list against suppression before saving a search (used by actions). */
export async function cleanDomainList(domains: string[]): Promise<{ domains: string[]; suppressed: string[] }> {
  const norm = [...new Set(domains.map((d) => normalizeDomain(d)).filter((d): d is string => Boolean(d)))];
  const sup = await suppressedDomains(norm);
  return { domains: norm.filter((d) => !sup.has(d)), suppressed: [...sup] };
}
