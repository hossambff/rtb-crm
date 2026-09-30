import "server-only";
import { and, asc, desc, eq, exists, gte, ilike, inArray, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { env } from "@/lib/env";
import { can, scopeFor, type AppUser } from "@/lib/rbac/server";
import { monthStart } from "./budget-core";
import { orgSpendCents, spendByUser, userSpendCents } from "./budget";
import { stepsOf, type StepState } from "./runs";
import { getScoutSettings } from "./settings";
import { userCapCents } from "./budget-core";

export const MANAGER_ROLES = ["super_admin", "admin", "executive", "sales_leader"];

export async function scoutPermissions(user: AppUser) {
  const [view, create, edit, assign, enrichCreate, enrichView, configure] = await Promise.all([
    scopeFor(user, "scout", "view"),
    scopeFor(user, "scout", "create"),
    scopeFor(user, "scout", "edit"),
    scopeFor(user, "scout", "assign"),
    scopeFor(user, "enrichment", "create"),
    scopeFor(user, "enrichment", "view"),
    can(user, "admin", "configure", "all"),
  ]);
  return { view, create, edit, assign, enrichCreate, enrichView, configure, isManager: MANAGER_ROLES.includes(user.role) };
}
export type ScoutPerms = Awaited<ReturnType<typeof scoutPermissions>>;

export async function apifyStatus() {
  if (env.apifyToken) return { connected: true, source: "env" as const, masked: "set via APIFY_TOKEN", username: null as string | null, lastError: null as string | null, updatedAt: null as Date | null };
  const [row] = await db
    .select()
    .from(s.integrationConnections)
    .where(and(eq(s.integrationConnections.provider, "apify"), isNull(s.integrationConnections.userId)));
  if (!row?.secretEncrypted || row.status === "revoked") return { connected: false, source: null, masked: null, username: null, lastError: row?.lastError ?? null, updatedAt: null };
  const cfg = row.config as { masked?: string; username?: string };
  return { connected: true, source: "org" as const, masked: cfg.masked ?? "••••", username: cfg.username ?? null, lastError: row.lastError, updatedAt: row.updatedAt };
}
export type ApifyStatus = Awaited<ReturnType<typeof apifyStatus>>;

/** Searches visible to the user (scout.view scope all → every search; own → searches they own). */
async function searchScopeWhere(user: AppUser): Promise<SQL> {
  const scope = await scopeFor(user, "scout", "view");
  if (scope === "all" || scope === "pipeline") return sql`true`;
  if (scope === "team") return inArray(s.scoutSearches.ownerId, user.teamMemberIds.length ? user.teamMemberIds : [user.id]);
  if (scope === "own") return eq(s.scoutSearches.ownerId, user.id);
  return sql`false`;
}

export type CandidateFilter = { state?: "queue" | "new" | "accepted" | "rejected" | "snoozed" | "duplicate" | "all"; searchId?: string; q?: string; minScore?: number };

export async function listCandidates(user: AppUser, f: CandidateFilter = {}) {
  const where: SQL[] = [await searchScopeWhere(user)];
  const state = f.state ?? "queue";
  if (state === "queue")
    where.push(
      or(
        eq(s.scoutCandidates.state, "new"),
        and(eq(s.scoutCandidates.state, "snoozed"), sql`coalesce((${s.scoutCandidates.raw}->>'snoozedUntil')::timestamptz, now()) <= now()`),
      )!,
    );
  else if (state !== "all") where.push(eq(s.scoutCandidates.state, state));
  if (f.searchId) where.push(eq(s.scoutCandidates.searchId, f.searchId));
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "\\$&").slice(0, 80)}%`;
    where.push(or(ilike(s.scoutCandidates.domain, like), ilike(s.scoutCandidates.name, like))!);
  }
  if (f.minScore != null) where.push(gte(s.scoutCandidates.fitScore, f.minScore));
  return db
    .select({
      c: s.scoutCandidates,
      searchName: s.scoutSearches.name,
      searchOwnerId: s.scoutSearches.ownerId,
    })
    .from(s.scoutCandidates)
    .innerJoin(s.scoutSearches, eq(s.scoutSearches.id, s.scoutCandidates.searchId))
    .where(and(...where))
    .orderBy(desc(s.scoutCandidates.fitScore), desc(s.scoutCandidates.createdAt))
    .limit(300);
}

export async function candidateCounts(user: AppUser) {
  const rows = await db
    .select({ state: s.scoutCandidates.state, n: sql<number>`count(*)::int` })
    .from(s.scoutCandidates)
    .innerJoin(s.scoutSearches, eq(s.scoutSearches.id, s.scoutCandidates.searchId))
    .where(await searchScopeWhere(user))
    .groupBy(s.scoutCandidates.state);
  return Object.fromEntries(rows.map((r) => [r.state, r.n])) as Record<string, number>;
}

export async function listSearches(user: AppUser) {
  const rows = await db
    .select({
      search: s.scoutSearches,
      ownerName: s.user.name,
      total: sql<number>`(select count(*)::int from ${s.scoutCandidates} c where c.search_id = ${s.scoutSearches.id})`,
      pending: sql<number>`(select count(*)::int from ${s.scoutCandidates} c where c.search_id = ${s.scoutSearches.id} and c.state = 'new')`,
      accepted: sql<number>`(select count(*)::int from ${s.scoutCandidates} c where c.search_id = ${s.scoutSearches.id} and c.state = 'accepted')`,
      lastRunStatus: sql<string | null>`(select r.status::text from ${s.enrichmentRuns} r where r.search_id = ${s.scoutSearches.id} order by r.created_at desc limit 1)`,
      lastRunId: sql<string | null>`(select r.id::text from ${s.enrichmentRuns} r where r.search_id = ${s.scoutSearches.id} order by r.created_at desc limit 1)`,
    })
    .from(s.scoutSearches)
    .leftJoin(s.user, eq(s.user.id, s.scoutSearches.ownerId))
    .where(await searchScopeWhere(user))
    .orderBy(desc(s.scoutSearches.createdAt))
    .limit(200);
  return rows;
}

export async function getSearch(user: AppUser, id: string) {
  const [row] = await db
    .select()
    .from(s.scoutSearches)
    .where(and(eq(s.scoutSearches.id, id), await searchScopeWhere(user)));
  return row ?? null;
}

/** SEC M-6: runs on a restricted (MNPI) account are visible only to super_admin and the account's access list. */
function runAccountOk(user: AppUser): SQL {
  if (user.role === "super_admin") return sql`true`;
  return or(
    isNull(s.enrichmentRuns.accountId),
    exists(
      db
        .select({ x: sql`1` })
        .from(s.accounts)
        .where(
          and(
            eq(s.accounts.id, s.enrichmentRuns.accountId),
            or(
              eq(s.accounts.restricted, false),
              exists(
                db
                  .select({ y: sql`1` })
                  .from(s.restrictedAccess)
                  .where(and(eq(s.restrictedAccess.entity, "account"), eq(s.restrictedAccess.entityId, s.accounts.id), eq(s.restrictedAccess.userId, user.id))),
              ),
            ),
          ),
        ),
    ),
  )!;
}

async function runScopeWhere(user: AppUser): Promise<SQL> {
  return and(await runRoleScopeWhere(user), runAccountOk(user))!;
}

async function runRoleScopeWhere(user: AppUser): Promise<SQL> {
  const [ev, sv, cfg] = await Promise.all([scopeFor(user, "enrichment", "view"), scopeFor(user, "scout", "view"), can(user, "admin", "configure", "all")]);
  if (cfg) return sql`true`;
  const mine = eq(s.enrichmentRuns.requestedBy, user.id);
  // enrichment runs follow enrichment.view scope; scout runs follow scout.view scope
  const enrich = ev === "all" ? sql`true` : ev === "team" ? inArray(s.enrichmentRuns.requestedBy, user.teamMemberIds.length ? user.teamMemberIds : [user.id]) : mine;
  const scout = sv === "all" ? sql`true` : mine;
  return or(and(eq(s.enrichmentRuns.kind, "enrich"), enrich), and(eq(s.enrichmentRuns.kind, "scout"), scout))!;
}

export async function listRuns(user: AppUser, opts: { kind?: "scout" | "enrich"; limit?: number } = {}) {
  const where: SQL[] = [await runScopeWhere(user)];
  if (opts.kind) where.push(eq(s.enrichmentRuns.kind, opts.kind));
  return db
    .select({
      run: {
        id: s.enrichmentRuns.id,
        kind: s.enrichmentRuns.kind,
        status: s.enrichmentRuns.status,
        costCents: s.enrichmentRuns.costCents,
        estimatedCostCents: s.enrichmentRuns.estimatedCostCents,
        resultsCount: s.enrichmentRuns.resultsCount,
        verifiedCount: s.enrichmentRuns.verifiedCount,
        error: s.enrichmentRuns.error,
        createdAt: s.enrichmentRuns.createdAt,
        finishedAt: s.enrichmentRuns.finishedAt,
        accountId: s.enrichmentRuns.accountId,
        searchId: s.enrichmentRuns.searchId,
      },
      requester: s.user.name,
      accountName: s.accounts.name,
      accountRestricted: s.accounts.restricted,
      searchName: s.scoutSearches.name,
    })
    .from(s.enrichmentRuns)
    .leftJoin(s.user, eq(s.user.id, s.enrichmentRuns.requestedBy))
    .leftJoin(s.accounts, eq(s.accounts.id, s.enrichmentRuns.accountId))
    .leftJoin(s.scoutSearches, eq(s.scoutSearches.id, s.enrichmentRuns.searchId))
    .where(and(...where))
    .orderBy(desc(s.enrichmentRuns.createdAt))
    .limit(opts.limit ?? 100);
}

/** Steps as sent to the client — outputs stripped (may be large), costs kept. */
export function publicSteps(steps: StepState[]) {
  return steps
    .filter((st) => st.key !== "plan")
    .map((st) => ({
      key: st.key,
      label: st.label,
      actorId: st.actorId || null,
      status: st.status,
      costUsd: st.costUsd ?? null,
      costEstimated: st.costEstimated ?? false,
      items: st.items ?? null,
      quarantined: st.quarantined ?? 0,
      note: st.note ?? null,
      error: st.error ?? null,
      startedAt: st.startedAt ?? null,
      finishedAt: st.finishedAt ?? null,
    }));
}
export type PublicStep = ReturnType<typeof publicSteps>[number];

export async function getRunDetail(user: AppUser, id: string) {
  const [row] = await db
    .select({ run: s.enrichmentRuns, requester: s.user.name, account: { id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain, restricted: s.accounts.restricted, ownerId: s.accounts.ownerId }, searchName: s.scoutSearches.name })
    .from(s.enrichmentRuns)
    .leftJoin(s.user, eq(s.user.id, s.enrichmentRuns.requestedBy))
    .leftJoin(s.accounts, eq(s.accounts.id, s.enrichmentRuns.accountId))
    .leftJoin(s.scoutSearches, eq(s.scoutSearches.id, s.enrichmentRuns.searchId))
    .where(and(eq(s.enrichmentRuns.id, id), await runScopeWhere(user)));
  if (!row) return null;
  const staged = row.run.kind === "enrich" ? await db.select().from(s.enrichedContacts).where(eq(s.enrichedContacts.runId, id)).orderBy(asc(s.enrichedContacts.createdAt)) : [];
  return { ...row, steps: publicSteps(stepsOf(row.run)), staged };
}

export async function assignableUsers() {
  return db
    .select({ id: s.user.id, name: s.user.name, role: s.user.role })
    .from(s.user)
    .where(and(notInArray(s.user.role, ["pending", "viewer", "finance", "editorial", "onboarding"]), or(isNull(s.user.banned), eq(s.user.banned, false))))
    .orderBy(asc(s.user.name));
}

export async function scoutPipelines() {
  return db
    .select({ key: s.pipelines.key, name: s.pipelines.name, color: s.pipelines.color })
    .from(s.pipelines)
    .where(and(inArray(s.pipelines.key, ["NET", "SPT", "ENT"]), eq(s.pipelines.active, true)))
    .orderBy(asc(s.pipelines.sortOrder));
}

export async function rejectReasons(): Promise<string[]> {
  const rows = await db
    .select({ v: s.picklists.value })
    .from(s.picklists)
    .where(and(eq(s.picklists.list, "reject_reason"), eq(s.picklists.active, true)))
    .orderBy(asc(s.picklists.sortOrder));
  return rows.length ? rows.map((r) => r.v) : ["Too small", "Wrong vertical", "Group-owned", "Competitor-locked", "Not independent", "Low quality", "Other"];
}

export async function budgetSummary(user: AppUser) {
  const settings = await getScoutSettings();
  const [org, mine, byUser, [me]] = await Promise.all([
    orgSpendCents(),
    userSpendCents(user.id),
    spendByUser(),
    db.select({ cap: s.user.monthlyScoutBudgetCents }).from(s.user).where(eq(s.user.id, user.id)),
  ]);
  return {
    settings: settings.budget,
    orgSpentCents: org,
    mySpentCents: mine,
    myCapCents: userCapCents(user.role, me?.cap ?? null, settings.budget),
    byUser: byUser.map((u) => ({ ...u, capCents: userCapCents(u.role ?? "sdr", u.override, settings.budget) })),
    monthStart: monthStart(),
  };
}

/** Lead Scout funnel: found → accepted → contacted (deal past Outreach) → won. */
export async function scoutFunnel(user: AppUser) {
  const scopeWhere = await searchScopeWhere(user);
  const [cand] = await db
    .select({
      found: sql<number>`count(*)::int`,
      accepted: sql<number>`count(*) filter (where ${s.scoutCandidates.state} = 'accepted')::int`,
      rejected: sql<number>`count(*) filter (where ${s.scoutCandidates.state} = 'rejected')::int`,
    })
    .from(s.scoutCandidates)
    .innerJoin(s.scoutSearches, eq(s.scoutSearches.id, s.scoutCandidates.searchId))
    .where(scopeWhere);
  const outreachOrder = sql`(select st2.sort_order from ${s.stages} st2 where st2.pipeline_id = ${s.deals.pipelineId} and st2.key = 'outreach' limit 1)`;
  const [deals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      contacted: sql<number>`count(*) filter (where ${s.deals.status} = 'won' or ${s.stages.sortOrder} > coalesce(${outreachOrder}, 1))::int`,
      won: sql<number>`count(*) filter (where ${s.deals.status} = 'won')::int`,
    })
    .from(s.deals)
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .where(and(eq(s.deals.source, "Lead Scout"), isNull(s.deals.deletedAt), ne(s.deals.restricted, true)));
  return { found: cand?.found ?? 0, accepted: cand?.accepted ?? 0, rejected: cand?.rejected ?? 0, contacted: deals?.contacted ?? 0, won: deals?.won ?? 0 };
}

export async function actorRegistryRows() {
  return db.select().from(s.actorRegistry).orderBy(asc(s.actorRegistry.purpose), asc(s.actorRegistry.fallbackOrder));
}
