import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { getMatrix, dealModule, type AppUser } from "@/lib/rbac/server";
import { ROLE_LABELS, ROLES, SCOPE_RANK, type Role } from "@/lib/rbac/model";
import { getSlackContext } from "@/lib/slack/config";
import { CALENDAR_READ_SCOPE, GMAIL_READ_SCOPE, hasScope } from "@/lib/integrations/core";
import { placeholderSummary } from "@/lib/admin/user-queries";
import { canDecide } from "@/lib/approvals/registry";
import { forecastWindow } from "@/lib/forecast/core";
import { defaultQuotaLines, isQuotaMetric, type QuotaMetric } from "@/lib/quotas/core";
import { applicableSteps, isSellingRole, onboardingStatus, progressSteps, STEP_META, wizardProgress, type OnboardingState } from "@/lib/welcome/core";
import { unclaimedPlaceholderExists } from "@/lib/welcome/queries";
import { isPlaceholderEmail } from "@/lib/admin/claim-plan";
import type { SetupScope } from "./scope";

const manager = alias(s.user, "manager");

/** Role → what the wizard would show (motions visible, email / calls permission). One matrix per role (cached). */
async function roleFacts(roles: Role[]) {
  const pipes = await db.select({ key: s.pipelines.key }).from(s.pipelines).where(eq(s.pipelines.active, true));
  const out = new Map<Role, { motionKeys: string[]; canEmail: boolean; canCalls: boolean }>();
  for (const role of roles) {
    const m = await getMatrix(role);
    const rank = (mod: keyof typeof m, a: "view") => SCOPE_RANK[m[mod]?.[a] ?? "none"];
    out.set(role, {
      motionKeys: pipes.filter((p) => (m[dealModule(p.key)]?.view ?? "none") !== "none").map((p) => p.key),
      canEmail: rank("email", "view") > 0,
      canCalls: rank("calls", "view") > 0,
    });
  }
  return out;
}

export type BoardRow = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
  roleLabel: string;
  teamName: string | null;
  managerName: string | null;
  lastActiveAt: string | null;
  status: ReturnType<typeof onboardingStatus>;
  done: number;
  total: number;
  /** Gaps to chase: skipped steps and missing connections ("No Gmail"). */
  gaps: string[];
  canNudge: boolean;
};

/** People in scope (active, real users) with their onboarding state. */
export async function loadBoard(user: AppUser, scope: SetupScope): Promise<BoardRow[]> {
  const rows = await db
    .select({
      id: s.user.id,
      name: s.user.name,
      email: s.user.email,
      image: s.user.image,
      role: s.user.role,
      banned: s.user.banned,
      teamName: s.teams.name,
      managerName: manager.name,
      lastActiveAt: s.user.lastActiveAt,
      onboarding: s.userPrefs.onboarding,
      slackUserId: s.userPrefs.slackUserId,
      slackDm: s.userPrefs.slackDm,
      googleScope: sql<string | null>`(select a.scope from ${s.account} a where a.user_id = ${s.user.id} and a.provider_id = 'google' order by a.updated_at desc limit 1)`,
      granola: sql<boolean>`exists (select 1 from ${s.integrationConnections} c where c.user_id = ${s.user.id} and c.provider = 'granola' and c.status <> 'revoked' and c.secret_encrypted is not null)`,
    })
    .from(s.user)
    .leftJoin(s.teams, eq(s.teams.id, s.user.teamId))
    .leftJoin(manager, eq(manager.id, s.user.managerId))
    .leftJoin(s.userPrefs, eq(s.userPrefs.userId, s.user.id))
    .where(scope.memberIds ? inArray(s.user.id, scope.memberIds.length ? scope.memberIds : ["-"]) : sql`true`)
    .orderBy(asc(s.user.name));
  const people = rows.filter((r) => !r.banned && !isPlaceholderEmail(r.email) && (ROLES as readonly string[]).includes(r.role) && r.role !== "pending");
  const roles = Array.from(new Set(people.map((p) => p.role as Role)));
  const [facts, slack, placeholders] = await Promise.all([roleFacts(roles), getSlackContext().catch(() => null), unclaimedPlaceholderExists().catch(() => false)]);
  return people.map((p) => {
    const role = p.role as Role;
    const f = facts.get(role)!;
    const state = (p.onboarding ?? {}) as OnboardingState;
    const steps = applicableSteps({
      role,
      motionCount: f.motionKeys.length,
      hasPlaceholders: placeholders || Boolean(state.steps?.book),
      canEmail: f.canEmail,
      canCalls: f.canCalls,
      slackConfigured: Boolean(slack),
    });
    const prog = wizardProgress(state, steps);
    const gaps: string[] = [];
    if (f.canEmail && !(hasScope(p.googleScope, GMAIL_READ_SCOPE) && hasScope(p.googleScope, CALENDAR_READ_SCOPE))) gaps.push("No Gmail");
    if (f.canCalls && !p.granola) gaps.push("No Granola");
    if (slack && !(p.slackDm && p.slackUserId)) gaps.push("No Slack");
    for (const sk of prog.skipped) if (sk !== "tools") gaps.push(`Skipped ${STEP_META[sk].short.toLowerCase()}`);
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      image: p.image,
      role,
      roleLabel: ROLE_LABELS[role],
      teamName: p.teamName,
      managerName: p.managerName,
      lastActiveAt: p.lastActiveAt?.toISOString() ?? null,
      status: onboardingStatus(state),
      done: prog.done,
      total: progressSteps(steps).length,
      gaps,
      canNudge: p.id !== user.id,
    };
  });
}

