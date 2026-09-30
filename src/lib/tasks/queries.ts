import "server-only";
import { and, desc, eq, gte, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealAccessWhere, inScope, ownedEntityWhere, scopeFor, type AppUser } from "@/lib/rbac/server";
import { SCOPE_RANK, type Scope } from "@/lib/rbac/model";

/** Serializable task for client components (dates as ISO strings, related names permission-filtered). */
export type TaskView = {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "done" | "cancelled";
  priority: string | null;
  dueAt: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  createdBy: string | null;
  dealId: string | null;
  dealName: string | null;
  accountId: string | null;
  accountName: string | null;
  contactId: string | null;
  contactName: string | null;
  origin: string;
  owedBy: string | null;
  evidence: string | null;
  evidenceSource: string | null;
  snoozeCount: number;
  snoozedUntil: string | null;
  completedAt: string | null;
  canEdit: boolean;
};

export type UserOption = { id: string; name: string };

type Row = typeof s.tasks.$inferSelect;

/** Visible related-record names. Records the user can't see (incl. restricted deals) come back null. */
async function relatedNames(user: AppUser, rows: Row[]) {
  const dealIds = [...new Set(rows.map((r) => r.dealId).filter(Boolean))] as string[];
  const accIds = [...new Set(rows.map((r) => r.accountId).filter(Boolean))] as string[];
  const conIds = [...new Set(rows.map((r) => r.contactId).filter(Boolean))] as string[];
  const userIds = [...new Set(rows.map((r) => r.assigneeId).filter(Boolean))] as string[];
  const [dw, aw, cw] = await Promise.all([
    dealIds.length ? dealAccessWhere(user, "view") : null,
    accIds.length ? ownedEntityWhere(user, "accounts", "view", s.accounts.ownerId) : null,
    conIds.length ? ownedEntityWhere(user, "contacts", "view", s.contacts.ownerId) : null,
  ]);
  const [deals, accounts, contacts, users] = await Promise.all([
    dw ? db.select({ id: s.deals.id, name: s.deals.name }).from(s.deals).where(and(dw, inArray(s.deals.id, dealIds))) : [],
    aw
      ? db
          .select({ id: s.accounts.id, name: s.accounts.name })
          .from(s.accounts)
          .where(and(aw, inArray(s.accounts.id, accIds), isNull(s.accounts.deletedAt), eq(s.accounts.restricted, false)))
      : [],
    cw
      ? db
          .select({ id: s.contacts.id, name: s.contacts.fullName })
          .from(s.contacts)
          .where(and(cw, inArray(s.contacts.id, conIds), isNull(s.contacts.deletedAt)))
      : [],
    userIds.length ? db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(inArray(s.user.id, userIds)) : [],
  ]);
  return {
    deal: new Map(deals.map((d) => [d.id, d.name])),
    account: new Map(accounts.map((a) => [a.id, a.name])),
    contact: new Map(contacts.map((c) => [c.id, c.name])),
    user: new Map(users.map((u) => [u.id, u.name])),
  };
}

async function toViews(user: AppUser, rows: Row[]): Promise<TaskView[]> {
  if (!rows.length) return [];
  const [names, editScope] = await Promise.all([relatedNames(user, rows), scopeFor(user, "tasks", "edit")]);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    dueAt: r.dueAt?.toISOString() ?? null,
    assigneeId: r.assigneeId,
    assigneeName: r.assigneeId ? (names.user.get(r.assigneeId) ?? null) : null,
    createdBy: r.createdBy,
    dealId: r.dealId && names.deal.has(r.dealId) ? r.dealId : null,
    dealName: r.dealId ? (names.deal.get(r.dealId) ?? null) : null,
    accountId: r.accountId && names.account.has(r.accountId) ? r.accountId : null,
    accountName: r.accountId ? (names.account.get(r.accountId) ?? null) : null,
    contactId: r.contactId && names.contact.has(r.contactId) ? r.contactId : null,
    contactName: r.contactId ? (names.contact.get(r.contactId) ?? null) : null,
    origin: r.origin,
    owedBy: r.owedBy,
    evidence: r.evidence,
    evidenceSource: r.evidenceSource,
    snoozeCount: r.snoozeCount,
    snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    canEdit: canEditTaskSync(user, editScope, r),
  }));
}

export function canEditTaskSync(user: AppUser, editScope: Scope, t: { assigneeId: string | null; createdBy: string | null }) {
  if (SCOPE_RANK[editScope] < SCOPE_RANK.own) return false;
  if (t.assigneeId === user.id || t.createdBy === user.id) return true;
  return inScope(user, editScope, { ownerId: t.assigneeId });
}

/** My open tasks + tasks I completed in the last 7 days. */
export async function listMyTasks(user: AppUser): Promise<{ open: TaskView[]; done: TaskView[] }> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [open, done] = await Promise.all([
    db.select().from(s.tasks).where(and(eq(s.tasks.assigneeId, user.id), eq(s.tasks.status, "open"))).limit(500),
    db
      .select()
      .from(s.tasks)
      .where(and(eq(s.tasks.assigneeId, user.id), ne(s.tasks.status, "open"), gte(s.tasks.updatedAt, weekAgo)))
      .orderBy(desc(s.tasks.updatedAt))
      .limit(50),
  ]);
  const views = await toViews(user, [...open, ...done]);
  return { open: views.filter((v) => v.status === "open"), done: views.filter((v) => v.status !== "open") };
}

/** Team scope: open tasks of teammates / reports (tasks.view ≥ team). Returns null when the user has no team view. */
export async function listTeamTasks(user: AppUser): Promise<TaskView[] | null> {
  const scope = await scopeFor(user, "tasks", "view");
  if (SCOPE_RANK[scope] < SCOPE_RANK.team) return null;
  let where: SQL = and(eq(s.tasks.status, "open"), ne(s.tasks.assigneeId, user.id))!;
  if (scope === "team") where = and(where, inArray(s.tasks.assigneeId, user.teamMemberIds.length ? user.teamMemberIds : [user.id]))!;
  const rows = await db.select().from(s.tasks).where(where).orderBy(s.tasks.dueAt).limit(300);
  return toViews(user, rows);
}

export async function getTaskForUser(user: AppUser, id: string): Promise<TaskView | null> {
  const [row] = await db.select().from(s.tasks).where(eq(s.tasks.id, id));
  if (!row) return null;
  const viewScope = await scopeFor(user, "tasks", "view");
  const visible = row.assigneeId === user.id || row.createdBy === user.id || inScope(user, viewScope, { ownerId: row.assigneeId });
  if (!visible) return null;
  return (await toViews(user, [row]))[0] ?? null;
}

/** Users this user may assign tasks to (tasks.assign scope; self always). */
export async function assignableUsers(user: AppUser): Promise<UserOption[]> {
  const scope = await scopeFor(user, "tasks", "assign");
  const active = and(ne(s.user.role, "pending"), or(isNull(s.user.banned), eq(s.user.banned, false)))!;
  let rows: UserOption[];
  if (scope === "all" || scope === "pipeline") rows = await db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(active);
  else if (scope === "team")
    rows = await db
      .select({ id: s.user.id, name: s.user.name })
      .from(s.user)
      .where(and(active, inArray(s.user.id, user.teamMemberIds.length ? user.teamMemberIds : [user.id])));
  else rows = [{ id: user.id, name: user.name }];
  if (!rows.some((r) => r.id === user.id)) rows.push({ id: user.id, name: user.name });
  return rows.sort((a, b) => (a.id === user.id ? -1 : b.id === user.id ? 1 : a.name.localeCompare(b.name)));
}
