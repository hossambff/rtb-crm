/**
 * ImportEngine — commits NormalizedRecords to the database with dedupe + merge policy + row-level history
 * (PRD IMP-5, IMP-6). Shared by the import wizard (route handlers) and scripts/import-spreadsheets.ts, so it takes
 * the drizzle client as a parameter and has no server-only imports.
 *
 * Strategy (fast on a remote DB): load identity indexes once, resolve every record in memory (ids generated
 * client-side), then flush bulk inserts in FK order + per-row updates. Re-running the same data is a no-op
 * (idempotent): accounts/deals/contacts are upserted by identity, activities and metrics by content key.
 *
 * Merge policy: one account per normalized domain (fallback: normalized name); one deal per account per pipeline;
 * keep the most advanced stage; everything else "update empty fields only". Every created/updated row is logged in
 * import_records (updated rows keep a `before` snapshot) so a batch can be rolled back.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as s from "../../db/schema";
import { inferSeniority, isValidEmail, nameFromEmail, splitName } from "../contacts/seniority";
import { accountKey, fillEmpty, isEmptyValue, normalizeName } from "./dedupe";
import type { NormalizedRecord } from "./normalize";
import { KNOWN_REPS, equalSplits, isPlaceholderEmail, matchUserByFirstName, placeholderEmail, placeholderName } from "./owners";
import { stageRank, type StageLite } from "./status";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ImportDb = PostgresJsDatabase<typeof s> | PostgresJsDatabase<any>;

type Row = Record<string, unknown>;
type Entity = "account" | "contact" | "deal" | "activity" | "audience_metric" | "deal_split" | "deal_contact" | "deal_stage_history" | "migration_project" | "user";

type State = { id: string; row: Row; pending: boolean };

export type BatchStats = {
  rows: number;
  skipped: number;
  accountsCreated: number;
  accountsUpdated: number;
  dealsCreated: number;
  dealsUpdated: number;
  contactsCreated: number;
  contactsUpdated: number;
  activitiesCreated: number;
  metricsCreated: number;
  splitsCreated: number;
  duplicatesMerged: number;
  migrationsCreated: number;
  placeholdersCreated: number;
  unmappedStatuses: number;
  warnings: number;
};

export type RecordOutcome = {
  rowNumber: number;
  account: "create" | "update" | "merge" | "unchanged";
  accountName: string;
  deal: "create" | "update" | "merge" | "unchanged" | "none";
  stageKey: string | null;
  owners: string[];
  contacts: number;
};

export type BatchMeta = {
  fileName: string;
  sheetName?: string | null;
  target: string;
  pipelineKey?: string | null;
  mapping?: Record<string, string>;
};

const DEAL_FILL_FIELDS = [
  "ownerId",
  "priority",
  "nextStep",
  "nextStepDueAt",
  "muu",
  "contractValueCents",
  "annualizedValueCents",
  "nextPaymentCents",
  "primaryContactId",
  "lastActivityAt",
  "source",
] as const;

const ACCOUNT_FILL_FIELDS = [
  "domain",
  "type",
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
  "notes",
  "source",
] as const;

const CONTACT_FILL_FIELDS = ["title", "seniority", "email", "phone", "linkedinUrl", "relationshipOwnerId", "ownerId", "lastContactedAt", "firstName", "lastName", "accountId"] as const;

const LIFECYCLE_RANK: Record<string, number> = { disqualified: 0, target: 1, prospect: 2, churned: 2, customer: 3 };

/** FNV-1a 32-bit → hex (content keys for idempotent activities). */
export function hashKey(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const COMPANY_TYPES = new Set(["public_company", "token_project"]);
const MEDIA_TYPES = new Set(["publisher", "media_group"]);
/** Name-only matches must stay on the same side of company (R100/ADS) vs media (NET/ENT/SPT). */
export function typesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true;
  return !((COMPANY_TYPES.has(a) && MEDIA_TYPES.has(b)) || (MEDIA_TYPES.has(a) && COMPANY_TYPES.has(b)));
}

/** crowdstrike.com ↔ “CrowdStrike”: the domain label is the name, so type labels don't matter. */
export function domainIsName(domain: string | null | undefined, name: string): boolean {
  return !!domain && normalizeName(domain.split(".")[0]) === normalizeName(name);
}

/** Transient pooler hiccups (ECONNRESET / timeouts) on big reads: retry once. */
async function retryOnce<T>(run: () => PromiseLike<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const code = ((e as { cause?: { code?: string } }).cause ?? (e as { code?: string })).code;
    if (code !== "ECONNRESET" && code !== "ETIMEDOUT" && code !== "CONNECTION_CLOSED") throw e;
    return await run();
  }
}

/** Run lazy query builders one after another (gentler on the transaction pooler than Promise.all). */
async function inSequence<T extends readonly PromiseLike<unknown>[]>(queries: [...T]): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const out: unknown[] = [];
  for (const q of queries) out.push(await retryOnce(() => q));
  return out as { [K in keyof T]: Awaited<T[K]> };
}

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

function pick(row: Row, keys: readonly string[]): Row {
  const out: Row = {};
  for (const k of keys) if (k in row) out[k] = row[k];
  return out;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++]!;
        await fn(item);
      }
    }),
  );
}

export function emptyStats(): BatchStats {
  return {
    rows: 0,
    skipped: 0,
    accountsCreated: 0,
    accountsUpdated: 0,
    dealsCreated: 0,
    dealsUpdated: 0,
    contactsCreated: 0,
    contactsUpdated: 0,
    activitiesCreated: 0,
    metricsCreated: 0,
    splitsCreated: 0,
    duplicatesMerged: 0,
    migrationsCreated: 0,
    placeholdersCreated: 0,
    unmappedStatuses: 0,
    warnings: 0,
  };
}

export class ImportEngine {
  private db: ImportDb;
  readonly actorId: string | null;
  readonly importDate: Date;
  private loaded = false;

  // reference data
  pipelines = new Map<string, { id: string; key: string; stages: (StageLite & { id: string })[] }>();
  users: { id: string; name: string; email: string }[] = [];

