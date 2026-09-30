/**
 * Account merge (PRD ACC-5): fold a duplicate account into a surviving one. Takes the drizzle client as a parameter
 * (no server-only import) so the UI action and the import repair pass share it. The caller is responsible for
 * permission checks and the audit entry; this returns a `before` snapshot of every row it touched.
 *
 * Atomic (H-10): every write runs in ONE transaction (a savepoint when the caller already passes a transaction),
 * after locking both account rows in id order — a partial failure can't split children across the two accounts, and
 * concurrent A→B / B→A merges serialize instead of soft-deleting both.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as s from "../../db/schema";
import { fillEmpty } from "../import/dedupe";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PostgresJsDatabase<typeof s> | PostgresJsDatabase<any>;

/** Every table that points at an account (re-pointed on merge). */
const ACCOUNT_CHILDREN = [
  { name: "deal", table: s.deals, col: s.deals.accountId, id: s.deals.id },
  { name: "contact", table: s.contacts, col: s.contacts.accountId, id: s.contacts.id },
  { name: "activity", table: s.activities, col: s.activities.accountId, id: s.activities.id },
  { name: "task", table: s.tasks, col: s.tasks.accountId, id: s.tasks.id },
  { name: "document", table: s.documents, col: s.documents.accountId, id: s.documents.id },
  { name: "audience_metric", table: s.audienceMetrics, col: s.audienceMetrics.accountId, id: s.audienceMetrics.id },
  { name: "migration_project", table: s.migrationProjects, col: s.migrationProjects.accountId, id: s.migrationProjects.id },
  { name: "meeting", table: s.meetings, col: s.meetings.accountId, id: s.meetings.id },
  { name: "email_thread", table: s.emailThreads, col: s.emailThreads.accountId, id: s.emailThreads.id },
  { name: "transcript", table: s.transcripts, col: s.transcripts.accountId, id: s.transcripts.id },
  { name: "lead_registration", table: s.leadRegistrations, col: s.leadRegistrations.accountId, id: s.leadRegistrations.id },
  { name: "enrichment_run", table: s.enrichmentRuns, col: s.enrichmentRuns.accountId, id: s.enrichmentRuns.id },
  { name: "enriched_contact", table: s.enrichedContacts, col: s.enrichedContacts.accountId, id: s.enrichedContacts.id },
] as const;

const MERGE_FILL_FIELDS = [
  "category",
  "subcategory",
  "league",
  "team",
  "country",
  "region",
  "language",
  "ownership",
  "ticker",
  "tokenName",
  "isB2c",
  "marketCapUsd",
  "website",
  "pressPage",
  "prEmail",
  "linkedinUrl",
  "priority",
  "ownerId",
  "muu",
  "muuSource",
  "muuConfidence",
  "monthlyVisits",
  "notes",
] as const;

const LIFE_RANK: Record<string, number> = { disqualified: 0, target: 1, prospect: 2, churned: 2, customer: 3 };

export type MergeResult = {
  moved: Record<string, string[]>; // child entity → ids re-pointed
  targetBefore: Record<string, unknown>;
  sourceBefore: Record<string, unknown>;
};

type Tx = Parameters<Parameters<PostgresJsDatabase<typeof s>["transaction"]>[0]>[0];

export async function mergeAccounts(db: Db, opts: { targetId: string; sourceId: string }): Promise<MergeResult> {
  if (opts.targetId === opts.sourceId) throw new Error("Cannot merge an account into itself");
  return (db as PostgresJsDatabase<typeof s>).transaction((tx) => mergeAccountsTx(tx, opts));
}

