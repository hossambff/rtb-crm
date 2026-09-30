import "server-only";
import { and, asc, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { isPlaceholderEmail } from "./claim-plan";

const manager = alias(s.user, "manager");

export type AdminUserRow = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string;
  title: string | null;
  teamId: string | null;
  teamName: string | null;
  managerId: string | null;
  managerName: string | null;
  employmentType: string | null;
  banned: boolean;
  banReason: string | null;
  accessExpiresAt: Date | null;
  lastActiveAt: Date | null;
  createdAt: Date;
  hasLogin: boolean;
  activeSessions: number;
  placeholder: boolean;
};

export async function listAdminUsers(): Promise<AdminUserRow[]> {
  const rows = await db
    .select({
      id: s.user.id,
      name: s.user.name,
      email: s.user.email,
      image: s.user.image,
      role: s.user.role,
      title: s.user.title,
      teamId: s.user.teamId,
      teamName: s.teams.name,
      managerId: s.user.managerId,
      managerName: manager.name,
      employmentType: s.user.employmentType,
      banned: s.user.banned,
      banReason: s.user.banReason,
      accessExpiresAt: s.user.accessExpiresAt,
      lastActiveAt: s.user.lastActiveAt,
      createdAt: s.user.createdAt,
      hasLogin: sql<boolean>`exists (select 1 from ${s.account} a where a.user_id = ${s.user.id})`,
      activeSessions: sql<number>`(select count(*)::int from ${s.session} se where se.user_id = ${s.user.id} and se.expires_at > now())`,
    })
    .from(s.user)
    .leftJoin(s.teams, eq(s.user.teamId, s.teams.id))
    .leftJoin(manager, eq(s.user.managerId, manager.id))
    .orderBy(asc(s.user.banned), asc(s.user.name));
  return rows.map((r) => ({ ...r, banned: Boolean(r.banned), hasLogin: Boolean(r.hasLogin), placeholder: isPlaceholderEmail(r.email) }));
}

export async function listTeamsLite() {
  return db.select({ id: s.teams.id, name: s.teams.name }).from(s.teams).orderBy(asc(s.teams.name));
}

/** Open records a user owns — shown in the deactivation/reassignment wizard. */
export async function ownedRecordCounts(userId: string) {
  const [[deals], [tasks], [accounts], [contacts]] = await Promise.all([
    db
      .select({ n: count() })
      .from(s.deals)
      .where(and(eq(s.deals.ownerId, userId), isNull(s.deals.deletedAt), inArray(s.deals.status, ["open", "hold"]))),
    db
      .select({ n: count() })
      .from(s.tasks)
      .where(and(eq(s.tasks.assigneeId, userId), eq(s.tasks.status, "open"))),
    db
      .select({ n: count() })
      .from(s.accounts)
      .where(and(eq(s.accounts.ownerId, userId), isNull(s.accounts.deletedAt))),
    db
      .select({ n: count() })
      .from(s.contacts)
      .where(and(eq(s.contacts.ownerId, userId), isNull(s.contacts.deletedAt))),
  ]);
  return { deals: Number(deals?.n ?? 0), tasks: Number(tasks?.n ?? 0), accounts: Number(accounts?.n ?? 0), contacts: Number(contacts?.n ?? 0) };
}

/** Placeholder users with how much they own (to prioritise claiming). */
export async function placeholderSummary() {
  const rows = await db
    .select({
      id: s.user.id,
      name: s.user.name,
      email: s.user.email,
      banned: s.user.banned,
      banReason: s.user.banReason,
      deals: sql<number>`(select count(*)::int from ${s.deals} d where d.owner_id = "user".id and d.deleted_at is null)`,
      accounts: sql<number>`(select count(*)::int from ${s.accounts} a where a.owner_id = "user".id and a.deleted_at is null)`,
      tasks: sql<number>`(select count(*)::int from ${s.tasks} t where t.assignee_id = "user".id and t.status = 'open')`,
    })
    .from(s.user)
    .where(sql`lower(${s.user.email}) like '%.placeholder@roundtable.invalid'`)
    .orderBy(asc(s.user.name));
  // Imports create placeholders already banned (they must never sign in); "claimed" is marked by the ban reason.
  return rows
    .map(({ banReason, ...r }) => ({ ...r, banned: Boolean(r.banned), claimed: (banReason ?? "").startsWith("Claimed by") }))
    .sort((a, b) => Number(a.claimed) - Number(b.claimed) || b.deals - a.deals);
}

export async function countSuperAdmins(excludeId?: string) {
  const [r] = await db
    .select({ n: count() })
    .from(s.user)
    .where(and(eq(s.user.role, "super_admin"), sql`coalesce(${s.user.banned}, false) = false`, excludeId ? ne(s.user.id, excludeId) : sql`true`));
  return Number(r?.n ?? 0);
}