  // identity indexes
  private accById = new Map<string, State>();
  private accByDomain = new Map<string, State>();
  private accByName = new Map<string, State[]>();
  private dealByKey = new Map<string, State>(); // accountId|pipelineId
  private dealsByAccount = new Map<string, Set<string>>();
  private dealHasSplits = new Set<string>();
  private dealContactPairs = new Set<string>();
  private conByEmail = new Map<string, State>();
  private conByAccName = new Map<string, State>();
  private activityKeys = new Set<string>();
  private metricKeys = new Set<string>();
  private migrationAccounts = new Set<string>();

  // pending writes for the current batch
  private batch: { id: string; meta: BatchMeta } | null = null;
  private ins: Record<"users" | "accounts" | "contacts" | "deals" | "splits" | "dealContacts" | "history" | "activities" | "metrics" | "migrations", Row[]> = {
    users: [],
    accounts: [],
    contacts: [],
    deals: [],
    splits: [],
    dealContacts: [],
    history: [],
    activities: [],
    metrics: [],
    migrations: [],
  };
  private upd = new Map<string, { table: "accounts" | "deals" | "contacts"; id: string; patch: Row; before: Row }>();
  private recs: { entity: Entity; entityId: string; action: "created" | "updated" | "merged"; before: unknown }[] = [];
  private updatedRecs = new Map<string, { entity: Entity; entityId: string; action: "updated"; before: unknown }>();
  stats: BatchStats = emptyStats();
  unmapped = new Map<string, number>();
  outcomes: RecordOutcome[] = [];

  constructor(db: ImportDb, opts: { actorId: string | null; importDate?: Date }) {
    this.db = db;
    this.actorId = opts.actorId;
    this.importDate = opts.importDate ?? new Date();
  }

  private get d() {
    return this.db as PostgresJsDatabase<typeof s>;
  }

  /* ───────────── loading ───────────── */

  async load() {
    if (this.loaded) return;
    const db = this.d;
    const [pipes, stages, users, accounts, deals, splits, dcs, contacts, acts, metrics, migs] = await inSequence([
      db.select({ id: s.pipelines.id, key: s.pipelines.key }).from(s.pipelines),
      db.select().from(s.stages),
      db.select({ id: s.user.id, name: s.user.name, email: s.user.email }).from(s.user),
      db
        .select({
          id: s.accounts.id,
          name: s.accounts.name,
          domain: s.accounts.domain,
          altDomains: s.accounts.altDomains,
          type: s.accounts.type,
          category: s.accounts.category,
          subcategory: s.accounts.subcategory,
          league: s.accounts.league,
          team: s.accounts.team,
          country: s.accounts.country,
          region: s.accounts.region,
          language: s.accounts.language,
          ownership: s.accounts.ownership,
          ticker: s.accounts.ticker,
          tokenName: s.accounts.tokenName,
          isB2c: s.accounts.isB2c,
          marketCapUsd: s.accounts.marketCapUsd,
          website: s.accounts.website,
          pressPage: s.accounts.pressPage,
          prEmail: s.accounts.prEmail,
          linkedinUrl: s.accounts.linkedinUrl,
          lifecycle: s.accounts.lifecycle,
          priority: s.accounts.priority,
          ownerId: s.accounts.ownerId,
          muu: s.accounts.muu,
          muuSource: s.accounts.muuSource,
          muuConfidence: s.accounts.muuConfidence,
          monthlyVisits: s.accounts.monthlyVisits,
          restricted: s.accounts.restricted,
          notes: s.accounts.notes,
          customFields: s.accounts.customFields,
          source: s.accounts.source,
        })
        .from(s.accounts)
        .where(isNull(s.accounts.deletedAt)),
      db
        .select({
          id: s.deals.id,
          accountId: s.deals.accountId,
          pipelineId: s.deals.pipelineId,
          stageId: s.deals.stageId,
          status: s.deals.status,
          ownerId: s.deals.ownerId,
          priority: s.deals.priority,
          nextStep: s.deals.nextStep,
          nextStepDueAt: s.deals.nextStepDueAt,
          muu: s.deals.muu,
          probabilityOverride: s.deals.probabilityOverride,
          overrideReason: s.deals.overrideReason,
          overrideStatus: s.deals.overrideStatus,
          contractValueCents: s.deals.contractValueCents,
          annualizedValueCents: s.deals.annualizedValueCents,
          nextPaymentCents: s.deals.nextPaymentCents,
          primaryContactId: s.deals.primaryContactId,
          lastActivityAt: s.deals.lastActivityAt,
          r100: s.deals.r100,
          customFields: s.deals.customFields,
          tags: s.deals.tags,
          restricted: s.deals.restricted,
          source: s.deals.source,
          updatedAt: s.deals.updatedAt,
        })
        .from(s.deals)
        .where(isNull(s.deals.deletedAt)),
      db.select({ dealId: s.dealSplits.dealId }).from(s.dealSplits),
      db.select({ dealId: s.dealContacts.dealId, contactId: s.dealContacts.contactId }).from(s.dealContacts),
      db
        .select({
          id: s.contacts.id,
          accountId: s.contacts.accountId,
          fullName: s.contacts.fullName,
          firstName: s.contacts.firstName,
          lastName: s.contacts.lastName,
          title: s.contacts.title,
          seniority: s.contacts.seniority,
          email: s.contacts.email,
          altEmails: s.contacts.altEmails,
          phone: s.contacts.phone,
          linkedinUrl: s.contacts.linkedinUrl,
          relationshipOwnerId: s.contacts.relationshipOwnerId,
          ownerId: s.contacts.ownerId,
          lastContactedAt: s.contacts.lastContactedAt,
        })
        .from(s.contacts)
        .where(isNull(s.contacts.deletedAt)),
      db
        .select({ key: sql<string>`${s.activities.metadata}->>'importKey'` })
        .from(s.activities)
        .where(eq(s.activities.source, "import")),
      db
        .select({ accountId: s.audienceMetrics.accountId, metric: s.audienceMetrics.metric, value: s.audienceMetrics.value, source: s.audienceMetrics.source })
        .from(s.audienceMetrics),
      db.select({ accountId: s.migrationProjects.accountId }).from(s.migrationProjects),
    ]);

    for (const p of pipes) {
      const st = stages
        .filter((x) => x.pipelineId === p.id)
        .map((x) => ({ id: x.id, key: x.key, name: x.name, sortOrder: x.sortOrder, probability: x.probability, category: x.category, importAliases: x.importAliases }))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      this.pipelines.set(p.key, { id: p.id, key: p.key, stages: st });
    }
    this.users = users;
    for (const a of accounts) this.indexAccount({ id: a.id, row: { ...a }, pending: false });
    const byUpdated = [...deals].sort((a, b) => (a.status === "open" ? 1 : 0) - (b.status === "open" ? 1 : 0) || a.updatedAt.getTime() - b.updatedAt.getTime());
    for (const dl of byUpdated) {
      if (!dl.accountId) continue;
      const { updatedAt: _u, ...row } = dl;
      void _u;
      this.indexDeal({ id: dl.id, row, pending: false });
    }
    for (const sp of splits) this.dealHasSplits.add(sp.dealId);
    for (const dc of dcs) this.dealContactPairs.add(`${dc.dealId}|${dc.contactId}`);
    for (const c of contacts) this.indexContact({ id: c.id, row: { ...c }, pending: false });
    for (const a of acts) if (a.key) this.activityKeys.add(a.key);
    for (const m of metrics) this.metricKeys.add(`${m.accountId}|${m.metric}|${m.value}|${m.source}`);
    for (const m of migs) if (m.accountId) this.migrationAccounts.add(m.accountId);
    this.loaded = true;
  }