async function mergeAccountsTx(d: Tx, opts: { targetId: string; sourceId: string }): Promise<MergeResult> {
  // Lock both rows (id order → no lock-order deadlock between concurrent merges), then re-read them live.
  const locked = await d
    .select()
    .from(s.accounts)
    .where(and(inArray(s.accounts.id, [opts.targetId, opts.sourceId]), isNull(s.accounts.deletedAt)))
    .orderBy(s.accounts.id)
    .for("update");
  const target = locked.find((a) => a.id === opts.targetId);
  const source = locked.find((a) => a.id === opts.sourceId);
  if (!target || !source) throw new Error("Account not found (or already merged)");

  const moved: Record<string, string[]> = {};
  for (const child of ACCOUNT_CHILDREN) {
    const rows = await d
      .update(child.table)
      .set({ accountId: target.id } as never)
      .where(eq(child.col, source.id))
      .returning({ id: child.id });
    if (rows.length) moved[child.name] = rows.map((r) => r.id);
  }
  // child brands of the duplicate now roll up to the survivor
  const kids = await d.update(s.accounts).set({ parentId: target.id }).where(eq(s.accounts.parentId, source.id)).returning({ id: s.accounts.id });
  if (kids.length) moved.child_account = kids.map((k) => k.id);
  Object.assign(moved, await repointPolymorphic(d, "account", source.id, target.id));
  // Lead Scout candidates that matched the duplicate now point at the survivor.
  const cands = await d
    .update(s.scoutCandidates)
    .set({ crmMatch: sql`jsonb_set(${s.scoutCandidates.crmMatch}, '{accountId}', to_jsonb(${target.id}::text))` })
    .where(sql`${s.scoutCandidates.crmMatch}->>'accountId' = ${source.id}`)
    .returning({ id: s.scoutCandidates.id });
  if (cands.length) moved.scout_candidate = cands.map((c) => c.id);

  // survivor keeps its values; empty fields are filled from the duplicate; domains are unioned
  const { patch, before } = fillEmpty(pick(target, MERGE_FILL_FIELDS), pick(source, MERGE_FILL_FIELDS));
  const alt = Array.from(new Set([...(target.altDomains ?? []), ...(source.domain && source.domain !== target.domain ? [source.domain] : []), ...(source.altDomains ?? [])])).filter((x) => x !== target.domain);
  if (alt.length !== (target.altDomains ?? []).length) {
    patch.altDomains = alt as never;
    before.altDomains = target.altDomains as never;
  }
  if ((LIFE_RANK[source.lifecycle] ?? 0) > (LIFE_RANK[target.lifecycle] ?? 0)) {
    patch.lifecycle = source.lifecycle as never;
    before.lifecycle = target.lifecycle as never;
  }
  if (source.restricted && !target.restricted) {
    patch.restricted = true as never;
    before.restricted = false as never;
  }
  const techStack = Array.from(new Set([...(target.techStack ?? []), ...(source.techStack ?? [])]));
  if (techStack.length !== (target.techStack ?? []).length) {
    patch.techStack = techStack as never;
    before.techStack = target.techStack as never;
  }
  const cf = { ...(source.customFields ?? {}), ...(target.customFields ?? {}), mergedFrom: [...(((target.customFields ?? {}) as { mergedFrom?: string[] }).mergedFrom ?? []), source.id] };
  patch.customFields = cf as never;
  before.customFields = target.customFields as never;

  // free the unique domain before copying it onto the survivor as an alt domain
  await d.update(s.accounts).set({ deletedAt: new Date(), customFields: { ...(source.customFields ?? {}), mergedInto: target.id } }).where(eq(s.accounts.id, source.id));
  await d.update(s.accounts).set(patch as never).where(eq(s.accounts.id, target.id));
  return { moved, targetBefore: before, sourceBefore: { deletedAt: null, customFields: source.customFields } };
}

/**
 * Collapse two deals of the same account & pipeline (import repair): the more advanced one survives, empty fields /
 * r100 / customFields are filled from the other, children are re-pointed and the other deal is soft-deleted.
 */
export async function mergeDeals(db: Db, opts: { keepId: string; dropId: string }) {
  return (db as PostgresJsDatabase<typeof s>).transaction((tx) => mergeDealsTx(tx, opts));
}

