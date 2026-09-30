/**
 * Roundtable Sales OS — database schema (Postgres, schema "rso").
 *
 * Conventions
 * - Auth tables (user/session/account/verification) follow Better Auth's core schema + admin plugin fields.
 * - App tables use uuid primary keys, created/updated timestamps, soft delete where records are user-facing.
 * - Money is stored in USD cents (bigint) unless noted; audience numbers (MUU, visits) as bigint.
 * - Flexible per-record custom fields live in `customFields` (jsonb), definitions in `custom_field_defs`.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const rso = pgSchema("rso");

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const deletedAt = () => timestamp("deleted_at", { withTimezone: true });

/* ───────────────────────────── Enums (as pg enums in schema rso) ───────────────────────────── */

export const roleKey = rso.enum("role_key", [
  "super_admin",
  "admin",
  "executive",
  "sales_leader",
  "ae",
  "sdr",
  "intern",
  "commission_rep",
  "onboarding",
  "finance",
  "editorial",
  "viewer",
  "pending",
]);

export const employmentType = rso.enum("employment_type", ["staff", "retainer", "hourly", "commission", "contractor"]);

export const pipelineType = rso.enum("pipeline_type", ["NET", "ENT", "SPT", "R100", "ADS", "PAY", "CUSTOM"]);
export const valueUnit = rso.enum("value_unit", ["muu", "usd", "activation"]);
export const stageCategory = rso.enum("stage_category", ["open", "won", "lost", "hold"]);
export const dealStatus = rso.enum("deal_status", ["open", "won", "lost", "hold"]);

export const accountType = rso.enum("account_type", [
  "publisher",
  "media_group",
  "public_company",
  "token_project",
  "advertiser",
  "agency",
  "partner",
  "other",
]);
export const lifecycle = rso.enum("lifecycle", ["target", "prospect", "customer", "churned", "disqualified"]);
export const priority = rso.enum("priority", ["top10", "high", "medium", "low"]);

export const metricType = rso.enum("metric_type", ["muu", "visits", "pageviews"]);
export const metricConfidence = rso.enum("metric_confidence", ["verified", "reported", "estimate"]);

export const activityType = rso.enum("activity_type", [
  "email",
  "call",
  "meeting",
  "note",
  "linkedin",
  "stage_change",
  "field_change",
  "system",
  "agent",
]);
export const activitySource = rso.enum("activity_source", [
  "manual",
  "gmail",
  "calendar",
  "zoom",
  "granola",
  "meet",
  "upload",
  "import",
  "agent",
  "system",
]);

export const taskStatus = rso.enum("task_status", ["open", "done", "cancelled"]);
export const taskOrigin = rso.enum("task_origin", ["manual", "email_ai", "call_ai", "rule", "sequence", "agent", "import"]);

export const alertSeverity = rso.enum("alert_severity", ["info", "warning", "serious", "critical"]);
export const alertState = rso.enum("alert_state", ["open", "acknowledged", "snoozed", "resolved", "dismissed", "escalated"]);

export const docType = rso.enum("doc_type", ["nda", "contract", "proposal", "pro_forma", "deck", "io", "invoice", "other"]);
export const docStatus = rso.enum("doc_status", ["draft", "sent", "signed", "expired"]);

export const transcriptSource = rso.enum("transcript_source", ["granola", "zoom", "meet", "upload", "paste"]);
export const processingStatus = rso.enum("processing_status", ["pending", "processing", "ready", "failed"]);

export const invoiceStatus = rso.enum("invoice_status", ["scheduled", "sent", "paid", "overdue", "written_off"]);

export const candidateState = rso.enum("candidate_state", ["new", "accepted", "rejected", "snoozed", "duplicate"]);
export const runStatus = rso.enum("run_status", ["queued", "running", "succeeded", "failed", "blocked"]);
export const emailVerification = rso.enum("email_verification", ["valid", "risky", "invalid", "unknown"]);

export const migrationStage = rso.enum("migration_stage", [
  "discovery",
  "scoping",
  "clone_built",
  "content_migrated",
  "qa",
  "launched",
  "live",
  "paused",
]);

/* ───────────────────────────── Better Auth core tables ───────────────────────────── */

export const user = rso.table("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  // admin plugin
  role: text("role").notNull().default("pending"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  // app profile
  title: text("title"),
  employmentType: employmentType("employment_type").default("staff"),
  teamId: uuid("team_id"),
  managerId: text("manager_id"),
  timezone: text("timezone").default("America/New_York"),
  workStartHour: integer("work_start_hour").default(9),
  workEndHour: integer("work_end_hour").default(18),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
  monthlyScoutBudgetCents: integer("monthly_scout_budget_cents"),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
});