  private indexAccount(st: State) {
    this.accById.set(st.id, st);
    const d = st.row.domain as string | null;
    if (d) this.accByDomain.set(d, st);
    for (const alt of (st.row.altDomains as string[] | undefined) ?? []) if (!this.accByDomain.has(alt)) this.accByDomain.set(alt, st);
    const n = normalizeName(st.row.name as string);
    if (n) this.accByName.set(n, [...(this.accByName.get(n) ?? []), st]);
  }

  private indexDeal(st: State) {
    const key = `${st.row.accountId}|${st.row.pipelineId}`;
    this.dealByKey.set(key, st);
    const set = this.dealsByAccount.get(st.row.accountId as string) ?? new Set<string>();
    set.add(st.id);
    this.dealsByAccount.set(st.row.accountId as string, set);
  }

  private indexContact(st: State) {
    const e = (st.row.email as string | null)?.toLowerCase();
    if (e) this.conByEmail.set(e, st);
    for (const alt of (st.row.altEmails as string[] | undefined) ?? []) if (!this.conByEmail.has(alt.toLowerCase())) this.conByEmail.set(alt.toLowerCase(), st);
    if (st.row.accountId) this.conByAccName.set(`${st.row.accountId}|${normalizeName(st.row.fullName as string)}`, st);
  }

  /* ───────────── users ───────────── */

  /** Resolve a rep first name → user id (existing user by first name, else a placeholder user). */
  resolveUser(first: string | null | undefined): string | null {
    if (!first) return null;
    const hit = matchUserByFirstName(first, this.users);
    if (hit) return hit.id;
    const known = KNOWN_REPS[first];
    const id = uuid();
    const email = placeholderEmail(first);
    const row = {
      id,
      name: placeholderName(first),
      email,
      emailVerified: false,
      role: "viewer",
      banned: true,
      banReason: "Placeholder for a spreadsheet rep — claim it for the real user in Admin › Users.",
      title: known?.title ?? null,
      employmentType: known?.employmentType ?? null,
    };
    this.ins.users.push(row);
    this.users.push({ id, name: row.name, email });
    this.recs.push({ entity: "user", entityId: id, action: "created", before: null });
    this.stats.placeholdersCreated++;
    return id;
  }

  /* ───────────── batches ───────────── */

  beginBatch(meta: BatchMeta): string {
    if (this.batch) throw new Error("A batch is already open — flush() it first");
    this.batch = { id: uuid(), meta };
    this.stats = emptyStats();
    this.unmapped = new Map();
    this.outcomes = [];
    return this.batch.id;
  }

  get batchId() {
    return this.batch?.id ?? null;
  }

  private queueUpdate(table: "accounts" | "deals" | "contacts", st: State, patch: Row, before: Row) {
    if (Object.keys(patch).length === 0) return false;
    Object.assign(st.row, patch);
    if (st.pending) return true; // created in this batch — the insert row is st.row itself
    const key = `${table}:${st.id}`;
    const prev = this.upd.get(key);
    if (prev) {
      Object.assign(prev.patch, patch);
      for (const [k, v] of Object.entries(before)) if (!(k in prev.before)) prev.before[k] = v;
    } else this.upd.set(key, { table, id: st.id, patch: { ...patch }, before: { ...before } });
    return true;
  }

  /* ───────────── records ───────────── */

  /**
   * Identity lookup: normalized domain first; otherwise normalized name — but a name match never crosses the
   * company/publisher divide ("Root" the insurer ≠ "The Root" the publisher; Polygon the chain ≠ polygon.com),
   * and a domained record only adopts a same-name account that has no domain yet.
   */
  findAccount(rec: { name: string; domain: string | null; type?: string | null }): State | null {
    if (rec.domain) {
      const byD = this.accByDomain.get(rec.domain);
      if (byD) return byD;
    }
    const exact = rec.name.trim().toLowerCase();
    const score = (c: State) =>
      (String(c.row.name).trim().toLowerCase() === exact ? 8 : 0) + // "Solana" beats "Solana Company"
      (typesCompatible(rec.type, c.row.type as string | undefined) ? 4 : 0) + // same side (company vs media) first
      (rec.type === "advertiser" && COMPANY_TYPES.has(c.row.type as string) ? 2 : 0) + // sponsors are usually R100-side companies
      (c.row.domain ? 1 : 0);
    const cands = (this.accByName.get(normalizeName(rec.name)) ?? [])
      .filter((c) => typesCompatible(rec.type, c.row.type as string | undefined) || (!rec.domain && domainIsName(c.row.domain as string | null, rec.name)))
      .sort((a, b) => score(b) - score(a));
    if (rec.domain) return cands.find((c) => !c.row.domain) ?? null;
    return cands[0] ?? null;
  }