async function mergeDealsTx(d: Tx, opts: { keepId: string; dropId: string }) {
  const locked = await d.select().from(s.deals).where(inArray(s.deals.id, [opts.keepId, opts.dropId])).orderBy(s.deals.id).for("update");
  const keep = locked.find((x) => x.id === opts.keepId);
  const drop = locked.find((x) => x.id === opts.dropId);
  if (!keep || !drop) throw new Error("Deal not found");
  const FILL = ["ownerId", "priority", "nextStep", "nextStepDueAt", "muu", "contractValueCents", "annualizedValueCents", "nextPaymentCents", "primaryContactId", "lastActivityAt", "probabilityOverride", "overrideReason", "overrideStatus", "expectedCloseDate"] as const;
  const { patch, before } = fillEmpty(pick(keep, FILL), pick(drop, FILL));
  const r100 = { ...(drop.r100 ?? {}), ...stripEmpty(keep.r100 ?? {}) };
  if (JSON.stringify(r100) !== JSON.stringify(keep.r100 ?? {})) {
    patch.r100 = r100 as never;
    before.r100 = keep.r100 as never;
  }
  const cf = { ...(drop.customFields ?? {}), ...stripEmpty(keep.customFields ?? {}), mergedDealIds: [...(((keep.customFields ?? {}) as { mergedDealIds?: string[] }).mergedDealIds ?? []), drop.id] };
  patch.customFields = cf as never;
  before.customFields = keep.customFields as never;
  const tags = Array.from(new Set([...(keep.tags ?? []), ...(drop.tags ?? [])]));
  if (tags.length !== (keep.tags ?? []).length) {
    patch.tags = tags as never;
    before.tags = keep.tags as never;
  }
  const moved: Record<string, string[]> = {};
  for (const [name, table, col, id] of [
    ["activity", s.activities, s.activities.dealId, s.activities.id],
    ["task", s.tasks, s.tasks.dealId, s.tasks.id],
    ["document", s.documents, s.documents.dealId, s.documents.id],
    ["deal_stage_history", s.dealStageHistory, s.dealStageHistory.dealId, s.dealStageHistory.id],
    // H-10: money and conversations of the dropped deal must follow it (invoices would vanish from AR otherwise)
    ["invoice", s.invoices, s.invoices.dealId, s.invoices.id],
    ["email_thread", s.emailThreads, s.emailThreads.dealId, s.emailThreads.id],
    ["meeting", s.meetings, s.meetings.dealId, s.meetings.id],
    ["transcript", s.transcripts, s.transcripts.dealId, s.transcripts.id],
    ["proposal", s.proposals, s.proposals.dealId, s.proposals.id],
    ["commission_accrual", s.commissionAccruals, s.commissionAccruals.dealId, s.commissionAccruals.id],
    ["enrichment_run", s.enrichmentRuns, s.enrichmentRuns.dealId, s.enrichmentRuns.id],
  ] as const) {
    const rows = await d.update(table).set({ dealId: keep.id } as never).where(eq(col, drop.id)).returning({ id });
    if (rows.length) moved[name] = rows.map((r) => r.id);
  }
  // migration_projects is unique per deal: move the dropped deal's project only when the survivor has none.
  const [keepProject] = await d.select({ id: s.migrationProjects.id }).from(s.migrationProjects).where(eq(s.migrationProjects.dealId, keep.id));
  if (!keepProject) {
    const rows = await d.update(s.migrationProjects).set({ dealId: keep.id }).where(eq(s.migrationProjects.dealId, drop.id)).returning({ id: s.migrationProjects.id });
    if (rows.length) moved.migration_project = rows.map((r) => r.id);
  }
  Object.assign(moved, await repointPolymorphic(d, "deal", drop.id, keep.id));
  // stakeholders / splits: copy the ones the survivor doesn't have
  // sequential: one transaction = one connection
  const keepContacts = await d.select().from(s.dealContacts).where(eq(s.dealContacts.dealId, keep.id));
  const dropContacts = await d.select().from(s.dealContacts).where(eq(s.dealContacts.dealId, drop.id));
  const keepSplits = await d.select().from(s.dealSplits).where(eq(s.dealSplits.dealId, keep.id));
  const dropSplits = await d.select().from(s.dealSplits).where(eq(s.dealSplits.dealId, drop.id));
  const haveC = new Set(keepContacts.map((c) => c.contactId));
  const addC = dropContacts.filter((c) => !haveC.has(c.contactId)).map((c) => ({ dealId: keep.id, contactId: c.contactId, role: c.role }));
  if (addC.length) await d.insert(s.dealContacts).values(addC).onConflictDoNothing();
  if (!keepSplits.length && dropSplits.length) await d.insert(s.dealSplits).values(dropSplits.map((sp) => ({ ...sp, dealId: keep.id }))).onConflictDoNothing();
  await d.update(s.deals).set(patch as never).where(eq(s.deals.id, keep.id));
  await d.update(s.deals).set({ deletedAt: new Date(), customFields: { ...(drop.customFields ?? {}), mergedInto: keep.id } }).where(eq(s.deals.id, drop.id));
  return { keepBefore: before, dropBefore: { deletedAt: null, customFields: drop.customFields }, moved, addedContacts: addC.map((c) => c.contactId), copiedSplits: !keepSplits.length ? dropSplits.map((sp) => sp.userId) : [] };
}

