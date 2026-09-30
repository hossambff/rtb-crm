import "server-only";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { can, scopeFor, type AppUser } from "@/lib/rbac/server";
import type { Scope } from "@/lib/rbac/model";
import { getSetting } from "@/lib/settings";
import { keyFromNote, normalizeRules, statementTotals, type PlanRule } from "./calc";
import { daysLeft, registrationState } from "./registration";

/** SQL filter on commission_accruals.userId for the user's commissions view scope (COM-5 rep portal). */
export function accrualScopeWhere(user: AppUser, scope: Scope): SQL {
  switch (scope) {
    case "all":
    case "pipeline":
      return sql`true`;
    case "team":
      return inArray(s.commissionAccruals.userId, user.teamMemberIds.length ? user.teamMemberIds : [user.id]);
    case "own":
      return eq(s.commissionAccruals.userId, user.id);
    default:
      return sql`false`;
  }
}

export async function commissionPerms(user: AppUser) {
  const [view, canConfigure, canApprove, canEdit, canCreate, canDecideRegistrations] = await Promise.all([
    scopeFor(user, "commissions", "view"),
    can(user, "commissions", "configure", "all"),
    can(user, "commissions", "approve", "all"),
    can(user, "commissions", "edit", "all"),
    can(user, "commissions", "create", "all"),
    can(user, "accounts", "assign", "all"),
  ]);
  return { view, canConfigure, canApprove, canMarkPaid: canEdit, canRun: canCreate || canConfigure, canDecideRegistrations };
}

export type AccrualRow = {
  id: string;
  userId: string;
  userName: string;
  planName: string | null;
  dealName: string | null;
  trigger: string;
  amountCents: number;
  status: string;
  period: string;
  note: string;
  createdAt: string;
};

function displayNote(note: string | null): string {
  if (!note) return "";
  const key = keyFromNote(note);
  return key ? note.slice(key.length + 4).trim() : note;
}

export async function listAccruals(user: AppUser, filter: { period?: string; userId?: string; status?: string } = {}) {
  const scope = await scopeFor(user, "commissions", "view");
  const conds: SQL[] = [accrualScopeWhere(user, scope)];
  if (filter.period) conds.push(eq(s.commissionAccruals.period, filter.period));
  if (filter.userId) conds.push(eq(s.commissionAccruals.userId, filter.userId));
  if (filter.status) conds.push(eq(s.commissionAccruals.status, filter.status));
  const rows = await db
    .select({
      a: s.commissionAccruals,
      userName: s.user.name,
      planName: s.commissionPlans.name,
      dealName: s.deals.name,
      dealRestricted: s.deals.restricted,
    })
    .from(s.commissionAccruals)
    .innerJoin(s.user, eq(s.user.id, s.commissionAccruals.userId))
    .leftJoin(s.commissionPlans, eq(s.commissionPlans.id, s.commissionAccruals.planId))
    .leftJoin(s.deals, eq(s.deals.id, s.commissionAccruals.dealId))
    .where(and(...conds))
    .orderBy(desc(s.commissionAccruals.period), desc(s.commissionAccruals.createdAt))
    .limit(2000);
  return rows.map(
    (r): AccrualRow => ({
      id: r.a.id,
      userId: r.a.userId,
      userName: r.userName,
      planName: r.planName,
      // Restricted (MNPI) deal names are only shown to the credited rep and super admins.
      dealName: r.dealRestricted && r.a.userId !== user.id && user.role !== "super_admin" ? "Restricted deal" : r.dealName,
      trigger: r.a.trigger,
      amountCents: r.a.amountCents,
      status: r.a.status,
      period: r.a.period,
      note: displayNote(r.a.note),
      createdAt: r.a.createdAt.toISOString(),
    }),
  );
}