  stagesFor(pipelineKey: string) {
    return this.pipelines.get(pipelineKey)?.stages ?? [];
  }

  apply(rec: NormalizedRecord): RecordOutcome | null {
    if (!this.batch) throw new Error("beginBatch() first");
    this.stats.rows++;
    this.stats.warnings += rec.issues.filter((i) => i.level === "warning").length;
    if (rec.statusNote?.kind === "unmapped") {
      this.stats.unmappedStatuses++;
      this.unmapped.set(rec.statusNote.raw, (this.unmapped.get(rec.statusNote.raw) ?? 0) + 1);
    }
    if (!accountKey(rec.account)) {
      this.stats.skipped++;
      return null;
    }
    const ownerIds = Array.from(new Set((rec.deal?.owners ?? []).map((o) => this.resolveUser(o)).filter((x): x is string => !!x)));
    const primaryOwner = ownerIds[0] ?? null;

    /* account */
    let accountAction: RecordOutcome["account"] = "unchanged";
    let acc = this.findAccount(rec.account);
    const incoming: Row = {};
    for (const k of ACCOUNT_FILL_FIELDS) {
      const v = (rec.account as Row)[k];
      if (v !== undefined) incoming[k] = v;
    }
    if (primaryOwner) incoming.ownerId = primaryOwner;
    incoming.source = rec.source;
    if (!acc) {
      const id = uuid();
      const row: Row = {
        id,
        name: rec.account.name,
        ...Object.fromEntries(Object.entries(incoming).filter(([, v]) => v != null)),
        altDomains: rec.account.altDomains ?? [],
        lifecycle: rec.account.lifecycle ?? "target",
        restricted: rec.account.restricted ?? false,
        customFields: rec.account.customFields ?? {},
        techStack: [],
        createdBy: this.actorId,
      };
      acc = { id, row, pending: true };
      this.indexAccount(acc);
      this.ins.accounts.push(row);
      this.recs.push({ entity: "account", entityId: id, action: "created", before: null });
      this.stats.accountsCreated++;
      accountAction = "create";
    } else {
      const { patch, before } = fillEmpty(acc.row, incoming);
      if (typeof patch.domain === "string") {
        // matched by name: only claim the domain if no other account owns it (unique index)
        const owner = this.accByDomain.get(patch.domain);
        if (owner && owner !== acc) {
          delete patch.domain;
          delete before.domain;
        } else this.accByDomain.set(patch.domain, acc);
      }
      if (rec.account.restricted && !acc.row.restricted) {
        patch.restricted = true;
        before.restricted = false;
      }
      const cf = { ...((acc.row.customFields as Row) ?? {}) };
      let cfChanged = false;
      for (const [k, v] of Object.entries(rec.account.customFields ?? {})) if (isEmptyValue(cf[k]) && !isEmptyValue(v)) {
            cf[k] = v;
            cfChanged = true;
          }
      if (cfChanged) {
        before.customFields = acc.row.customFields;
        patch.customFields = cf;
      }
      if (rec.account.lifecycle === "disqualified" && acc.row.lifecycle === "target" && !(this.dealsByAccount.get(acc.id)?.size ?? 0)) {
        patch.lifecycle = "disqualified";
        before.lifecycle = acc.row.lifecycle;
      }
      const wasPending = acc.pending;
      if (this.queueUpdate("accounts", acc, patch, before)) {
        if (!wasPending) {
          this.stats.accountsUpdated++;
          this.markUpdated("account", acc.id, before);
          accountAction = "update";
        }
      }
      if (wasPending) {
        accountAction = "merge";
        this.stats.duplicatesMerged++;
      }
    }

    /* audience metrics */
    const period = this.importDate.toISOString().slice(0, 7);
    for (const m of rec.audience) {
      const key = `${acc.id}|${m.metric}|${m.value}|${m.source}`;
      if (this.metricKeys.has(key)) continue;
      this.metricKeys.add(key);
      const id = uuid();
      this.ins.metrics.push({
        id,
        accountId: acc.id,
        metric: m.metric,
        value: m.value,
        rawValue: m.rawValue,
        derivedMuu: m.derivedMuu ?? null,
        factorUsed: m.factorUsed ?? null,
        period,
        source: m.source,
        confidence: m.confidence,
        enteredBy: this.actorId,
      });
      this.recs.push({ entity: "audience_metric", entityId: id, action: "created", before: null });
      this.stats.metricsCreated++;
      const audPatch: Row = {};
      if (m.metric === "muu") Object.assign(audPatch, { muu: m.value, muuSource: m.source, muuConfidence: m.confidence });
      else {
        audPatch.monthlyVisits = m.value;
        if (m.derivedMuu) Object.assign(audPatch, { muu: m.derivedMuu, muuSource: `${m.source} ÷ ${m.factorUsed ?? 2.5}`, muuConfidence: "estimate" });
      }
      const { patch, before } = fillEmpty(acc.row, audPatch);
      if (patch.muu == null) {
        delete patch.muuSource;
        delete patch.muuConfidence;
        delete before.muuSource;
        delete before.muuConfidence;
      }
      const wasPending = acc.pending;
      if (this.queueUpdate("accounts", acc, patch, before) && !wasPending) this.markUpdated("account", acc.id, before);
    }

    /* contacts */
    const contactIds: string[] = [];
    for (const c of rec.contacts) {
      const email = c.email && isValidEmail(c.email) ? c.email.toLowerCase() : null;
      const fullName = c.fullName?.trim() || (email ? nameFromEmail(email) : null);
      if (!fullName) continue;
      let con = email ? this.conByEmail.get(email) : undefined;
      con = con ?? this.conByAccName.get(`${acc.id}|${normalizeName(fullName)}`);
      const { firstName, lastName } = splitName(fullName);
      const incomingC: Row = {
        accountId: acc.id,
        title: c.title ?? null,
        seniority: inferSeniority(c.title),
        email,
        phone: c.phone ?? null,
        linkedinUrl: c.linkedinUrl ?? null,
        relationshipOwnerId: c.relationshipOwner ? this.resolveUser(c.relationshipOwner) : null,
        ownerId: primaryOwner,
        lastContactedAt: rec.deal?.lastContactedAt ?? null,
        firstName,
        lastName,
      };
      if (!con) {
        const id = uuid();
        const row: Row = {
          id,
          fullName,
          ...Object.fromEntries(Object.entries(incomingC).filter(([, v]) => v != null)),
          altEmails: (c.altEmails ?? []).map((e) => e.toLowerCase()).filter((e) => e !== email),
          origin: "import",
          status: "active",
          notes: c.notes ?? null,
          customFields: {},
        };
        con = { id, row, pending: true };
        this.indexContact(con);
        this.ins.contacts.push(row);
        this.recs.push({ entity: "contact", entityId: id, action: "created", before: null });
        this.stats.contactsCreated++;
      } else {
        const { patch, before } = fillEmpty(pick(con.row, CONTACT_FILL_FIELDS), incomingC);
        const wasPending = con.pending;
        if (this.queueUpdate("contacts", con, patch, before) && !wasPending) {
          this.stats.contactsUpdated++;
          this.markUpdated("contact", con.id, before);
        }
      }
      if (!contactIds.includes(con.id)) contactIds.push(con.id);
    }

    /* deal */
    let dealAction: RecordOutcome["deal"] = "none";
    let dealId: string | null = null;
    let stageKey: string | null = null;
    if (rec.deal) {
      const pipe = this.pipelines.get(rec.deal.pipelineKey);
      if (!pipe || pipe.stages.length === 0) {
        rec.issues.push({ level: "error", field: "deal", message: `Unknown pipeline ${rec.deal.pipelineKey}` });
      } else {
        const openStages = pipe.stages.filter((x) => x.category === "open");
        let stage = rec.deal.stageKey ? pipe.stages.find((x) => x.key === rec.deal!.stageKey) : undefined;
        if (!stage) stage = openStages[0] ?? pipe.stages[0]!;
        stageKey = stage.key;
        const key = `${acc.id}|${pipe.id}`;
        let dl = this.dealByKey.get(key);
        const due = new Date(this.importDate.getTime() + 7 * 86400000);
        const cf: Row = { ...(rec.deal.customFields ?? {}) };
        if (rec.deal.statusRaw) cf.importedStatus = rec.deal.statusRaw;
        const stageExtras = (st: StageLite): Row => ({
          status: st.category,
          wonAt: st.category === "won" ? this.importDate : null,
          lostAt: st.category === "lost" ? this.importDate : null,
          lostReason: st.category === "lost" ? rec.deal!.lostReason ?? `Imported as “${rec.deal!.statusRaw ?? st.name}”` : null,
          holdReason: st.category === "hold" ? `Imported as “${rec.deal!.statusRaw ?? st.name}”` : null,
        });
        const incomingD: Row = {
          ownerId: primaryOwner,
          priority: rec.deal.priority ?? null,
          nextStep: rec.deal.nextStep ?? null,
          muu: rec.deal.muu ?? null,
          contractValueCents: rec.deal.contractValueCents ?? null,
          annualizedValueCents: rec.deal.annualizedValueCents ?? null,
          nextPaymentCents: rec.deal.nextPaymentCents ?? null,
          primaryContactId: contactIds[0] ?? null,
          lastActivityAt: rec.deal.lastContactedAt ?? null,
          source: rec.source,
        };
        if (!dl) {
          const id = uuid();
          const row: Row = {
            id,
            name: rec.deal.name ?? rec.account.name,
            pipelineId: pipe.id,
            stageId: stage.id,
            accountId: acc.id,
            ...Object.fromEntries(Object.entries(incomingD).filter(([, v]) => v != null)),
            ...stageExtras(stage),
            nextStep: rec.deal.nextStep ?? "Review imported deal",
            nextStepDueAt: due,
            stageEnteredAt: this.importDate,
            probabilityOverride: rec.deal.probabilityOverride ?? null,
            overrideReason: rec.deal.probabilityOverride != null ? rec.deal.overrideReason ?? "Imported" : null,
            overrideStatus: rec.deal.probabilityOverride != null ? rec.deal.overrideStatus ?? "pending" : null,
            r100: rec.deal.r100 ?? {},
            restricted: rec.deal.restricted ?? rec.account.restricted ?? false,
            tags: Array.from(new Set(["imported", ...(rec.deal.tags ?? [])])),
            customFields: cf,
            createdBy: this.actorId,
          };
          dl = { id, row, pending: true };
          this.indexDeal(dl);
          this.ins.deals.push(row);
          this.recs.push({ entity: "deal", entityId: id, action: "created", before: null });
          this.stats.dealsCreated++;
          dealAction = "create";
          const hid = uuid();
          this.ins.history.push({ id: hid, dealId: id, fromStageId: null, toStageId: stage.id, changedBy: this.actorId, reason: `Imported from ${rec.source}`, changedAt: this.importDate });
        } else {
          const wasPending = dl.pending;
          const current = dl.row;
          const curStage = pipe.stages.find((x) => x.id === current.stageId);
          const patch: Row = {};
          const before: Row = {};
          if (curStage && stageRank(stage) > stageRank(curStage)) {
            Object.assign(before, pick(current, ["stageId", "status", "stageEnteredAt", "wonAt", "lostAt", "lostReason", "holdReason"]));
            Object.assign(patch, { stageId: stage.id, stageEnteredAt: this.importDate, ...stageExtras(stage) });
            if (!wasPending) {
              const hid = uuid();
              this.ins.history.push({ id: hid, dealId: dl.id, fromStageId: curStage.id, toStageId: stage.id, changedBy: this.actorId, reason: `Import merge (${rec.source}): most advanced stage kept`, changedAt: this.importDate });
              this.recs.push({ entity: "deal_stage_history", entityId: hid, action: "created", before: null });
            }
          } else stageKey = curStage?.key ?? stageKey;
          const fill = fillEmpty(pick(current, DEAL_FILL_FIELDS), { ...incomingD, nextStep: rec.deal.nextStep ?? null, nextStepDueAt: rec.deal.nextStep ? due : null });
          Object.assign(patch, fill.patch);
          Object.assign(before, fill.before);
          if (rec.deal.probabilityOverride != null && current.probabilityOverride == null) {
            Object.assign(before, pick(current, ["probabilityOverride", "overrideReason", "overrideStatus"]));
            Object.assign(patch, { probabilityOverride: rec.deal.probabilityOverride, overrideReason: rec.deal.overrideReason ?? "Imported", overrideStatus: rec.deal.overrideStatus ?? "pending" });
          }
          if (rec.deal.r100) {
            const cur = (current.r100 as Row) ?? {};
            const merged = { ...cur };
            let changed = false;
            for (const [k, v] of Object.entries(rec.deal.r100)) if (isEmptyValue(merged[k]) && !isEmptyValue(v)) {
            merged[k] = v;
            changed = true;
          }
            if (changed) {
            before.r100 = cur;
            patch.r100 = merged;
          }
          }
          const curCf = (current.customFields as Row) ?? {};
          const mergedCf = { ...curCf };
          let cfChanged = false;
          for (const [k, v] of Object.entries(cf)) if (isEmptyValue(mergedCf[k]) && !isEmptyValue(v)) {
            mergedCf[k] = v;
            cfChanged = true;
          }
          if (cfChanged) {
            before.customFields = curCf;
            patch.customFields = mergedCf;
          }
          const tags = Array.from(new Set([...((current.tags as string[]) ?? []), "imported", ...(rec.deal.tags ?? [])]));
          if (tags.length !== ((current.tags as string[]) ?? []).length) {
            before.tags = current.tags;
            patch.tags = tags;
          }
          if ((rec.deal.restricted || rec.account.restricted) && !current.restricted) {
            before.restricted = false;
            patch.restricted = true;
          }
          if (this.queueUpdate("deals", dl, patch, before)) {
            if (!wasPending) {
              this.stats.dealsUpdated++;
              this.markUpdated("deal", dl.id, before);
              dealAction = "update";
            }
          }
          if (wasPending) {
            dealAction = "merge";
            if (accountAction !== "merge") this.stats.duplicatesMerged++;
          } else if (dealAction === "none") dealAction = "unchanged";
        }
        dealId = dl.id;

        // splits (only when the deal has none yet)
        if (ownerIds.length && !this.dealHasSplits.has(dl.id)) {
          for (const [i, sp] of equalSplits(ownerIds).entries()) {
            this.ins.splits.push({ dealId: dl.id, userId: sp.owner, pct: sp.pct, role: i === 0 ? "owner" : "collaborator" });
            if (!dl.pending) this.recs.push({ entity: "deal_split", entityId: dl.id, action: "created", before: { userId: sp.owner } });
            this.stats.splitsCreated++;
          }
          this.dealHasSplits.add(dl.id);
        }
        // stakeholders
        for (const cid of contactIds) {
          const pair = `${dl.id}|${cid}`;
          if (this.dealContactPairs.has(pair)) continue;
          this.dealContactPairs.add(pair);
          this.ins.dealContacts.push({ dealId: dl.id, contactId: cid, role: null });
          if (!dl.pending) this.recs.push({ entity: "deal_contact", entityId: dl.id, action: "created", before: { contactId: cid } });
        }
        // account lifecycle follows the deal
        const want = stage.category === "won" ? "customer" : stageRank(stage) > stageRank(openStages[0] ?? stage) ? "prospect" : null;
        const curLife = (acc.row.lifecycle as string) ?? "target";
        if (want && (LIFECYCLE_RANK[want] ?? 0) > (LIFECYCLE_RANK[curLife] ?? 0) && curLife !== "churned") {
          const wasPending = acc.pending;
          if (this.queueUpdate("accounts", acc, { lifecycle: want }, { lifecycle: curLife }) && !wasPending) this.markUpdated("account", acc.id, { lifecycle: curLife });
        }
      }
    }

    /* activities (notes / meetings) */
    for (const a of rec.activities) {
      const body = a.body.trim();
      if (!body) continue;
      const importKey = hashKey(`${acc.id}|${dealId ?? ""}|${a.type}|${body}`);
      if (this.activityKeys.has(importKey)) continue;
      this.activityKeys.add(importKey);
      const id = uuid();
      this.ins.activities.push({
        id,
        type: a.type,
        source: "import",
        subject: a.subject,
        body,
        occurredAt: a.occurredAt ?? this.importDate,
        actorId: null,
        dealId,
        accountId: acc.id,
        contactId: contactIds[0] ?? null,
        metadata: { importKey, sheet: rec.source, row: rec.rowNumber, batchId: this.batch.id },
      });
      this.recs.push({ entity: "activity", entityId: id, action: "created", before: null });
      this.stats.activitiesCreated++;
    }

    const outcome: RecordOutcome = {
      rowNumber: rec.rowNumber,
      account: accountAction,
      accountName: acc.row.name as string,
      deal: dealAction,
      stageKey,
      owners: rec.deal?.owners ?? [],
      contacts: contactIds.length,
    };
    this.outcomes.push(outcome);
    return outcome;
  }

