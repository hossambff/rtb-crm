/**
 * Account merge (PRD ACC-5): fold a duplicate account into a surviving one. Takes the drizzle client as a parameter
 * (no server-only import) so the UI action and the import repair pass share it. The caller is responsible for
 * permission checks and the audit entry; this returns a `before` snapshot of every row it touched.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
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

export async function mergeAccounts(db: Db, opts: { targetId: string; sourceId: string }): Promise<MergeResult> {
  const d = db as PostgresJsDatabase<typeof s>;
  if (opts.targetId === opts.sourceId) throw new Error("Cannot merge an account into itself");
  const [target] = await d.select().from(s.accounts).where(and(eq(s.accounts.id, opts.targetId), isNull(s.accounts.deletedAt)));
  const [source] = await d.select().from(s.accounts).where(and(eq(s.accounts.id, opts.sourceId), isNull(s.accounts.deletedAt)));
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
  const d = db as PostgresJsDatabase<typeof s>;
  const [keep] = await d.select().from(s.deals).where(eq(s.deals.id, opts.keepId));
  const [drop] = await d.select().from(s.deals).where(eq(s.deals.id, opts.dropId));
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
  ] as const) {
    const rows = await d.update(table).set({ dealId: keep.id } as never).where(eq(col, drop.id)).returning({ id });
    if (rows.length) moved[name] = rows.map((r) => r.id);
  }
  // stakeholders / splits: copy the ones the survivor doesn't have
  const [keepContacts, dropContacts, keepSplits, dropSplits] = await Promise.all([
    d.select().from(s.dealContacts).where(eq(s.dealContacts.dealId, keep.id)),
    d.select().from(s.dealContacts).where(eq(s.dealContacts.dealId, drop.id)),
    d.select().from(s.dealSplits).where(eq(s.dealSplits.dealId, keep.id)),
    d.select().from(s.dealSplits).where(eq(s.dealSplits.dealId, drop.id)),
  ]);
  const haveC = new Set(keepContacts.map((c) => c.contactId));
  const addC = dropContacts.filter((c) => !haveC.has(c.contactId)).map((c) => ({ dealId: keep.id, contactId: c.contactId, role: c.role }));
  if (addC.length) await d.insert(s.dealContacts).values(addC).onConflictDoNothing();
  if (!keepSplits.length && dropSplits.length) await d.insert(s.dealSplits).values(dropSplits.map((sp) => ({ ...sp, dealId: keep.id }))).onConflictDoNothing();
  await d.update(s.deals).set(patch as never).where(eq(s.deals.id, keep.id));
  await d.update(s.deals).set({ deletedAt: new Date(), customFields: { ...(drop.customFields ?? {}), mergedInto: keep.id } }).where(eq(s.deals.id, drop.id));
  return { keepBefore: before, dropBefore: { deletedAt: null, customFields: drop.customFields }, moved, addedContacts: addC.map((c) => c.contactId), copiedSplits: !keepSplits.length ? dropSplits.map((sp) => sp.userId) : [] };
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