export async function getCommissionsOverview(user: AppUser, filter: { period?: string; userId?: string }) {
  const perms = await commissionPerms(user);
  const accruals = await listAccruals(user, filter);
  const periods = Array.from(new Set(accruals.map((a) => a.period))).sort().reverse();

  // Statements: rep × period with totals.
  const byKey = new Map<string, { userId: string; userName: string; period: string; rows: AccrualRow[] }>();
  for (const a of accruals) {
    const k = `${a.userId}|${a.period}`;
    const cur = byKey.get(k) ?? { userId: a.userId, userName: a.userName, period: a.period, rows: [] };
    cur.rows.push(a);
    byKey.set(k, cur);
  }
  const statements = [...byKey.values()]
    .map((st) => ({ userId: st.userId, userName: st.userName, period: st.period, count: st.rows.length, totals: statementTotals(st.rows) }))
    .sort((a, b) => b.period.localeCompare(a.period) || a.userName.localeCompare(b.userName));

  const plans = await db.select().from(s.commissionPlans).orderBy(asc(s.commissionPlans.name));
  const assignmentRows = await db
    .select({ a: s.commissionAssignments, userName: s.user.name, userRole: s.user.role, planName: s.commissionPlans.name })
    .from(s.commissionAssignments)
    .innerJoin(s.user, eq(s.user.id, s.commissionAssignments.userId))
    .innerJoin(s.commissionPlans, eq(s.commissionPlans.id, s.commissionAssignments.planId))
    .where(perms.view === "all" || perms.canConfigure ? sql`true` : perms.view === "team" ? inArray(s.commissionAssignments.userId, user.teamMemberIds) : eq(s.commissionAssignments.userId, user.id))
    .orderBy(asc(s.user.name));
  const visiblePlanIds = new Set(assignmentRows.map((r) => r.a.planId));
  const planList = plans
    .filter((p) => perms.canConfigure || perms.view === "all" || visiblePlanIds.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, description: p.description, active: p.active, rules: normalizeRules(p.rules) as PlanRule[] }));

  const users = perms.canConfigure
    ? await db
        .select({ id: s.user.id, name: s.user.name, role: s.user.role })
        .from(s.user)
        .where(and(ne(s.user.role, "pending"), or(isNull(s.user.banned), eq(s.user.banned, false))))
        .orderBy(asc(s.user.name))
    : [];

  return {
    perms,
    accruals,
    periods,
    statements,
    plans: planList,
    assignments: assignmentRows.map((r) => ({
      userId: r.a.userId,
      userName: r.userName,
      userRole: r.userRole,
      planId: r.a.planId,
      planName: r.planName,
      effectiveFrom: r.a.effectiveFrom.toISOString(),
    })),
    users,
    totals: statementTotals(accruals),
  };
}

export type RegistrationRow = {
  id: string;
  accountId: string;
  accountName: string;
  domain: string | null;
  userId: string;
  userName: string;
  status: string;
  state: ReturnType<typeof registrationState>;
  protectedUntil: string | null;
  daysLeft: number | null;
  note: string | null;
  createdAt: string;
};

/** Registrations: the user's own, plus the pending queue / all for approvers (sales leaders, execs, admins). */
export async function getRegistrations(user: AppUser) {
  const perms = await commissionPerms(user);
  const now = new Date();
  const protectDays = Number(await getSetting<number>("commission.registration_protect_days", 90)) || 90;
  const rows = await db
    .select({ r: s.leadRegistrations, accountName: s.accounts.name, domain: s.accounts.domain, restricted: s.accounts.restricted, userName: s.user.name })
    .from(s.leadRegistrations)
    .innerJoin(s.accounts, eq(s.accounts.id, s.leadRegistrations.accountId))
    .innerJoin(s.user, eq(s.user.id, s.leadRegistrations.userId))
    .where(perms.canDecideRegistrations ? sql`true` : eq(s.leadRegistrations.userId, user.id))
    .orderBy(desc(s.leadRegistrations.createdAt))
    .limit(1000);
  const list = rows
    .filter((x) => !x.restricted || user.role === "super_admin" || x.r.userId === user.id)
    .map(
      (x): RegistrationRow => ({
        id: x.r.id,
        accountId: x.r.accountId,
        accountName: x.accountName,
        domain: x.domain,
        userId: x.r.userId,
        userName: x.userName,
        status: x.r.status,
        state: registrationState(x.r, now),
        protectedUntil: x.r.protectedUntil?.toISOString() ?? null,
        daysLeft: daysLeft(x.r.protectedUntil, now),
        note: x.r.note,
        createdAt: x.r.createdAt.toISOString(),
      }),
    );
  return {
    mine: list.filter((r) => r.userId === user.id),
    queue: perms.canDecideRegistrations ? list.filter((r) => r.state === "pending") : [],
    all: perms.canDecideRegistrations ? list : [],
    protectDays,
    canDecide: perms.canDecideRegistrations,
  };
}

export async function getStatement(user: AppUser, userId: string, period: string) {
  const rows = await listAccruals(user, { userId, period });
  const [u] = await db.select({ name: s.user.name, email: s.user.email }).from(s.user).where(eq(s.user.id, userId));
  return { user: u ?? null, rows, totals: statementTotals(rows) };
}