  private markUpdated(entity: Entity, id: string, before: Row) {
    const key = `${entity}:${id}`;
    const existing = this.updatedRecs.get(key);
    if (existing) {
      const b = existing.before as Row;
      for (const [k, v] of Object.entries(before)) if (!(k in b)) b[k] = v;
    } else {
      const rec = { entity, entityId: id, action: "updated" as const, before: { ...before } };
      this.updatedRecs.set(key, rec);
      this.recs.push(rec);
    }
  }

  /** Migration project (MigrationPrio tab / onboarding). One per account; existing projects are left untouched. */
  applyMigration(input: { name: string; domain?: string | null; stage: (typeof s.migrationStage.enumValues)[number]; launched: boolean; notes?: string | null; rowNumber: number; source: string }) {
    if (!this.batch) throw new Error("beginBatch() first");
    this.stats.rows++;
    const acc = this.findAccount({ name: input.name, domain: input.domain ?? null });
    if (!acc) {
      this.stats.skipped++;
      return { matched: false as const };
    }
    if (this.migrationAccounts.has(acc.id)) return { matched: true as const, created: false };
    this.migrationAccounts.add(acc.id);
    let dealId: string | null = null;
    for (const key of ["NET", "ENT", "SPT"]) {
      const p = this.pipelines.get(key);
      const dl = p ? this.dealByKey.get(`${acc.id}|${p.id}`) : undefined;
      if (dl) {
        dealId = dl.id;
        break;
      }
    }
    const id = uuid();
    this.ins.migrations.push({
      id,
      accountId: acc.id,
      dealId,
      name: input.name,
      stage: input.stage,
      launched: input.launched,
      notes: input.notes ?? `Imported from ${input.source}`,
      stageEnteredAt: this.importDate,
      checklist: [],
    });
    this.recs.push({ entity: "migration_project", entityId: id, action: "created", before: null });
    this.stats.migrationsCreated++;
    return { matched: true as const, created: true };
  }