export type ClaimRow = {
  id: string;
  requesterId: string;
  requesterName: string;
  placeholderId: string;
  placeholderName: string;
  deals: number;
  note: string | null;
  createdAt: string;
  dueAt: string | null;
  overdue: boolean;
  canDecide: boolean;
};

/** Pending placeholder claims (counts only — never deal names). Leaders see their team's requests, read-only. */
export async function loadClaims(user: AppUser, scope: SetupScope): Promise<ClaimRow[]> {
  const rows = await db
    .select()
    .from(s.approvals)
    .where(and(eq(s.approvals.kind, "placeholder_claim"), eq(s.approvals.status, "pending")))
    .orderBy(asc(s.approvals.createdAt))
    .limit(200);
  const visible = rows.filter((a) => scope.memberIds === null || scope.memberIds.includes(a.requestedBy));
  if (!visible.length) return [];
  const now = Date.now();
  const names = new Map(
    (await db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(inArray(s.user.id, visible.map((a) => a.requestedBy)))).map((u) => [u.id, u.name]),
  );
  return Promise.all(
    visible.map(async (a) => ({
      id: a.id,
      requesterId: a.requestedBy,
      requesterName: names.get(a.requestedBy) ?? "Someone",
      placeholderId: a.entityId,
      placeholderName: typeof a.payload?.placeholderName === "string" ? a.payload.placeholderName : "Placeholder",
      deals: typeof a.payload?.deals === "number" ? a.payload.deals : 0,
      note: a.note,
      createdAt: a.createdAt.toISOString(),
      dueAt: a.dueAt?.toISOString() ?? null,
      overdue: Boolean(a.dueAt && a.dueAt.getTime() < now),
      canDecide: !scope.readOnly && (await canDecide(user, a).catch(() => false)),
    })),
  );
}

/** Admin-only direct assignment: unclaimed placeholders with counts, and the real people they can go to. */
export async function loadPlaceholderAssign() {
  const [phs, people] = await Promise.all([
    placeholderSummary(),
    db
      .select({ id: s.user.id, name: s.user.name, email: s.user.email, role: s.user.role, banned: s.user.banned })
      .from(s.user)
      .orderBy(asc(s.user.name)),
  ]);
  return {
    placeholders: phs.filter((p) => !p.claimed).map((p) => ({ id: p.id, name: p.name, deals: p.deals, accounts: p.accounts, tasks: p.tasks })),
    people: people
      .filter((p) => !p.banned && !isPlaceholderEmail(p.email) && p.role !== "pending" && isSellingRole(p.role as Role))
      .map((p) => ({ id: p.id, name: p.name })),
  };
}

export type QuotaCell = { id: string; metric: QuotaMetric; target: number; status: string; note: string | null };
export type QuotaPerson = {
  id: string;
  name: string;
  roleLabel: string;
  editable: boolean;
  lines: { pipelineKey: string; metric: QuotaMetric }[];
  /** `${period}|${pipelineKey}` → the quota on that line (any metric). */
  cells: Record<string, QuotaCell>;
};

/** Quotas grid: sellers in scope × current/next quarter. */
export async function loadQuotaGrid(user: AppUser, scope: SetupScope) {
  const { current, next } = forecastWindow(new Date(), user.timezone);
  const people = await db
    .select({ id: s.user.id, name: s.user.name, email: s.user.email, role: s.user.role, banned: s.user.banned, pipelineKeys: s.userPrefs.pipelineKeys })
    .from(s.user)
    .leftJoin(s.userPrefs, eq(s.userPrefs.userId, s.user.id))
    .where(scope.memberIds ? inArray(s.user.id, scope.memberIds.length ? scope.memberIds : ["-"]) : sql`true`)
    .orderBy(asc(s.user.name));
  const sellers = people.filter((p) => !p.banned && !isPlaceholderEmail(p.email) && isSellingRole(p.role as Role));
  const quotas = sellers.length
    ? await db
        .select()
        .from(s.quotas)
        .where(and(inArray(s.quotas.userId, sellers.map((p) => p.id)), inArray(s.quotas.period, [current, next])))
        .orderBy(desc(s.quotas.updatedAt))
    : [];
  const facts = await roleFacts(Array.from(new Set(sellers.map((p) => p.role as Role))));
  const motions = await db
    .select({ key: s.pipelines.key, name: s.pipelines.name, color: s.pipelines.color })
    .from(s.pipelines)
    .where(eq(s.pipelines.active, true))
    .orderBy(asc(s.pipelines.sortOrder));
  const rows: QuotaPerson[] = sellers.map((p) => {
    const role = p.role as Role;
    const permitted = facts.get(role)!.motionKeys;
    const mine = (p.pipelineKeys ?? []).filter((k) => permitted.includes(k));
    const own = quotas.filter((q) => q.userId === p.id && isQuotaMetric(q.metric));
    const lines = defaultQuotaLines(role, mine.length ? mine : permitted.slice(0, 3));
    for (const q of own) if (!lines.some((l) => l.pipelineKey === q.pipelineKey)) lines.push({ pipelineKey: q.pipelineKey, metric: q.metric as QuotaMetric });
    const cells: Record<string, QuotaCell> = {};
    for (const q of own) {
      const k = `${q.period}|${q.pipelineKey}`;
      if (!cells[k]) cells[k] = { id: q.id, metric: q.metric as QuotaMetric, target: q.target, status: q.status, note: q.note };
    }
    return { id: p.id, name: p.name, roleLabel: ROLE_LABELS[role], editable: !scope.readOnly && !(scope.kind === "team" && p.id === user.id), lines, cells };
  });
  return { current, next, rows, motions, proposed: quotas.filter((q) => q.status === "proposed").length };
}
