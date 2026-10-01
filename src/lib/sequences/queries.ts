import "server-only";
import { and, desc, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { contactVisibilityWhere } from "@/lib/contacts/queries";
import { dealAccessWhere, type AppUser } from "@/lib/rbac/server";
import { canEditSequence, enrollmentScopeWhere, gmailStatus, isSequenceAdmin, sequenceVisibleWhere } from "./access";
import { computeMetrics, isOnOlderVersion, isSystemPause, stepsForEnrollment, validateSequence, type ExitRules, type HistoryEntry, type SequenceMetrics, type Step } from "./core";

const owner = alias(s.user, "seq_owner");
const sender = alias(s.user, "seq_sender");

/** Enrollments visible to the user: mailbox scope AND the contact must be visible (restricted accounts, RBAC). */
async function enrollmentVisibleWhere(user: AppUser): Promise<SQL> {
  const [scope, contactOk] = await Promise.all([enrollmentScopeWhere(user), contactVisibilityWhere(user)]);
  return and(scope, exists(db.select({ x: sql`1` }).from(s.contacts).where(and(eq(s.contacts.id, s.sequenceEnrollments.contactId), contactOk))))!;
}

async function metricsFor(user: AppUser, sequenceIds: string[]): Promise<Map<string, SequenceMetrics>> {
  const out = new Map<string, SequenceMetrics>();
  if (!sequenceIds.length) return out;
  const visible = await enrollmentVisibleWhere(user);
  const rows = await db
    .select({ seq: s.sequenceEnrollments.sequenceId, status: s.sequenceEnrollments.status, exitReason: s.sequenceEnrollments.exitReason, n: sql<number>`count(*)::int` })
    .from(s.sequenceEnrollments)
    .where(and(inArray(s.sequenceEnrollments.sequenceId, sequenceIds), visible))
    .groupBy(s.sequenceEnrollments.sequenceId, s.sequenceEnrollments.status, s.sequenceEnrollments.exitReason);
  for (const id of sequenceIds) out.set(id, computeMetrics(rows.filter((r) => r.seq === id)));
  return out;
}

export type SequenceListRow = {
  id: string;
  name: string;
  description: string | null;
  ownerName: string | null;
  mine: boolean;
  shared: boolean;
  active: boolean;
  steps: Step[];
  dailyCap: number;
  pipelineKeys: string[];
  canEdit: boolean;
  problems: string[];
  metrics: SequenceMetrics;
  updatedAt: Date;
};

export async function listSequences(user: AppUser): Promise<SequenceListRow[]> {
  const [where, admin] = await Promise.all([sequenceVisibleWhere(user), isSequenceAdmin(user)]);
  const rows = await db
    .select({ q: s.sequences, ownerName: owner.name })
    .from(s.sequences)
    .leftJoin(owner, eq(owner.id, s.sequences.ownerId))
    .where(where)
    .orderBy(desc(s.sequences.active), desc(s.sequences.updatedAt))
    .limit(200);
  const metrics = await metricsFor(user, rows.map((r) => r.q.id));
  return rows.map(({ q, ownerName }) => ({
    id: q.id,
    name: q.name,
    description: q.description,
    ownerName,
    mine: q.ownerId === user.id,
    shared: q.shared,
    active: q.active,
    steps: q.steps as Step[],
    dailyCap: q.dailyCap,
    pipelineKeys: q.pipelineKeys,
    canEdit: canEditSequence(user, admin, q),
    problems: validateSequence(q.steps as Step[]),
    metrics: metrics.get(q.id)!,
    updatedAt: q.updatedAt,
  }));
}

/** For enroll pickers (WS-F bulk bar, ⌘K, contact/deal/account panels). Only active, valid, visible sequences. */
export async function listEnrollableSequences(user: AppUser): Promise<{ id: string; name: string; stepCount: number; pipelineKeys: string[]; ownerName: string | null; hasEmail: boolean; usesOpener: boolean }[]> {
  const rows = await db
    .select({ q: s.sequences, ownerName: owner.name })
    .from(s.sequences)
    .leftJoin(owner, eq(owner.id, s.sequences.ownerId))
    .where(and(await sequenceVisibleWhere(user), eq(s.sequences.active, true)))
    .orderBy(sql`${s.sequences.ownerId} = ${user.id} desc`, s.sequences.name)
    .limit(200);
  return rows
    .filter((r) => validateSequence(r.q.steps as Step[]).length === 0)
    .map((r) => ({ id: r.q.id, name: r.q.name, stepCount: (r.q.steps as Step[]).length, pipelineKeys: r.q.pipelineKeys, ownerName: r.ownerName, hasEmail: (r.q.steps as Step[]).some((x) => x.kind === "email"), usesOpener: (r.q.steps as Step[]).some((x) => /\{\{\s*opener\s*(\||\}\})/i.test(`${x.subject ?? ""} ${x.body ?? ""}`)) }));
}

export async function getSequence(user: AppUser, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [where, admin] = await Promise.all([sequenceVisibleWhere(user), isSequenceAdmin(user)]);
  const [row] = await db
    .select({ q: s.sequences, ownerName: owner.name })
    .from(s.sequences)
    .leftJoin(owner, eq(owner.id, s.sequences.ownerId))
    .where(and(eq(s.sequences.id, id), where));
  if (!row) return null;
  const [metrics, older] = await Promise.all([
    metricsFor(user, [id]).then((m) => m.get(id)!),
    // people still running an older version of the steps (SEC H-3): shown with an explicit "apply new steps" action
    db
      .select({ n: sql<number>`count(*)::int`, senders: sql<number>`count(distinct ${s.sequenceEnrollments.senderId})::int` })
      .from(s.sequenceEnrollments)
      .where(and(eq(s.sequenceEnrollments.sequenceId, id), inArray(s.sequenceEnrollments.status, ["active", "paused"]), sql`coalesce(${s.sequenceEnrollments.stepsVersion}, 1) < ${row.q.version}`))
      .then((r) => r[0] ?? { n: 0, senders: 0 }),
  ]);
  return {
    sequence: { ...row.q, steps: row.q.steps as Step[], exitOn: row.q.exitOn as ExitRules },
    ownerName: row.ownerName,
    canEdit: canEditSequence(user, admin, row.q),
    isAdmin: admin,
    metrics,
    olderVersion: { enrollments: Number(older.n), senders: Number(older.senders) },
  };
}

export type EnrollmentRow = {
  id: string;
  sequenceId: string;
  sequenceName: string;
  stepCount: number;
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  accountName: string | null;
  dealId: string | null;
  dealName: string | null;
  senderId: string;
  senderName: string | null;
  status: string;
  currentStep: number;
  nextRunAt: string | null;
  exitReason: string | null;
  lastError: string | null;
  lastEventAt: string | null;
  lastEventKind: string | null;
  /** paused by the system (Gmail, access, restriction…) rather than by a person (QA MAJ-12) */
  systemPaused: boolean;
  /** running an older version of the steps than the sequence's current one (SEC H-3) */
  olderVersion: boolean;
  sentCount: number;
  createdAt: string;
  canManage: boolean;
};

type EnrollmentFilter = { sequenceId?: string; dealId?: string; contactIds?: string[]; contactId?: string; attention?: boolean; senderId?: string; limit?: number };

/** Enrollment rows with names; deal names only for deals the user can see (MNPI). */
export async function listEnrollments(user: AppUser, f: EnrollmentFilter): Promise<EnrollmentRow[]> {
  const [visible, dealWhere, admin] = await Promise.all([enrollmentVisibleWhere(user), dealAccessWhere(user, "view"), isSequenceAdmin(user)]);
  const conds: SQL[] = [visible];
  if (f.sequenceId) conds.push(eq(s.sequenceEnrollments.sequenceId, f.sequenceId));
  if (f.contactId) conds.push(eq(s.sequenceEnrollments.contactId, f.contactId));
  if (f.senderId) conds.push(eq(s.sequenceEnrollments.senderId, f.senderId));
  if (f.attention) conds.push(or(eq(s.sequenceEnrollments.status, "failed"), eq(s.sequenceEnrollments.status, "paused"))!);
  if (f.dealId || f.contactIds?.length) {
    const any: SQL[] = [];
    if (f.dealId) any.push(eq(s.sequenceEnrollments.dealId, f.dealId));
    if (f.contactIds?.length) any.push(inArray(s.sequenceEnrollments.contactId, f.contactIds));
    conds.push(or(...any)!);
  }
  const rows = await db
    .select({
      e: s.sequenceEnrollments,
      seqName: s.sequences.name,
      steps: s.sequences.steps,
      seqVersion: s.sequences.version,
      contactName: s.contacts.fullName,
      contactEmail: s.contacts.email,
      accountName: s.accounts.name,
      senderName: sender.name,
    })
    .from(s.sequenceEnrollments)
    .innerJoin(s.sequences, eq(s.sequences.id, s.sequenceEnrollments.sequenceId))
    .innerJoin(s.contacts, eq(s.contacts.id, s.sequenceEnrollments.contactId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.contacts.accountId))
    .leftJoin(sender, eq(sender.id, s.sequenceEnrollments.senderId))
    .where(and(...conds))
    .orderBy(sql`case ${s.sequenceEnrollments.status} when 'failed' then 0 when 'paused' then 1 when 'active' then 2 else 3 end`, desc(s.sequenceEnrollments.updatedAt))
    .limit(Math.min(500, f.limit ?? 200));
  // deal names only for deals the user can see (MNPI) — separate query: dealAccessWhere carries nested subqueries
  // whose params must not be embedded inside a select-list expression
  const dealIds = [...new Set(rows.map((r) => r.e.dealId).filter((x): x is string => Boolean(x)))];
  const visibleDeals = new Map(
    dealIds.length ? (await db.select({ id: s.deals.id, name: s.deals.name }).from(s.deals).where(and(inArray(s.deals.id, dealIds), dealWhere))).map((d) => [d.id, d.name]) : [],
  );
  return rows.map((r) => {
    const h = (r.e.history ?? []) as HistoryEntry[];
    const last = [...h].reverse().find((x) => x.kind !== "email_intent");
    return {
      id: r.e.id,
      sequenceId: r.e.sequenceId,
      sequenceName: r.seqName,
      stepCount: (stepsForEnrollment(r.e, { steps: r.steps, version: r.seqVersion }) ?? (r.steps as Step[])).length,
      contactId: r.e.contactId,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      accountName: r.accountName,
      dealId: r.e.dealId && visibleDeals.has(r.e.dealId) ? r.e.dealId : null,
      dealName: r.e.dealId ? (visibleDeals.get(r.e.dealId) ?? null) : null,
      senderId: r.e.senderId,
      senderName: r.senderName,
      status: r.e.status,
      currentStep: r.e.currentStep,
      nextRunAt: r.e.nextRunAt?.toISOString() ?? null,
      exitReason: r.e.exitReason,
      lastError: r.e.lastError,
      lastEventAt: last?.at ?? null,
      lastEventKind: last?.kind ?? null,
      systemPaused: r.e.status === "paused" && isSystemPause(h, r.e.lastError),
      olderVersion: isOnOlderVersion(r.e, r.seqVersion),
      sentCount: h.filter((x) => x.kind === "email" && x.ok).length,
      createdAt: r.e.createdAt.toISOString(),
      canManage: admin || r.e.senderId === user.id || r.e.enrolledBy === user.id,
    };
  });
}

/** Enrollments for a deal page: linked to the deal, or any of the deal's contacts. */
export async function dealEnrollments(user: AppUser, dealId: string) {
  const contactIds = (await db.select({ id: s.dealContacts.contactId }).from(s.dealContacts).where(eq(s.dealContacts.dealId, dealId))).map((r) => r.id);
  const [d] = await db.select({ primary: s.deals.primaryContactId }).from(s.deals).where(eq(s.deals.id, dealId));
  if (d?.primary) contactIds.push(d.primary);
  return listEnrollments(user, { dealId, contactIds: [...new Set(contactIds)], limit: 50 });
}

/** Today queue: failed / paused enrollments whose mailbox is mine. */
export async function attentionEnrollments(user: AppUser) {
  return listEnrollments(user, { attention: true, senderId: user.id, limit: 50 });
}

export async function enrollReadiness(user: AppUser) {
  const g = await gmailStatus(user.id);
  return { gmailReady: g.canSend && g.canRead };
}

/** Contacts the user can enroll (visible, not DNC, has email) — for the enroll picker search. */
export async function searchEnrollableContacts(user: AppUser, q: string, limit = 20) {
  const visible = await contactVisibilityWhere(user);
  const term = q.trim().slice(0, 100);
  const like = `%${term.replace(/[%_\\]/g, "\\$&")}%`;
  return db
    .select({ id: s.contacts.id, fullName: s.contacts.fullName, email: s.contacts.email, title: s.contacts.title, accountName: s.accounts.name, dnc: s.contacts.doNotContact })
    .from(s.contacts)
    .leftJoin(s.accounts, eq(s.accounts.id, s.contacts.accountId))
    .where(and(visible, isNull(s.contacts.deletedAt), term ? or(sql`${s.contacts.fullName} ilike ${like}`, sql`${s.contacts.email} ilike ${like}`, sql`${s.accounts.name} ilike ${like}`)! : sql`true`))
    .orderBy(sql`${s.contacts.lastContactedAt} desc nulls last`)
    .limit(limit);
}

/** Senders an admin may pick (users with Gmail connected are checked at enroll time). */
export async function senderOptions(user: AppUser) {
  if (!(await isSequenceAdmin(user))) return [{ id: user.id, name: user.name }];
  return db
    .select({ id: s.user.id, name: s.user.name })
    .from(s.user)
    .where(and(sql`${s.user.role} <> 'pending'`, or(isNull(s.user.banned), eq(s.user.banned, false))!))
    .orderBy(s.user.name)
    .limit(200);
}

export async function pipelineOptions() {
  return db.select({ key: s.pipelines.key, name: s.pipelines.name }).from(s.pipelines).where(eq(s.pipelines.active, true)).orderBy(s.pipelines.sortOrder);
}