  /** Look up an already-indexed deal (for post-processing such as interviews). */
  findDeal(accountName: string, pipelineKey: string, domain: string | null = null): State | null {
    const acc = this.findAccount({ name: accountName, domain });
    const pipe = this.pipelines.get(pipelineKey);
    if (!acc || !pipe) return null;
    return this.dealByKey.get(`${acc.id}|${pipe.id}`) ?? null;
  }

  /** Deals of a pipeline whose account name loosely matches (prefix / contains) — for short names like "HIVE". */
  findDealsByLooseName(name: string, pipelineKey: string): State[] {
    const pipe = this.pipelines.get(pipelineKey);
    if (!pipe) return [];
    const n = normalizeName(name);
    if (!n) return [];
    const out: State[] = [];
    for (const [key, st] of this.dealByKey) {
      if (!key.endsWith(`|${pipe.id}`)) continue;
      const acc = this.accById.get(st.row.accountId as string);
      const an = normalizeName(acc?.row.name as string);
      if (an === n || an.startsWith(n) || (n.length >= 4 && an.includes(n))) out.push(st);
    }
    return out;
  }

  /** Merge keys into a deal's customFields (empty keys only), tracked for rollback. */
  patchDealCustomFields(dl: State, fields: Row) {
    const cur = (dl.row.customFields as Row) ?? {};
    const merged = { ...cur };
    let changed = false;
    for (const [k, v] of Object.entries(fields)) if (isEmptyValue(merged[k]) && !isEmptyValue(v)) {
            merged[k] = v;
            changed = true;
          }
    if (!changed) return false;
    const wasPending = dl.pending;
    this.queueUpdate("deals", dl, { customFields: merged }, { customFields: cur });
    if (!wasPending) {
      this.markUpdated("deal", dl.id, { customFields: cur });
      this.stats.dealsUpdated++;
    }
    return true;
  }