/**
 * Re-point the polymorphic (entity, entity_id) references from `fromId` to `toId`: restricted-access grants (merged,
 * so the survivor keeps every grant when it becomes restricted), comments, approvals, and alerts. Open alerts that
 * would collide with an open alert on the survivor (same rule + recipient) are resolved instead of moved.
 */
async function repointPolymorphic(d: Tx, entity: "account" | "deal", fromId: string, toId: string): Promise<Record<string, string[]>> {
  const moved: Record<string, string[]> = {};
  const granted = await d.execute(sql`
    insert into ${s.restrictedAccess} (entity, entity_id, user_id, granted_by, created_at)
    select entity, ${toId}::uuid, user_id, granted_by, created_at from ${s.restrictedAccess} where entity = ${entity} and entity_id = ${fromId}::uuid
    on conflict do nothing returning user_id`);
  const grantedIds = (granted as unknown as { user_id: string }[]).map((r) => r.user_id);
  await d.delete(s.restrictedAccess).where(and(eq(s.restrictedAccess.entity, entity), eq(s.restrictedAccess.entityId, fromId)));
  if (grantedIds.length) moved.restricted_access = grantedIds;

  const comments = await d.update(s.comments).set({ entityId: toId }).where(and(eq(s.comments.entity, entity), eq(s.comments.entityId, fromId))).returning({ id: s.comments.id });
  if (comments.length) moved.comment = comments.map((c) => c.id);

  const approvals = await d.update(s.approvals).set({ entityId: toId }).where(and(eq(s.approvals.entity, entity), eq(s.approvals.entityId, fromId))).returning({ id: s.approvals.id });
  if (approvals.length) moved.approval = approvals.map((a) => a.id);

  const OPEN = ["open", "acknowledged", "snoozed", "escalated"] as const;
  await d
    .update(s.alerts)
    .set({ state: "resolved", resolvedAt: new Date(), resolution: "Merged into another record" })
    .where(
      and(
        eq(s.alerts.entity, entity),
        eq(s.alerts.entityId, fromId),
        inArray(s.alerts.state, [...OPEN]),
        sql`exists (select 1 from ${s.alerts} o where o.rule_code = ${s.alerts.ruleCode} and o.entity = ${entity} and o.entity_id = ${toId}
          and o.recipient_id is not distinct from ${s.alerts.recipientId} and o.state in ('open','acknowledged','snoozed','escalated'))`,
      ),
    );
  const alerts = await d.update(s.alerts).set({ entityId: toId }).where(and(eq(s.alerts.entity, entity), eq(s.alerts.entityId, fromId))).returning({ id: s.alerts.id });
  if (alerts.length) moved.alert = alerts.map((a) => a.id);
  return moved;
}

/** Undo helper for mergeAccounts' child moves (used by rollback of repair batches). */
export async function repointChildren(db: Db, entity: string, ids: string[], accountId: string) {
  const d = db as PostgresJsDatabase<typeof s>;
  const child = ACCOUNT_CHILDREN.find((c) => c.name === entity);
  if (!child || !ids.length) return;
  await d.update(child.table).set({ accountId } as never).where(inArray(child.id, ids));
}

function pick<T extends Record<string, unknown>>(row: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = row[k];
  return out;
}

function stripEmpty(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && v.length === 0)));
}