export const session = rso.table(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = rso.table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = rso.table("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ───────────────────────────── Org, teams, RBAC ───────────────────────────── */

export const teams = rso.table("teams", {
  id: id(),
  name: text("name").notNull(),
  leadId: text("lead_id").references(() => user.id, { onDelete: "set null" }),
  pipelineTypes: text("pipeline_types").array().notNull().default(sql`'{}'::text[]`),
  territory: jsonb("territory").$type<{ regions?: string[]; verticals?: string[]; leagues?: string[] }>().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Role permission overrides. Defaults live in code (src/lib/rbac/defaults.ts); a row here overrides one cell of the
 * module × action matrix for a role. scope ∈ none | own | team | pipeline | all.
 */
export const rolePermissions = rso.table(
  "role_permissions",
  {
    role: text("role").notNull(),
    module: text("module").notNull(),
    action: text("action").notNull(),
    scope: text("scope").notNull(),
    updatedBy: text("updated_by"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.role, t.module, t.action] })],
);

/** Field-level security: hidden/read_only per role per entity field. */
export const fieldPermissions = rso.table(
  "field_permissions",
  {
    role: text("role").notNull(),
    entity: text("entity").notNull(),
    field: text("field").notNull(),
    access: text("access").notNull(), // hidden | read_only | editable
  },
  (t) => [primaryKey({ columns: [t.role, t.entity, t.field] })],
);

/** Explicit access list for restricted (MNPI) records. */
export const restrictedAccess = rso.table(
  "restricted_access",
  {
    entity: text("entity").notNull(), // deal | account
    entityId: uuid("entity_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.entity, t.entityId, t.userId] }), index("restricted_access_user_idx").on(t.userId)],
);

export const allowedDomains = rso.table("allowed_domains", {
  domain: text("domain").primaryKey(),
  createdAt: createdAt(),
});

/** Key/value org settings (MUU $/yr default, visits-per-unique factor, budgets, agent autonomy, etc.). */
export const appSettings = rso.table("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: updatedAt(),
});

/* ───────────────────────────── Pipelines & stages ───────────────────────────── */

export const pipelines = rso.table("pipelines", {
  id: id(),
  key: text("key").notNull().unique(), // NET, ENT, SPT, R100, ADS, PAY, or custom slug
  type: pipelineType("type").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  unit: valueUnit("unit").notNull(),
  color: text("color").notNull(), // chart palette hex
  usdPerMuu: doublePrecision("usd_per_muu").notNull().default(1),
  defaultRevSharePct: doublePrecision("default_rev_share_pct"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const stages = rso.table(
  "stages",
  {
    id: id(),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull(),
    probability: doublePrecision("probability").notNull(), // 0..1
    category: stageCategory("category").notNull().default("open"),
    slaDays: integer("sla_days"),
    requiredFields: text("required_fields").array().notNull().default(sql`'{}'::text[]`),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    importAliases: text("import_aliases").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("stages_pipeline_key").on(t.pipelineId, t.key)],
);

/* ───────────────────────────── Accounts, audience, contacts ───────────────────────────── */

export const accounts = rso.table(
  "accounts",
  {
    id: id(),
    name: text("name").notNull(),
    domain: text("domain"), // normalized, unique when present
    altDomains: text("alt_domains").array().notNull().default(sql`'{}'::text[]`),
    parentId: uuid("parent_id"),
    type: accountType("type").notNull().default("publisher"),
    category: text("category"),
    subcategory: text("subcategory"),
    league: text("league"),
    team: text("team"),
    country: text("country"),
    region: text("region"),
    language: text("language"),
    ownership: text("ownership"),
    ticker: text("ticker"),
    tokenName: text("token_name"),
    isB2c: boolean("is_b2c"),
    marketCapUsd: bigint("market_cap_usd", { mode: "number" }),
    website: text("website"),
    pressPage: text("press_page"),
    prEmail: text("pr_email"),
    linkedinUrl: text("linkedin_url"),
    lifecycle: lifecycle("lifecycle").notNull().default("target"),
    priority: priority("priority"),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    teamId: uuid("team_id"),
    // denormalized latest audience (source of truth = audience_metrics)
    muu: bigint("muu", { mode: "number" }),
    muuSource: text("muu_source"),
    muuConfidence: metricConfidence("muu_confidence"),
    monthlyVisits: bigint("monthly_visits", { mode: "number" }),
    techStack: text("tech_stack").array().notNull().default(sql`'{}'::text[]`),
    fitScore: integer("fit_score"),
    fitExplanation: text("fit_explanation"),
    restricted: boolean("restricted").notNull().default(false),
    doNotContact: boolean("do_not_contact").notNull().default(false),
    notes: text("notes"),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
    source: text("source"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex("accounts_domain_uq").on(t.domain).where(sql`${t.domain} is not null and ${t.deletedAt} is null`),
    index("accounts_owner_idx").on(t.ownerId),
    index("accounts_name_idx").on(t.name),
    index("accounts_name_trgm").using("gin", sql`lower(${t.name}) extensions.gin_trgm_ops`),
    index("accounts_domain_trgm").using("gin", sql`${t.domain} extensions.gin_trgm_ops`),
  ],
);

export const audienceMetrics = rso.table(
  "audience_metrics",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    metric: metricType("metric").notNull(),
    value: bigint("value", { mode: "number" }).notNull(),
    rawValue: text("raw_value"),
    derivedMuu: bigint("derived_muu", { mode: "number" }),
    factorUsed: doublePrecision("factor_used"),
    period: text("period"), // YYYY-MM
    source: text("source").notNull(),
    confidence: metricConfidence("confidence").notNull().default("estimate"),
    enteredBy: text("entered_by"),
    createdAt: createdAt(),
  },
  (t) => [index("audience_account_idx").on(t.accountId)],
);

export const contacts = rso.table(
  "contacts",
  {
    id: id(),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    firstName: text("first_name"),
    lastName: text("last_name"),
    fullName: text("full_name").notNull(),
    title: text("title"),
    seniority: text("seniority"),
    email: text("email"),
    altEmails: text("alt_emails").array().notNull().default(sql`'{}'::text[]`),
    emailStatus: emailVerification("email_status").default("unknown"),
    phone: text("phone"),
    linkedinUrl: text("linkedin_url"),
    relationshipOwnerId: text("relationship_owner_id").references(() => user.id, { onDelete: "set null" }),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"), // active | left_company
    doNotContact: boolean("do_not_contact").notNull().default(false),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
    origin: text("origin"), // manual | import | lead_scout | email | calendar
    notes: text("notes"),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("contacts_account_idx").on(t.accountId),
    index("contacts_email_idx").on(t.email),
    index("contacts_owner_idx").on(t.ownerId),
    index("contacts_rel_owner_idx").on(t.relationshipOwnerId),
    index("contacts_name_trgm").using("gin", sql`lower(${t.fullName}) extensions.gin_trgm_ops`),
  ],
);

/* ───────────────────────────── Deals ───────────────────────────── */

export const deals = rso.table(
  "deals",
  {
    id: id(),
    name: text("name").notNull(),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => stages.id),
    status: dealStatus("status").notNull().default("open"),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    primaryContactId: uuid("primary_contact_id").references(() => contacts.id, { onDelete: "set null" }),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    teamId: uuid("team_id"),
    source: text("source"),
    priority: priority("priority"),
    expectedCloseDate: timestamp("expected_close_date", { withTimezone: true }),
    nextStep: text("next_step"),
    nextStepDueAt: timestamp("next_step_due_at", { withTimezone: true }),
    nextStepWaitingReason: text("next_step_waiting_reason"),
    stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    // probability
    probabilityOverride: doublePrecision("probability_override"),
    overrideReason: text("override_reason"),
    overrideApprovedBy: text("override_approved_by"),
    overrideStatus: text("override_status"), // pending | approved | rejected
    // value — MUU motions
    muu: bigint("muu", { mode: "number" }),
    usdPerMuu: doublePrecision("usd_per_muu"),
    revSharePct: doublePrecision("rev_share_pct"),
    guaranteeType: text("guarantee_type"),
    guaranteeMonthlyCents: bigint("guarantee_monthly_cents", { mode: "number" }),
    rampMonths: integer("ramp_months"),
    termYears: doublePrecision("term_years"),
    // value — $ motions
    contractValueCents: bigint("contract_value_cents", { mode: "number" }),
    annualizedValueCents: bigint("annualized_value_cents", { mode: "number" }),
    nextPaymentCents: bigint("next_payment_cents", { mode: "number" }),
    nextPaymentAt: timestamp("next_payment_at", { withTimezone: true }),
    renewalAt: timestamp("renewal_at", { withTimezone: true }),
    // R100 program
    r100: jsonb("r100")
      .$type<{
        firstPostDate?: string | null;
        participation?: boolean[];
        postCount?: number;
        profileUrl?: string | null;
        editorialLinks?: string[];
        bonusEligible?: boolean;
        bonusCents?: number;
      }>()
      .notNull()
      .default({}),
    // computed + AI
    healthScore: integer("health_score"),
    healthExplanation: text("health_explanation"),
    aiSummary: text("ai_summary"),
    aiSummaryAt: timestamp("ai_summary_at", { withTimezone: true }),
    wonAt: timestamp("won_at", { withTimezone: true }),
    lostAt: timestamp("lost_at", { withTimezone: true }),
    lostReason: text("lost_reason"),
    holdReason: text("hold_reason"),
    restricted: boolean("restricted").notNull().default(false),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("deals_pipeline_stage_idx").on(t.pipelineId, t.stageId),
    index("deals_owner_idx").on(t.ownerId),
    index("deals_account_idx").on(t.accountId),
    index("deals_next_step_idx").on(t.nextStepDueAt),
    index("deals_stage_idx").on(t.stageId),
    index("deals_primary_contact_idx").on(t.primaryContactId),
    index("deals_name_trgm").using("gin", sql`lower(${t.name}) extensions.gin_trgm_ops`),
  ],
);

export const dealSplits = rso.table(
  "deal_splits",
  {
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    pct: doublePrecision("pct").notNull(), // 0..100
    role: text("role").default("owner"), // owner | sourcer | closer | collaborator
  },
  (t) => [primaryKey({ columns: [t.dealId, t.userId] }), index("deal_splits_user_idx").on(t.userId)],
);

export const dealContacts = rso.table(
  "deal_contacts",
  {
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    role: text("role"), // decision_maker | champion | influencer | legal | tech | blocker
  },
  (t) => [primaryKey({ columns: [t.dealId, t.contactId] }), index("deal_contacts_contact_idx").on(t.contactId)],
);

export const dealStageHistory = rso.table(
  "deal_stage_history",
  {
    id: id(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    fromStageId: uuid("from_stage_id"),
    toStageId: uuid("to_stage_id").notNull(),
    changedBy: text("changed_by"),
    reason: text("reason"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("stage_hist_deal_idx").on(t.dealId)],
);

export const dealHealthHistory = rso.table(
  "deal_health_history",
  {
    id: id(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    score: integer("score").notNull(),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("deal_health_history_deal_idx").on(t.dealId, t.takenAt)],
);

export const dealLineItems = rso.table("deal_line_items", {
  id: id(),
  dealId: uuid("deal_id")
    .notNull()
    .references(() => deals.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull(),
  quantity: doublePrecision("quantity").default(1),
  priceCents: bigint("price_cents", { mode: "number" }),
  notes: text("notes"),
});

export const products = rso.table("products", {
  id: id(),
  family: text("family").notNull(),
  name: text("name").notNull(),
  sku: text("sku"),
  description: text("description"),
  pipelineKeys: text("pipeline_keys").array().notNull().default(sql`'{}'::text[]`),
  pricingModel: text("pricing_model"), // rev_share | fixed | cpm | package | free
  defaultTerms: jsonb("default_terms").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status").notNull().default("live"), // live | beta | upcoming | retired
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

/* ───────────────────────────── Activities, tasks ───────────────────────────── */

export const activities = rso.table(
  "activities",
  {
    id: id(),
    type: activityType("type").notNull(),
    source: activitySource("source").notNull().default("manual"),
    subject: text("subject"),
    body: text("body"),
    direction: text("direction"), // inbound | outbound
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    durationMin: integer("duration_min"),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    emailMessageId: uuid("email_message_id"),
    transcriptId: uuid("transcript_id"),
    meetingId: uuid("meeting_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("activities_deal_idx").on(t.dealId, t.occurredAt),
    index("activities_account_idx").on(t.accountId, t.occurredAt),
    index("activities_actor_idx").on(t.actorId, t.occurredAt),
    index("activities_contact_idx").on(t.contactId),
  ],
);

export const tasks = rso.table(
  "tasks",
  {
    id: id(),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatus("status").notNull().default("open"),
    priority: priority("priority").default("medium"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    assigneeId: text("assignee_id").references(() => user.id, { onDelete: "set null" }),
    createdBy: text("created_by"),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    origin: taskOrigin("origin").notNull().default("manual"),
    owedBy: text("owed_by"), // us | them — for commitments
    evidence: text("evidence"),
    evidenceSource: text("evidence_source"), // e.g. email:<id> | transcript:<id>@00:12:31
    snoozeCount: integer("snooze_count").notNull().default(0),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    snoozeReason: text("snooze_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_assignee_idx").on(t.assigneeId, t.status, t.dueAt),
    index("tasks_deal_idx").on(t.dealId),
    index("tasks_account_idx").on(t.accountId),
    index("tasks_contact_idx").on(t.contactId),
  ],
);

export const comments = rso.table("comments", {
  id: id(),
  entity: text("entity").notNull(), // deal | account | contact
  entityId: uuid("entity_id").notNull(),
  authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
  body: text("body").notNull(),
  mentions: text("mentions").array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
},
(t) => [index("comments_entity_idx").on(t.entity, t.entityId)]);

/* ───────────────────────────── Email, calendar, calls ───────────────────────────── */

export const integrationConnections = rso.table(
  "integration_connections",
  {
    id: id(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }), // null = org-level
    provider: text("provider").notNull(), // gmail | calendar | granola | zoom | apify | slack
    status: text("status").notNull().default("connected"), // connected | error | revoked
    secretEncrypted: text("secret_encrypted"), // AES-GCM, for API keys (Granola/Apify)
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    cursor: text("cursor"), // e.g. gmail historyId
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("integration_user_provider").on(t.userId, t.provider),
    uniqueIndex("integration_org_provider").on(t.provider).where(sql`${t.userId} is null`),
  ],
);

export const emailThreads = rso.table(
  "email_threads",
  {
    id: id(),
    mailboxUserId: text("mailbox_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    gmailThreadId: text("gmail_thread_id").notNull(),
    subject: text("subject"),
    snippet: text("snippet"),
    participants: text("participants").array().notNull().default(sql`'{}'::text[]`),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    awaitingReplyFrom: text("awaiting_reply_from"), // us | them | none
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    private: boolean("private").notNull().default(false),
    aiIntent: text("ai_intent"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("email_threads_uq").on(t.mailboxUserId, t.gmailThreadId),
    index("email_threads_deal_idx").on(t.dealId),
    index("email_threads_account_idx").on(t.accountId),
  ],
);

export const emailMessages = rso.table(
  "email_messages",
  {
    id: id(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => emailThreads.id, { onDelete: "cascade" }),
    gmailMessageId: text("gmail_message_id").notNull(),
    fromAddr: text("from_addr"),
    toAddrs: text("to_addrs").array().notNull().default(sql`'{}'::text[]`),
    ccAddrs: text("cc_addrs").array().notNull().default(sql`'{}'::text[]`),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    direction: text("direction"), // inbound | outbound
    messageIdHeader: text("message_id_header"),
    bodyText: text("body_text"),
    analysis: jsonb("analysis").$type<Record<string, unknown>>(),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("email_messages_uq").on(t.threadId, t.gmailMessageId)],
);

export const meetings = rso.table(
  "meetings",
  {
    id: id(),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    calendarEventId: text("calendar_event_id"),
    title: text("title"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    attendees: text("attendees").array().notNull().default(sql`'{}'::text[]`),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    transcriptId: uuid("transcript_id"),
    prepBrief: text("prep_brief"),
    consentConfirmed: boolean("consent_confirmed").default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("meetings_owner_event").on(t.ownerId, t.calendarEventId),
    index("meetings_deal_idx").on(t.dealId),
    index("meetings_account_idx").on(t.accountId),
  ],
);

export const transcripts = rso.table(
  "transcripts",
  {
    id: id(),
    source: transcriptSource("source").notNull(),
    externalId: text("external_id"),
    title: text("title"),
    rawText: text("raw_text").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    durationMin: integer("duration_min"),
    participants: text("participants").array().notNull().default(sql`'{}'::text[]`),
    uploadedBy: text("uploaded_by").references(() => user.id, { onDelete: "set null" }),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    meetingId: uuid("meeting_id"),
    status: processingStatus("status").notNull().default("pending"),
    analysis: jsonb("analysis").$type<Record<string, unknown>>(),
    analysisEngine: text("analysis_engine"), // ai:<model> | heuristic
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("transcripts_source_ext").on(t.source, t.externalId),
    index("transcripts_deal_idx").on(t.dealId),
    index("transcripts_account_idx").on(t.accountId),
    index("transcripts_uploaded_by_idx").on(t.uploadedBy),
  ],
);

export const documents = rso.table("documents", {
  id: id(),
  dealId: uuid("deal_id").references(() => deals.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
  type: docType("type").notNull(),
  name: text("name").notNull(),
  url: text("url"),
  status: docStatus("status").notNull().default("draft"),
  version: integer("version").notNull().default(1),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  uploadedBy: text("uploaded_by"),
  createdAt: createdAt(),
},
(t) => [index("documents_deal_idx").on(t.dealId), index("documents_account_idx").on(t.accountId)]);

/* ───────────────────────────── Proposals / pro formas ───────────────────────────── */

export const proposals = rso.table("proposals", {
  id: id(),
  title: text("title"),
  dealId: uuid("deal_id")
    .notNull()
    .references(() => deals.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
  outputs: jsonb("outputs").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("draft"), // draft | pending_approval | approved | sent | locked
  approvalReason: text("approval_reason"),
  approvedBy: text("approved_by"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  mask: jsonb("mask").$type<Record<string, boolean>>(),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
},
(t) => [index("proposals_deal_idx").on(t.dealId)]);

/* ───────────────────────────── Onboarding / migration ───────────────────────────── */

export const migrationProjects = rso.table("migration_projects", {
  id: id(),
  dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  stage: migrationStage("stage").notNull().default("discovery"),
  launched: boolean("launched").notNull().default(false),
  ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
  targetGoLive: timestamp("target_go_live", { withTimezone: true }),
  actualGoLive: timestamp("actual_go_live", { withTimezone: true }),
  cloneUrl: text("clone_url"),
  liveUrl: text("live_url"),
  blockers: text("blockers"),
  checklist: jsonb("checklist").$type<{ item: string; done: boolean }[]>().notNull().default([]),
  stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).notNull().defaultNow(),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
},
(t) => [
  uniqueIndex("migration_projects_deal_uq").on(t.dealId).where(sql`${t.dealId} is not null`),
  index("migration_projects_account_idx").on(t.accountId),
  index("migration_projects_owner_idx").on(t.ownerId),
]);

/* ───────────────────────────── Revenue (ADS) ───────────────────────────── */

export const invoices = rso.table("invoices", {
  id: id(),
  dealId: uuid("deal_id")
    .notNull()
    .references(() => deals.id, { onDelete: "cascade" }),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  status: invoiceStatus("status").notNull().default("scheduled"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  paidInKind: text("paid_in_kind"),
  pikValueCents: bigint("pik_value_cents", { mode: "number" }),
  pikApprovedBy: text("pik_approved_by"),
  sourceKey: text("source_key"), // idempotency key for automated creation (e.g. "won:<dealId>")
  sentAt: timestamp("sent_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
},
(t) => [
  index("invoices_deal_idx").on(t.dealId),
  uniqueIndex("invoices_source_key_uq").on(t.sourceKey).where(sql`${t.sourceKey} is not null`),
]);

/* ───────────────────────────── Commissions ───────────────────────────── */

export const commissionPlans = rso.table("commission_plans", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  rules: jsonb("rules")
    .$type<
      {
        trigger: "deal_won" | "invoice_paid" | "r100_live" | "meeting_held" | "migration_launched";
        pipelineKeys?: string[];
        rateType: "pct_contract" | "pct_net" | "flat";
        rate: number; // pct (0-100) or cents for flat
        capCents?: number;
        clawbackDays?: number;
      }[]
    >()
    .notNull()
    .default([]),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const commissionAssignments = rso.table(
  "commission_assignments",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => commissionPlans.id, { onDelete: "cascade" }),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.planId] }), index("commission_assignments_plan_idx").on(t.planId)],
);

export const commissionAccruals = rso.table("commission_accruals", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  planId: uuid("plan_id"),
  dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
  invoiceId: uuid("invoice_id"),
  trigger: text("trigger").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  status: text("status").notNull().default("accrued"), // accrued | approved | paid | disputed | clawed_back
  period: text("period").notNull(), // YYYY-MM
  sourceKey: text("source_key"), // stable idempotency key: <trigger>:<ruleId|hash>:<eventId>
  note: text("note"),
  createdAt: createdAt(),
},
(t) => [
  uniqueIndex("commission_accruals_source_uq").on(t.userId, t.planId, t.sourceKey).where(sql`${t.sourceKey} is not null`),
  index("commission_accruals_deal_idx").on(t.dealId),
]);

export const leadRegistrations = rso.table("lead_registrations", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"), // pending | approved | rejected | expired
  protectedUntil: timestamp("protected_until", { withTimezone: true }),
  decidedBy: text("decided_by"),
  note: text("note"),
  createdAt: createdAt(),
},
(t) => [index("lead_registrations_account_idx").on(t.accountId), index("lead_registrations_user_idx").on(t.userId)]);

/* ───────────────────────────── Nothing Slips (alerts) & notifications ───────────────────────────── */

export const alertRules = rso.table("alert_rules", {
  code: text("code").primaryKey(), // NS-01 …
  name: text("name").notNull(),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(true),
  severity: alertSeverity("severity").notNull().default("warning"),
  params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
  escalateAfterHours: integer("escalate_after_hours"),
  updatedAt: updatedAt(),
});

export const alerts = rso.table(
  "alerts",
  {
    id: id(),
    ruleCode: text("rule_code").notNull(),
    entity: text("entity").notNull(), // deal | task | account | invoice | migration | integration | scout
    entityId: text("entity_id").notNull(),
    recipientId: text("recipient_id").references(() => user.id, { onDelete: "cascade" }),
    severity: alertSeverity("severity").notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    suggestedAction: text("suggested_action"),
    state: alertState("state").notNull().default("open"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("alerts_open_uq")
      .on(t.ruleCode, t.entity, t.entityId, t.recipientId)
      .where(sql`${t.state} in ('open','acknowledged','snoozed','escalated')`),
    index("alerts_recipient_idx").on(t.recipientId, t.state),
    index("alerts_rule_state_idx").on(t.ruleCode, t.state),
    index("alerts_entity_idx").on(t.entity, t.entityId),
  ],
);

export const notifications = rso.table(
  "notifications",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // alert | mention | approval | digest | system
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.readAt)],
);

export const approvals = rso.table("approvals", {
  id: id(),
  kind: text("kind").notNull(), // probability_override | proposal | lead_registration | scout_budget | stage_gate
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  requestedBy: text("requested_by").notNull(),
  approverRole: text("approver_role").notNull().default("executive"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status").notNull().default("pending"), // pending | approved | rejected
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  note: text("note"),
  createdAt: createdAt(),
},
(t) => [index("approvals_entity_idx").on(t.entity, t.entityId, t.status), index("approvals_status_idx").on(t.status, t.approverRole)]);

/* ───────────────────────────── Lead Scout & enrichment ───────────────────────────── */

export const actorRegistry = rso.table("actor_registry", {
  id: id(),
  purpose: text("purpose").notNull(), // traffic | lookalike | serp | tech_stack | website_contacts | people | email_from_linkedin | email_finder | email_verify | research
  actorId: text("actor_id").notNull(), // e.g. tri_angle/fast-similarweb-scraper
  fallbackOrder: integer("fallback_order").notNull().default(0),
  inputTemplate: jsonb("input_template").$type<Record<string, unknown>>().notNull().default({}),
  outputMapping: jsonb("output_mapping").$type<Record<string, string>>().notNull().default({}),
  costPerResultUsd: doublePrecision("cost_per_result_usd").notNull().default(0.01),
  timeoutSecs: integer("timeout_secs").notNull().default(120),
  maxItems: integer("max_items").notNull().default(25),
  enabled: boolean("enabled").notNull().default(true),
  compliant: boolean("compliant").notNull().default(true),
  createdAt: createdAt(),
});

export const scoutSearches = rso.table("scout_searches", {
  id: id(),
  name: text("name").notNull(),
  ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
  criteria: jsonb("criteria")
    .$type<{
      categories?: string[];
      countries?: string[];
      languages?: string[];
      muuMin?: number;
      muuMax?: number;
      ownership?: string[];
      keywords?: string[];
      seedDomains?: string[];
      domains?: string[];
      excludeDomains?: string[];
    }>()
    .notNull()
    .default({}),
  schedule: text("schedule").notNull().default("once"), // once | weekly | monthly
  status: text("status").notNull().default("draft"), // draft | running | done | failed
  budgetCapCents: integer("budget_cap_cents"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const scoutCandidates = rso.table(
  "scout_candidates",
  {
    id: id(),
    searchId: uuid("search_id").references(() => scoutSearches.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    name: text("name"),
    category: text("category"),
    country: text("country"),
    language: text("language"),
    monthlyVisits: bigint("monthly_visits", { mode: "number" }),
    estMuu: bigint("est_muu", { mode: "number" }),
    muuSource: text("muu_source"),
    trendPct: doublePrecision("trend_pct"),
    techStack: text("tech_stack").array().notNull().default(sql`'{}'::text[]`),
    ownership: text("ownership"),
    fitScore: integer("fit_score"),
    fitFactors: jsonb("fit_factors").$type<Record<string, number>>().notNull().default({}),
    fitExplanation: text("fit_explanation"),
    estValueCents: bigint("est_value_cents", { mode: "number" }),
    crmMatch: jsonb("crm_match").$type<{ accountId?: string; dealId?: string; ownerId?: string; stage?: string }>(),
    state: candidateState("state").notNull().default("new"),
    rejectReason: text("reject_reason"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    suppressedUntil: timestamp("suppressed_until", { withTimezone: true }),
    muuConfidence: metricConfidence("muu_confidence"),
    reviewerId: text("reviewer_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("scout_candidates_search_domain").on(t.searchId, t.domain), index("scout_candidates_domain_state").on(t.domain, t.state)],
);

export const enrichmentRuns = rso.table("enrichment_runs", {
  id: id(),
  kind: text("kind").notNull(), // scout | enrich
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
  searchId: uuid("search_id"),
  dealId: uuid("deal_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
  targetRoles: text("target_roles").array().notNull().default(sql`'{}'::text[]`),
  actors: jsonb("actors").$type<{ actorId: string; runId?: string; status?: string; costUsd?: number }[]>().notNull().default([]),
  status: runStatus("status").notNull().default("queued"),
  estimatedCostCents: integer("estimated_cost_cents").notNull().default(0),
  costCents: integer("cost_cents").notNull().default(0),
  resultsCount: integer("results_count").notNull().default(0),
  verifiedCount: integer("verified_count").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const enrichedContacts = rso.table("enriched_contacts", {
  id: id(),
  runId: uuid("run_id").references(() => enrichmentRuns.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  title: text("title"),
  seniority: text("seniority"),
  linkedinUrl: text("linkedin_url"),
  email: text("email"),
  emailSource: text("email_source"),
  verification: emailVerification("verification").notNull().default("unknown"),
  confidence: doublePrecision("confidence"),
  sourceActor: text("source_actor"),
  promotedContactId: uuid("promoted_contact_id"),
  state: text("state").notNull().default("staged"), // staged | promoted | discarded
  createdAt: createdAt(),
});

export const suppressionList = rso.table("suppression_list", {
  value: text("value").primaryKey(), // email or domain
  kind: text("kind").notNull(), // email | domain
  reason: text("reason"),
  createdAt: createdAt(),
});

/* ───────────────────────────── Governance: claims, imports, audit, snapshots, custom fields ───────────────────────────── */

export const claims = rso.table("claims", {
  id: id(),
  text: text("text").notNull(),
  pattern: text("pattern"), // regex used to detect the claim in drafts
  status: text("status").notNull(), // approved | restricted | banned
  productId: uuid("product_id"),
  evidence: text("evidence"),
  approvedAlternative: text("approved_alternative"),
  approverId: text("approver_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const customFieldDefs = rso.table(
  "custom_field_defs",
  {
    id: id(),
    entity: text("entity").notNull(), // account | contact | deal
    pipelineKey: text("pipeline_key"), // for deals: restrict to pipeline
    key: text("key").notNull(),
    label: text("label").notNull(),
    fieldType: text("field_type").notNull(), // text | number | currency | percent | date | select | multiselect | checkbox | url
    options: text("options").array().notNull().default(sql`'{}'::text[]`),
    requiredAtStages: text("required_at_stages").array().notNull().default(sql`'{}'::text[]`),
    helpText: text("help_text"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("custom_field_entity_key").on(t.entity, t.key)],
);

export const picklists = rso.table(
  "picklists",
  {
    id: id(),
    list: text("list").notNull(), // category | league | source | lost_reason | contact_role | reject_reason …
    value: text("value").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
  },
  (t) => [uniqueIndex("picklists_list_value").on(t.list, t.value)],
);

export const importBatches = rso.table("import_batches", {
  id: id(),
  fileName: text("file_name").notNull(),
  sheetName: text("sheet_name"),
  target: text("target").notNull(), // accounts | contacts | deals | r100 | ads
  pipelineKey: text("pipeline_key"),
  mapping: jsonb("mapping").$type<Record<string, string>>().notNull().default({}),
  status: text("status").notNull().default("completed"), // previewed | completed | rolled_back | failed
  stats: jsonb("stats").$type<Record<string, number>>().notNull().default({}),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
});

export const importRecords = rso.table(
  "import_records",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    sheet: text("sheet"),
    rowNumber: integer("row_number"),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(), // created | updated | merged
    before: jsonb("before"),
  },
  (t) => [index("import_records_batch_idx").on(t.batchId)],
);

export const auditLog = rso.table(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    actorId: text("actor_id"),
    actorKind: text("actor_kind").notNull().default("user"), // user | agent | system
    action: text("action").notNull(),
    entity: text("entity"),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_entity_idx").on(t.entity, t.entityId), index("audit_actor_idx").on(t.actorId, t.createdAt)],
);

export const pipelineSnapshots = rso.table(
  "pipeline_snapshots",
  {
    id: id(),
    takenOn: text("taken_on").notNull(), // YYYY-MM-DD
    pipelineKey: text("pipeline_key").notNull(),
    stageKey: text("stage_key").notNull(),
    dealCount: integer("deal_count").notNull(),
    muu: bigint("muu", { mode: "number" }).notNull().default(0),
    grossCents: bigint("gross_cents", { mode: "number" }).notNull().default(0),
    weightedCents: bigint("weighted_cents", { mode: "number" }).notNull().default(0),
    overrideWeightedCents: bigint("override_weighted_cents", { mode: "number" }).notNull().default(0),
  },
  (t) => [uniqueIndex("snapshot_uq").on(t.takenOn, t.pipelineKey, t.stageKey)],
);

export const agentRuns = rso.table(
  "agent_runs",
  {
    id: id(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    kind: text("kind").notNull(), // chat | email_analysis | transcript_analysis | sweep | prep | summary
    model: text("model"),
    input: jsonb("input"),
    toolCalls: jsonb("tool_calls"),
    output: jsonb("output"),
    costUsd: doublePrecision("cost_usd"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("agent_runs_user_idx").on(t.userId, t.createdAt)],
);