  /* ───────────── flush ───────────── */

  /** Write the open batch. Returns the batch id and stats. Set dryRun to discard instead. */
  async flush(opts: { dryRun?: boolean; log?: (msg: string) => void } = {}): Promise<{ batchId: string; stats: BatchStats; unmapped: Record<string, number> }> {
    if (!this.batch) throw new Error("No open batch");
    const batch = this.batch;
    const stats = { ...this.stats };
    const unmapped = Object.fromEntries(this.unmapped);
    if (opts.dryRun) {
      this.resetPending();
      return { batchId: batch.id, stats, unmapped };
    }
    const db = this.d;
    const log = opts.log ?? (() => {});
    await db.insert(s.importBatches).values({
      id: batch.id,
      fileName: batch.meta.fileName,
      sheetName: batch.meta.sheetName ?? null,
      target: batch.meta.target,
      pipelineKey: batch.meta.pipelineKey ?? null,
      mapping: batch.meta.mapping ?? {},
      status: "running",
      stats: stats as unknown as Record<string, number>,
      createdBy: this.actorId,
    });
    const insertAll = async (label: string, rows: Row[], table: Parameters<typeof db.insert>[0], size = 400, ignoreConflicts = false) => {
      for (const part of chunk(rows, size)) {
        const q = db.insert(table).values(part as never);
        await (ignoreConflicts ? q.onConflictDoNothing() : q);
      }
      if (rows.length) log(`  inserted ${rows.length} ${label}`);
    };
    try {
      await insertAll("placeholder users", this.ins.users, s.user, 400, true);
      await insertAll("accounts", this.ins.accounts, s.accounts, 300);
      await insertAll("contacts", this.ins.contacts, s.contacts);
      await insertAll("deals", this.ins.deals, s.deals, 200);
      await insertAll("deal splits", this.ins.splits, s.dealSplits, 400, true);
      await insertAll("deal contacts", this.ins.dealContacts, s.dealContacts, 400, true);
      await insertAll("stage history", this.ins.history, s.dealStageHistory);
      await insertAll("activities", this.ins.activities, s.activities);
      await insertAll("audience metrics", this.ins.metrics, s.audienceMetrics);
      await insertAll("migration projects", this.ins.migrations, s.migrationProjects);
      const updates = [...this.upd.values()];
      const tables = { accounts: s.accounts, deals: s.deals, contacts: s.contacts } as const;
      await pool(updates, 3, async (u) => {
        const t = tables[u.table];
        await db.update(t).set(u.patch as never).where(eq(t.id, u.id));
      });
      if (updates.length) log(`  updated ${updates.length} existing rows`);
      await insertAll(
        "import records",
        this.recs.map((r) => ({ batchId: batch.id, entity: r.entity, entityId: r.entityId, action: r.action, before: (r.before ?? null) as never })),
        s.importRecords,
        1000,
      );
      await db.update(s.importBatches).set({ status: "completed", stats: stats as unknown as Record<string, number> }).where(eq(s.importBatches.id, batch.id));
      await db.insert(s.auditLog).values({
        actorId: this.actorId,
        actorKind: this.actorId ? "user" : "system",
        action: "import.commit",
        entity: "import_batch",
        entityId: batch.id,
        after: { ...batch.meta, mapping: undefined, stats } as never,
      });
    } catch (e) {
      await db
        .update(s.importBatches)
        .set({ status: "failed", stats: { ...stats, error: 1 } as unknown as Record<string, number> })
        .where(eq(s.importBatches.id, batch.id))
        .catch(() => {});
      throw e;
    }
    // everything written is now "existing"
    for (const st of [...this.accById.values()]) st.pending = false;
    for (const st of this.dealByKey.values()) st.pending = false;
    for (const st of this.conByEmail.values()) st.pending = false;
    for (const st of this.conByAccName.values()) st.pending = false;
    this.resetPending();
    return { batchId: batch.id, stats, unmapped };
  }

  private resetPending() {
    for (const k of Object.keys(this.ins) as (keyof typeof this.ins)[]) this.ins[k] = [];
    this.upd.clear();
    this.recs = [];
    this.updatedRecs.clear();
    this.batch = null;
  }
}

/* ───────────── rollback ───────────── */

const TS_KEYS = /(At|Date)$/;
function reviveBefore(before: unknown): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries((before as Row) ?? {})) out[k] = typeof v === "string" && TS_KEYS.test(k) ? new Date(v) : v;
  return out;
}

/**
 * One-click rollback (IMP-6): soft-delete created accounts/contacts/deals, delete created activities / metrics /
 * splits / links / history / migration projects, and restore `before` for updated rows. Placeholder users are kept.
 */
export async function rollbackBatch(db: ImportDb, batchId: string, actorId: string | null) {
  const d = db as PostgresJsDatabase<typeof s>;
  const [batch] = await d.select().from(s.importBatches).where(eq(s.importBatches.id, batchId));
  if (!batch) throw new Error("Import batch not found");
  if (batch.status === "rolled_back") return { restored: 0, removed: 0 };
  const recs = await d.select().from(s.importRecords).where(eq(s.importRecords.batchId, batchId));
  const now = new Date();
  let restored = 0;
  let removed = 0;
  const ids = (entity: string) => recs.filter((r) => r.entity === entity && r.action === "created").map((r) => r.entityId);

  // 1) restore updated rows
  const tables = { account: s.accounts, deal: s.deals, contact: s.contacts, activity: s.activities, task: s.tasks, document: s.documents, audience_metric: s.audienceMetrics, migration_project: s.migrationProjects, deal_stage_history: s.dealStageHistory } as const;
  await pool(
    recs.filter((r) => (r.action === "updated" || r.action === "merged") && r.entity in tables),
    3,
    async (r) => {
      const t = tables[r.entity as keyof typeof tables];
      const before = reviveBefore(r.before);
      if (Object.keys(before).length) {
        await d.update(t).set(before as never).where(eq(t.id, r.entityId));
        restored++;
      }
    },
  );
  // 2) remove created child rows
  for (const part of chunk(ids("activity"), 500)) removed += (await d.delete(s.activities).where(inArray(s.activities.id, part)).returning({ id: s.activities.id })).length;
  for (const part of chunk(ids("audience_metric"), 500)) removed += (await d.delete(s.audienceMetrics).where(inArray(s.audienceMetrics.id, part)).returning({ id: s.audienceMetrics.id })).length;
  for (const part of chunk(ids("deal_stage_history"), 500)) removed += (await d.delete(s.dealStageHistory).where(inArray(s.dealStageHistory.id, part)).returning({ id: s.dealStageHistory.id })).length;
  for (const part of chunk(ids("migration_project"), 500)) removed += (await d.delete(s.migrationProjects).where(inArray(s.migrationProjects.id, part)).returning({ id: s.migrationProjects.id })).length;
  for (const r of recs.filter((x) => x.entity === "deal_split")) {
    const userId = (r.before as Row | null)?.userId as string | undefined;
    if (userId) await d.delete(s.dealSplits).where(and(eq(s.dealSplits.dealId, r.entityId), eq(s.dealSplits.userId, userId)));
  }
  for (const r of recs.filter((x) => x.entity === "deal_contact")) {
    const contactId = (r.before as Row | null)?.contactId as string | undefined;
    if (contactId) await d.delete(s.dealContacts).where(and(eq(s.dealContacts.dealId, r.entityId), eq(s.dealContacts.contactId, contactId)));
  }
  // 3) soft-delete created core records
  for (const part of chunk(ids("deal"), 500)) removed += (await d.update(s.deals).set({ deletedAt: now }).where(and(inArray(s.deals.id, part), isNull(s.deals.deletedAt))).returning({ id: s.deals.id })).length;
  for (const part of chunk(ids("contact"), 500)) removed += (await d.update(s.contacts).set({ deletedAt: now }).where(and(inArray(s.contacts.id, part), isNull(s.contacts.deletedAt))).returning({ id: s.contacts.id })).length;
  for (const part of chunk(ids("account"), 500)) removed += (await d.update(s.accounts).set({ deletedAt: now }).where(and(inArray(s.accounts.id, part), isNull(s.accounts.deletedAt))).returning({ id: s.accounts.id })).length;

  await d.update(s.importBatches).set({ status: "rolled_back", rolledBackAt: now }).where(eq(s.importBatches.id, batchId));
  await d.insert(s.auditLog).values({
    actorId,
    actorKind: actorId ? "user" : "system",
    action: "import.rollback",
    entity: "import_batch",
    entityId: batchId,
    before: { status: batch.status } as never,
    after: { restored, removed } as never,
  });
  return { restored, removed };
}

export { isPlaceholderEmail };
