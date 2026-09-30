import "server-only";
import { and, asc, desc, eq, exists, gte, ilike, inArray, isNull, lte, not, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { untrusted } from "@/lib/ai";
import { dealValue } from "@/lib/pipeline-math";
import type { Role } from "@/lib/rbac/model";
import { dealAccessWhere, getHiddenFields, ownedEntityWhere, scopeFor, type AppUser } from "@/lib/rbac/server";
import { clip, isUuid, looksLikeInjection } from "./guards";
import { aggregatePipeline, type ReportDealRow } from "./report";
import { dealRiskReasons } from "./risk";
import type { PipelineReport, RecordRef } from "./types";

/* ───────────── run state (per chat request) ───────────── */

export type ToolCallLog = { name: string; input: unknown; ok: boolean; ms: number; note?: string };
export type RunState = { toolCalls: ToolCallLog[]; untrustedSeen: boolean; injectionFlags: number; denied: { entity: string; id: string; tool: string }[] };
export const newRunState = (): RunState => ({ toolCalls: [], untrustedSeen: false, injectionFlags: 0, denied: [] });

export async function logDenied(user: AppUser, run: RunState | null, tool: string, entity: string, id: string) {
  run?.denied.push({ entity, id, tool });
  try {
    await audit({ actorId: user.id, actorKind: "agent", action: "copilot.access_denied", entity, entityId: id.slice(0, 64), after: { tool } });
  } catch {
    /* audit must not break chat */
  }
}

/* ───────────── field security ───────────── */

/** Deal fields hidden for a role = code defaults ∪ admin overrides in field_permissions (shared rbac helper). */
export async function hiddenDealFields(role: Role): Promise<Set<string>> {
  return getHiddenFields(role, "deal");
}

function accountRestrictedOk(user: AppUser): SQL {
  if (user.role === "super_admin") return sql`true`;
  return or(
    eq(s.accounts.restricted, false),
    exists(
      db
        .select({ x: sql`1` })
        .from(s.restrictedAccess)
        .where(and(eq(s.restrictedAccess.entity, "account"), eq(s.restrictedAccess.entityId, s.accounts.id), eq(s.restrictedAccess.userId, user.id))),
    ),
  )!;
}

async function accountWhere(user: AppUser): Promise<SQL> {
  return and(await ownedEntityWhere(user, "accounts", "view", s.accounts.ownerId), isNull(s.accounts.deletedAt), accountRestrictedOk(user))!;
}

async function contactWhere(user: AppUser): Promise<SQL> {
  return and(await ownedEntityWhere(user, "contacts", "view", s.contacts.ownerId), isNull(s.contacts.deletedAt))!;
}

const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;
const dealHref = (id: string) => `/deals/${id}`;
const accountHref = (id: string) => `/accounts/${id}`;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/* ───────────── deal value helper ───────────── */

type ValueRow = {
  unit: "muu" | "usd" | "activation";
  muu: number | null;
  usdPerMuu: number | null;
  pipelineUsdPerMuu: number;
  revSharePct: number | null;
  pipelineRevSharePct: number | null;
  contractValueCents: number | null;
  annualizedValueCents: number | null;
  stageProbability: number;
  probabilityOverride: number | null;
  overrideStatus: string | null;
};

function valueSummary(r: ValueRow, hidden: Set<string>) {
  const v = dealValue({ ...r, revSharePct: hidden.has("revSharePct") ? null : r.revSharePct });
  const round = (n: number) => Math.round(n);
  return {
    unit: r.unit,
    muu: r.unit === "activation" ? null : v.muu,
    grossUsd: round(v.grossUsd),
    netUsd: round(v.netUsd),
    weightedGrossUsd: round(v.weightedGrossUsd),
    weightedNetUsd: round(v.weightedNetUsd),
    probability: v.probability,
    probabilityOverridden: v.overridden,
    basisNote:
      r.unit === "muu"
        ? `gross = MUU × $/MUU (annual); net = RTB share${hidden.has("revSharePct") ? " (pipeline default — deal terms hidden for your role)" : ""}`
        : r.unit === "usd"
          ? "gross = net = annualized (or contract) value"
          : "activation pipeline — counts live accounts, no $ value",
  };
}

const dealBaseSelect = {
  id: s.deals.id,
  name: s.deals.name,
  status: s.deals.status,
  priority: s.deals.priority,
  restricted: s.deals.restricted,
  ownerId: s.deals.ownerId,
  ownerName: s.user.name,
  accountId: s.deals.accountId,
  accountName: s.accounts.name,
  pipelineKey: s.pipelines.key,
  pipelineName: s.pipelines.name,
  unit: s.pipelines.unit,
  pipelineUsdPerMuu: s.pipelines.usdPerMuu,
  pipelineRevSharePct: s.pipelines.defaultRevSharePct,
  stageKey: s.stages.key,
  stageName: s.stages.name,
  stageSort: s.stages.sortOrder,
  stageCategory: s.stages.category,
  stageProbability: s.stages.probability,
  slaDays: s.stages.slaDays,
  stageEnteredAt: s.deals.stageEnteredAt,
  lastActivityAt: s.deals.lastActivityAt,
  nextStep: s.deals.nextStep,
  nextStepDueAt: s.deals.nextStepDueAt,
  expectedCloseDate: s.deals.expectedCloseDate,
  healthScore: s.deals.healthScore,
  muu: s.deals.muu,
  usdPerMuu: s.deals.usdPerMuu,
  revSharePct: s.deals.revSharePct,
  contractValueCents: s.deals.contractValueCents,
  annualizedValueCents: s.deals.annualizedValueCents,
  probabilityOverride: s.deals.probabilityOverride,
  overrideStatus: s.deals.overrideStatus,
};

function dealBaseQuery() {
  return db
    .select(dealBaseSelect)
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .leftJoin(s.user, eq(s.user.id, s.deals.ownerId));
}

type DealBaseRow = Awaited<ReturnType<ReturnType<typeof dealBaseQuery>["where"]>>[number];

function dealListItem(d: DealBaseRow, hidden: Set<string>) {
  return {
    id: d.id,
    name: d.name,
    href: dealHref(d.id),
    pipeline: d.pipelineKey,
    stage: d.stageName,
    status: d.status,
    priority: d.priority,
    owner: d.ownerName,
    account: d.accountName,
    nextStep: d.nextStep,
    nextStepDueAt: iso(d.nextStepDueAt),
    lastActivityAt: iso(d.lastActivityAt),
    value: valueSummary({ ...d, pipelineUsdPerMuu: d.pipelineUsdPerMuu ?? 1 }, hidden),
  };
}

/* ───────────── search ───────────── */

export async function searchRecords(user: AppUser, run: RunState | null, query: string, types: ("deal" | "account" | "contact")[]) {
  const q = query.trim().slice(0, 100);
  if (q.length < 2) return { results: [] as (RecordRef & { subtitle?: string })[], note: "Query too short." };
  const like = likeOf(q);
  const want = new Set(types.length ? types : ["deal", "account", "contact"]);
  const [dealWhere, accWhere, conWhere] = await Promise.all([dealAccessWhere(user, "view"), accountWhere(user), contactWhere(user)]);

  const [deals, accounts, contacts] = await Promise.all([
    want.has("deal")
      ? db
          .select({ id: s.deals.id, name: s.deals.name, pipeline: s.pipelines.key, stage: s.stages.name, account: s.accounts.name })
          .from(s.deals)
          .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
          .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
          .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
          .where(and(dealWhere, or(ilike(s.deals.name, like), ilike(s.accounts.name, like), ilike(s.accounts.domain, like))))
          .orderBy(desc(s.deals.updatedAt))
          .limit(10)
      : Promise.resolve([]),
    want.has("account")
      ? db
          .select({ id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain, lifecycle: s.accounts.lifecycle })
          .from(s.accounts)
          .where(and(accWhere, or(ilike(s.accounts.name, like), ilike(s.accounts.domain, like))))
          .limit(8)
      : Promise.resolve([]),
    want.has("contact")
      ? db
          .select({ id: s.contacts.id, name: s.contacts.fullName, title: s.contacts.title, email: s.contacts.email, account: s.accounts.name })
          .from(s.contacts)
          .leftJoin(s.accounts, eq(s.accounts.id, s.contacts.accountId))
          .where(and(conWhere, or(ilike(s.contacts.fullName, like), ilike(s.contacts.email, like))))
          .limit(8)
      : Promise.resolve([]),
  ]);

  const results: (RecordRef & { subtitle?: string })[] = [
    ...deals.map((d) => ({ type: "deal" as const, id: d.id, name: d.name, href: dealHref(d.id), subtitle: `${d.pipeline} · ${d.stage}${d.account ? ` · ${d.account}` : ""}` })),
    ...accounts.map((a) => ({ type: "account" as const, id: a.id, name: a.name, href: accountHref(a.id), subtitle: [a.domain, a.lifecycle].filter(Boolean).join(" · ") })),
    ...contacts.map((c) => ({ type: "contact" as const, id: c.id, name: c.name, href: `/contacts/${c.id}`, subtitle: [c.title, c.account].filter(Boolean).join(" · ") || undefined })),
  ];

  // Detect (without revealing) matches the user cannot see → log the denied attempt (PRD AT-07).
  if (want.has("deal")) {
    const [hidden] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.deals)
      .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
      .where(and(isNull(s.deals.deletedAt), not(dealWhere), or(ilike(s.deals.name, like), ilike(s.accounts.name, like))));
    if ((hidden?.n ?? 0) > 0) await logDenied(user, run, "search_records", "deal", `query:${q}`);
  }

  return {
    results,
    note: results.length
      ? undefined
      : "No accessible records matched. If a matching record exists outside your permissions (or is restricted), Copilot cannot access or describe it.",
  };
}

/* ───────────── find deals (structured filters) ───────────── */

export async function findDeals(
  user: AppUser,
  f: {
    pipelineKey?: string;
    priority?: "top10" | "high" | "medium" | "low";
    stageKey?: string;
    status?: "open" | "won" | "lost" | "hold" | "any";
    owner?: "mine" | "visible";
    noMeetingWithinDays?: number;
    staleDays?: number;
    closingWithinDays?: number;
    minMuu?: number;
    limit?: number;
  },
) {
  const dealWhere = await dealAccessWhere(user, "view");
  const conds: SQL[] = [dealWhere];
  if (f.pipelineKey) conds.push(eq(s.pipelines.key, f.pipelineKey.toUpperCase()));
  if (f.priority) conds.push(eq(s.deals.priority, f.priority));
  if (f.stageKey) conds.push(eq(s.stages.key, f.stageKey));
  if (f.status && f.status !== "any") conds.push(eq(s.deals.status, f.status));
  else if (!f.status) conds.push(eq(s.deals.status, "open"));
  if (f.owner === "mine")
    conds.push(
      or(
        eq(s.deals.ownerId, user.id),
        exists(db.select({ x: sql`1` }).from(s.dealSplits).where(and(eq(s.dealSplits.dealId, s.deals.id), eq(s.dealSplits.userId, user.id)))),
      )!,
    );
  const now = new Date();
  if (f.noMeetingWithinDays) {
    const from = new Date(now.getTime() - f.noMeetingWithinDays * 86_400_000);
    const to = new Date(now.getTime() + f.noMeetingWithinDays * 86_400_000);
    conds.push(
      not(
        exists(
          db
            .select({ x: sql`1` })
            .from(s.meetings)
            .where(and(eq(s.meetings.dealId, s.deals.id), gte(s.meetings.startsAt, from), lte(s.meetings.startsAt, to))),
        ),
      ),
    );
  }
  if (f.staleDays) {
    const cutoff = new Date(now.getTime() - f.staleDays * 86_400_000);
    conds.push(or(isNull(s.deals.lastActivityAt), lte(s.deals.lastActivityAt, cutoff))!);
  }
  if (f.closingWithinDays) conds.push(and(gte(s.deals.expectedCloseDate, now), lte(s.deals.expectedCloseDate, new Date(now.getTime() + f.closingWithinDays * 86_400_000)))!);
  if (f.minMuu) conds.push(gte(s.deals.muu, f.minMuu));
  const rows = await dealBaseQuery()
    .where(and(...conds))
    .orderBy(asc(sql`case ${s.deals.priority} when 'top10' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end`), desc(s.deals.muu))
    .limit(Math.min(f.limit ?? 25, 50));
  const hidden = await hiddenDealFields(user.role);
  const ids = rows.map((r) => r.id);
  const meetings = ids.length
    ? await db
        .select({ dealId: s.meetings.dealId, startsAt: s.meetings.startsAt })
        .from(s.meetings)
        .where(and(inArray(s.meetings.dealId, ids)))
        .orderBy(desc(s.meetings.startsAt))
    : [];
  const lastMeeting = new Map<string, { last: Date | null; next: Date | null }>();
  for (const m of meetings) {
    if (!m.dealId || !m.startsAt) continue;
    const e = lastMeeting.get(m.dealId) ?? { last: null, next: null };
    if (m.startsAt <= now) e.last = e.last && e.last > m.startsAt ? e.last : m.startsAt;
    else e.next = e.next && e.next < m.startsAt ? e.next : m.startsAt;
    lastMeeting.set(m.dealId, e);
  }
  return {
    count: rows.length,
    filters: f,
    deals: rows.map((r) => ({
      ...dealListItem(r, hidden),
      lastMeetingAt: iso(lastMeeting.get(r.id)?.last),
      nextMeetingAt: iso(lastMeeting.get(r.id)?.next),
    })),
  };
}

/* ───────────── get deal ───────────── */

export async function getDealDetail(user: AppUser, run: RunState | null, id: string) {
  if (!isUuid(id)) return { error: "Invalid deal id — use search_records to find the deal first." };
  const dealWhere = await dealAccessWhere(user, "view");
  const [d] = await dealBaseQuery().where(and(dealWhere, eq(s.deals.id, id)));
  if (!d) {
    await logDenied(user, run, "get_deal", "deal", id);
    return { error: "Deal not found or outside your access. Copilot cannot share it." };
  }
  const [extra] = await db
    .select({
      guaranteeType: s.deals.guaranteeType,
      guaranteeMonthlyCents: s.deals.guaranteeMonthlyCents,
      rampMonths: s.deals.rampMonths,
      termYears: s.deals.termYears,
      nextPaymentCents: s.deals.nextPaymentCents,
      nextPaymentAt: s.deals.nextPaymentAt,
      renewalAt: s.deals.renewalAt,
      tags: s.deals.tags,
      customFields: s.deals.customFields,
      source: s.deals.source,
      aiSummary: s.deals.aiSummary,
      aiSummaryAt: s.deals.aiSummaryAt,
      healthExplanation: s.deals.healthExplanation,
      holdReason: s.deals.holdReason,
      lostReason: s.deals.lostReason,
      primaryContactId: s.deals.primaryContactId,
      r100: s.deals.r100,
    })
    .from(s.deals)
    .where(eq(s.deals.id, id));
  const hidden = await hiddenDealFields(user.role);
  const [tasks, stakeholders, meetings] = await Promise.all([
    db
      .select({ id: s.tasks.id, title: s.tasks.title, dueAt: s.tasks.dueAt, owedBy: s.tasks.owedBy, origin: s.tasks.origin, assignee: s.user.name, evidence: s.tasks.evidence })
      .from(s.tasks)
      .leftJoin(s.user, eq(s.user.id, s.tasks.assigneeId))
      .where(and(eq(s.tasks.dealId, id), eq(s.tasks.status, "open")))
      .orderBy(asc(s.tasks.dueAt))
      .limit(15),
    db
      .select({ id: s.contacts.id, name: s.contacts.fullName, title: s.contacts.title, email: s.contacts.email, role: s.dealContacts.role, lastContactedAt: s.contacts.lastContactedAt, doNotContact: s.contacts.doNotContact })
      .from(s.dealContacts)
      .innerJoin(s.contacts, eq(s.contacts.id, s.dealContacts.contactId))
      .where(and(eq(s.dealContacts.dealId, id), isNull(s.contacts.deletedAt)))
      .limit(20),
    db
      .select({ id: s.meetings.id, title: s.meetings.title, startsAt: s.meetings.startsAt })
      .from(s.meetings)
      .where(and(eq(s.meetings.dealId, id), gte(s.meetings.startsAt, new Date(Date.now() - 30 * 86_400_000))))
      .orderBy(asc(s.meetings.startsAt))
      .limit(6),
  ]);
  const terms: Record<string, unknown> = {
    revSharePct: d.revSharePct,
    guaranteeType: extra?.guaranteeType ?? null,
    guaranteeMonthlyUsd: extra?.guaranteeMonthlyCents != null ? extra.guaranteeMonthlyCents / 100 : null,
    rampMonths: extra?.rampMonths ?? null,
    termYears: extra?.termYears ?? null,
  };
  const termField: Record<string, string> = { guaranteeMonthlyUsd: "guaranteeMonthlyCents" };
  for (const k of Object.keys(terms)) if (hidden.has(termField[k] ?? k)) delete terms[k];

  const untrustedParts: string[] = [];
  if (extra?.aiSummary) untrustedParts.push(`AI summary (${iso(extra.aiSummaryAt) ?? "undated"}):\n${clip(extra.aiSummary, 1500)}`);
  const evid = tasks.filter((t) => t.evidence).map((t) => `Task "${t.title}" evidence: ${clip(t.evidence, 300)}`);
  untrustedParts.push(...evid);

  return {
    id: d.id,
    name: d.name,
    href: dealHref(d.id),
    restricted: d.restricted,
    pipeline: { key: d.pipelineKey, name: d.pipelineName, unit: d.unit },
    stage: { key: d.stageKey, name: d.stageName, category: d.stageCategory, probability: d.stageProbability, enteredAt: iso(d.stageEnteredAt), slaDays: d.slaDays },
    status: d.status,
    priority: d.priority,
    owner: d.ownerName,
    account: d.accountId ? { id: d.accountId, name: d.accountName, href: accountHref(d.accountId) } : null,
    expectedCloseDate: iso(d.expectedCloseDate),
    nextStep: d.nextStep,
    nextStepDueAt: iso(d.nextStepDueAt),
    lastActivityAt: iso(d.lastActivityAt),
    health: { score: d.healthScore, explanation: extra?.healthExplanation ?? null },
    value: valueSummary({ ...d, pipelineUsdPerMuu: d.pipelineUsdPerMuu ?? 1 }, hidden),
    contractValueUsd: d.contractValueCents != null ? d.contractValueCents / 100 : null,
    annualizedValueUsd: d.annualizedValueCents != null ? d.annualizedValueCents / 100 : null,
    terms,
    hiddenFields: [...hidden],
    holdReason: extra?.holdReason ?? null,
    lostReason: extra?.lostReason ?? null,
    tags: extra?.tags ?? [],
    customFields: extra?.customFields ?? {},
    r100: d.pipelineKey === "R100" ? (extra?.r100 ?? {}) : undefined,
    openTasks: tasks.map((t) => ({ id: t.id, title: t.title, dueAt: iso(t.dueAt), owedBy: t.owedBy, origin: t.origin, assignee: t.assignee })),
    stakeholders: stakeholders.map((c) => ({ id: c.id, name: c.name, title: c.title, email: c.email, role: c.role, lastContactedAt: iso(c.lastContactedAt), doNotContact: c.doNotContact, href: `/contacts/${c.id}` })),
    primaryContactId: extra?.primaryContactId ?? null,
    meetings: meetings.map((m) => ({ id: m.id, title: m.title, startsAt: iso(m.startsAt) })),
    notesAndSummaries: untrustedParts.length ? untrusted(`deal:${d.id}:summaries`, untrustedParts.join("\n\n"), 6000) : null,
  };
}

/* ───────────── get account ───────────── */

export async function getAccountDetail(user: AppUser, run: RunState | null, id: string) {
  if (!isUuid(id)) return { error: "Invalid account id — use search_records to find the account first." };
  const accWhere = await accountWhere(user);
  const [a] = await db
    .select({
      id: s.accounts.id,
      name: s.accounts.name,
      domain: s.accounts.domain,
      type: s.accounts.type,
      category: s.accounts.category,
      country: s.accounts.country,
      language: s.accounts.language,
      ownership: s.accounts.ownership,
      ticker: s.accounts.ticker,
      lifecycle: s.accounts.lifecycle,
      priority: s.accounts.priority,
      owner: s.user.name,
      muu: s.accounts.muu,
      muuSource: s.accounts.muuSource,
      muuConfidence: s.accounts.muuConfidence,
      monthlyVisits: s.accounts.monthlyVisits,
      techStack: s.accounts.techStack,
      fitScore: s.accounts.fitScore,
      fitExplanation: s.accounts.fitExplanation,
      doNotContact: s.accounts.doNotContact,
      notes: s.accounts.notes,
      restricted: s.accounts.restricted,
    })
    .from(s.accounts)
    .leftJoin(s.user, eq(s.user.id, s.accounts.ownerId))
    .where(and(accWhere, eq(s.accounts.id, id)));
  if (!a) {
    await logDenied(user, run, "get_account", "account", id);
    return { error: "Account not found or outside your access. Copilot cannot share it." };
  }
  const [dealWhere, conWhere, hidden] = await Promise.all([dealAccessWhere(user, "view"), contactWhere(user), hiddenDealFields(user.role)]);
  const [deals, contacts, tasks] = await Promise.all([
    dealBaseQuery().where(and(dealWhere, eq(s.deals.accountId, id))).limit(20),
    db
      .select({ id: s.contacts.id, name: s.contacts.fullName, title: s.contacts.title, email: s.contacts.email, lastContactedAt: s.contacts.lastContactedAt, doNotContact: s.contacts.doNotContact })
      .from(s.contacts)
      .where(and(conWhere, eq(s.contacts.accountId, id)))
      .limit(25),
    db
      .select({ id: s.tasks.id, title: s.tasks.title, dueAt: s.tasks.dueAt, owedBy: s.tasks.owedBy, assignee: s.user.name })
      .from(s.tasks)
      .leftJoin(s.user, eq(s.user.id, s.tasks.assigneeId))
      .where(and(eq(s.tasks.accountId, id), eq(s.tasks.status, "open")))
      .limit(10),
  ]);
  const { notes, ...rest } = a;
  return {
    ...rest,
    href: accountHref(a.id),
    deals: deals.map((d) => dealListItem(d, hidden)),
    dealsNote: "Only deals the user can access are listed; others (e.g. restricted or other pipelines) are omitted — do not infer that none exist.",
    contacts: contacts.map((c) => ({ ...c, lastContactedAt: iso(c.lastContactedAt), href: `/contacts/${c.id}` })),
    openTasks: tasks.map((t) => ({ ...t, dueAt: iso(t.dueAt) })),
    notes: notes ? untrusted(`account:${a.id}:notes`, clip(notes, 3000)) : null,
  };
}

/* ───────────── timeline ───────────── */

const EXTERNAL_SOURCES = new Set(["gmail", "zoom", "granola", "meet", "upload", "import", "calendar"]);

export async function getTimeline(user: AppUser, run: RunState | null, opts: { dealId?: string; accountId?: string; limit?: number }) {
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 40);
  let parent: { entity: "deal" | "account"; id: string; ownerId: string | null } | null = null;
  if (opts.dealId) {
    if (!isUuid(opts.dealId)) return { error: "Invalid deal id." };
    const [d] = await db.select({ id: s.deals.id, ownerId: s.deals.ownerId }).from(s.deals).where(and(await dealAccessWhere(user, "view"), eq(s.deals.id, opts.dealId)));
    if (!d) {
      await logDenied(user, run, "get_timeline", "deal", opts.dealId);
      return { error: "Deal not found or outside your access." };
    }
    parent = { entity: "deal", id: d.id, ownerId: d.ownerId };
  } else if (opts.accountId) {
    if (!isUuid(opts.accountId)) return { error: "Invalid account id." };
    const [a] = await db.select({ id: s.accounts.id, ownerId: s.accounts.ownerId }).from(s.accounts).where(and(await accountWhere(user), eq(s.accounts.id, opts.accountId)));
    if (!a) {
      await logDenied(user, run, "get_timeline", "account", opts.accountId);
      return { error: "Account not found or outside your access." };
    }
    parent = { entity: "account", id: a.id, ownerId: a.ownerId };
  } else return { error: "Provide dealId or accountId." };

  // activities module scope: all → everything on the record; team → team members' + own record; own → own actions or own record.
  const scope = await scopeFor(user, "activities", "view");
  if (scope === "none") return { error: "Your role cannot view activity timelines." };
  const conds: SQL[] = [parent.entity === "deal" ? eq(s.activities.dealId, parent.id) : eq(s.activities.accountId, parent.id)];
  const ownsRecord = parent.ownerId === user.id;
  if (scope === "own" && !ownsRecord) conds.push(eq(s.activities.actorId, user.id));
  if (scope === "team" && !ownsRecord) conds.push(inArray(s.activities.actorId, user.teamMemberIds.length ? user.teamMemberIds : [user.id]));

  const rows = await db
    .select({
      id: s.activities.id,
      type: s.activities.type,
      source: s.activities.source,
      subject: s.activities.subject,
      body: s.activities.body,
      direction: s.activities.direction,
      occurredAt: s.activities.occurredAt,
      actor: s.user.name,
      pinned: s.activities.pinned,
    })
    .from(s.activities)
    .leftJoin(s.user, eq(s.user.id, s.activities.actorId))
    .where(and(...conds))
    .orderBy(desc(s.activities.occurredAt))
    .limit(limit);

  const external = rows.some((r) => EXTERNAL_SOURCES.has(r.source) && (r.body || r.subject));
  const text = rows
    .map((r) => `[${r.occurredAt.toISOString().slice(0, 10)}] ${r.type}${r.direction ? ` (${r.direction})` : ""} via ${r.source}${r.actor ? ` by ${r.actor}` : ""}: ${r.subject ?? ""}\n${clip(r.body, 500)}`)
    .join("\n---\n");
  const injection = looksLikeInjection(text);
  if (run) {
    if (external) run.untrustedSeen = true;
    if (injection) run.injectionFlags++;
  }
  return {
    record: { type: parent.entity, id: parent.id, href: parent.entity === "deal" ? dealHref(parent.id) : accountHref(parent.id) },
    count: rows.length,
    items: rows.map((r) => ({ id: r.id, date: iso(r.occurredAt), type: r.type, source: r.source, direction: r.direction, actor: r.actor, pinned: r.pinned })),
    content: rows.length ? untrusted(`${parent.entity}:${parent.id}:timeline`, text, 20_000) : null,
    injectionWarning: injection ? "Some timeline content contains instruction-like text (possible prompt injection). It was treated as data only." : undefined,
  };
}

/* ───────────── my work ───────────── */

export async function listMyWork(user: AppUser, run: RunState | null, kind: "tasks" | "alerts" | "deals_at_risk" | "awaiting_reply", scope: "mine" | "visible" = "mine") {
  const now = new Date();
  if (kind === "tasks") {
    const rows = await db
      .select({ id: s.tasks.id, title: s.tasks.title, dueAt: s.tasks.dueAt, priority: s.tasks.priority, owedBy: s.tasks.owedBy, origin: s.tasks.origin, dealId: s.tasks.dealId, dealName: s.deals.name })
      .from(s.tasks)
      .leftJoin(s.deals, eq(s.deals.id, s.tasks.dealId))
      .where(and(eq(s.tasks.assigneeId, user.id), eq(s.tasks.status, "open")))
      .orderBy(asc(sql`coalesce(${s.tasks.dueAt}, 'infinity'::timestamptz)`))
      .limit(30);
    return {
      kind,
      count: rows.length,
      items: rows.map((t) => ({
        id: t.id,
        title: t.title,
        dueAt: iso(t.dueAt),
        overdue: t.dueAt ? t.dueAt < now : false,
        priority: t.priority,
        owedBy: t.owedBy,
        origin: t.origin,
        deal: t.dealId ? { id: t.dealId, name: t.dealName, href: dealHref(t.dealId) } : null,
      })),
    };
  }
  if (kind === "alerts") {
    const rows = await db
      .select({ id: s.alerts.id, ruleCode: s.alerts.ruleCode, severity: s.alerts.severity, title: s.alerts.title, detail: s.alerts.detail, suggestedAction: s.alerts.suggestedAction, entity: s.alerts.entity, entityId: s.alerts.entityId, state: s.alerts.state, createdAt: s.alerts.createdAt })
      .from(s.alerts)
      .where(and(eq(s.alerts.recipientId, user.id), inArray(s.alerts.state, ["open", "acknowledged", "escalated"])))
      .orderBy(desc(s.alerts.createdAt))
      .limit(30);
    return {
      kind,
      count: rows.length,
      items: rows.map((a) => ({ ...a, createdAt: iso(a.createdAt), href: a.entity === "deal" ? dealHref(a.entityId) : a.entity === "account" ? accountHref(a.entityId) : "/tasks?tab=alerts" })),
    };
  }
  if (kind === "awaiting_reply") {
    const rows = await db
      .select({ id: s.emailThreads.id, subject: s.emailThreads.subject, snippet: s.emailThreads.snippet, lastMessageAt: s.emailThreads.lastMessageAt, dealId: s.emailThreads.dealId, participants: s.emailThreads.participants })
      .from(s.emailThreads)
      .where(and(eq(s.emailThreads.mailboxUserId, user.id), eq(s.emailThreads.awaitingReplyFrom, "us")))
      .orderBy(asc(s.emailThreads.lastMessageAt))
      .limit(20);
    if (rows.length && run) run.untrustedSeen = true;
    const text = rows.map((r) => `${r.subject ?? "(no subject)"} — ${clip(r.snippet, 200)}`).join("\n");
    if (run && looksLikeInjection(text)) run.injectionFlags++;
    return {
      kind,
      count: rows.length,
      items: rows.map((r) => ({ id: r.id, lastMessageAt: iso(r.lastMessageAt), waitingHours: r.lastMessageAt ? Math.round((now.getTime() - r.lastMessageAt.getTime()) / 3_600_000) : null, participants: r.participants.slice(0, 5), deal: r.dealId ? { id: r.dealId, href: dealHref(r.dealId) } : null })),
      content: rows.length ? untrusted("inbox:awaiting_reply", text, 6000) : null,
    };
  }
  // deals_at_risk
  const dealWhere = await dealAccessWhere(user, "view");
  const conds: SQL[] = [dealWhere, eq(s.deals.status, "open")];
  if (scope === "mine")
    conds.push(
      or(
        eq(s.deals.ownerId, user.id),
        exists(db.select({ x: sql`1` }).from(s.dealSplits).where(and(eq(s.dealSplits.dealId, s.deals.id), eq(s.dealSplits.userId, user.id)))),
      )!,
    );
  const rows = await dealBaseQuery().where(and(...conds)).limit(400);
  const hidden = await hiddenDealFields(user.role);
  const risky = rows
    .map((r) => ({ r, reasons: dealRiskReasons(r, now) }))
    .filter((x) => x.reasons.length)
    .sort((a, b) => b.reasons.length - a.reasons.length || (b.r.muu ?? 0) - (a.r.muu ?? 0))
    .slice(0, 25);
  return {
    kind,
    scope,
    openDealsChecked: rows.length,
    count: risky.length,
    items: risky.map(({ r, reasons }) => ({ ...dealListItem(r, hidden), reasons })),
  };
}

/* ───────────── pipeline report ───────────── */

export async function pipelineReport(
  user: AppUser,
  opts: { pipelineKey?: string | null; groupBy: "stage" | "owner" | "category"; basis: "gross" | "net"; includeOverrides: boolean; status?: "open" | "all"; owner?: "mine" | "visible" },
): Promise<PipelineReport> {
  const dealWhere = await dealAccessWhere(user, "view");
  const status = opts.status ?? (opts.groupBy === "category" ? "all" : "open");
  const conds: SQL[] = [dealWhere];
  if (opts.pipelineKey) conds.push(eq(s.pipelines.key, opts.pipelineKey.toUpperCase()));
  if (status === "open") conds.push(inArray(s.deals.status, ["open"]));
  if (opts.owner === "mine") conds.push(eq(s.deals.ownerId, user.id));
  const rows = await dealBaseQuery().where(and(...conds));
  const hidden = await hiddenDealFields(user.role);
  const input: ReportDealRow[] = rows.map((r) => ({
    pipelineKey: r.pipelineKey,
    unit: r.unit,
    stageName: r.stageName,
    stageSort: r.stageSort,
    stageCategory: r.stageCategory,
    stageProbability: r.stageProbability,
    ownerName: r.ownerName,
    muu: r.muu,
    usdPerMuu: r.usdPerMuu,
    pipelineUsdPerMuu: r.pipelineUsdPerMuu,
    revSharePct: r.revSharePct,
    pipelineRevSharePct: r.pipelineRevSharePct,
    contractValueCents: r.contractValueCents,
    annualizedValueCents: r.annualizedValueCents,
    probabilityOverride: r.probabilityOverride,
    overrideStatus: r.overrideStatus,
  }));
  return aggregatePipeline(input, {
    basis: opts.basis,
    groupBy: opts.groupBy,
    includeOverrides: opts.includeOverrides,
    pipelineKey: opts.pipelineKey ? opts.pipelineKey.toUpperCase() : null,
    status,
    revShareHidden: hidden.has("revSharePct"),
  });
}

/* ───────────── small lookups for other modules ───────────── */

/** Accessible deal (view) with pipeline/stage — used by suggestions and actions. */
export async function loadAccessibleDeal(user: AppUser, id: string, action: "view" | "edit" = "view") {
  if (!isUuid(id)) return null;
  const [d] = await db
    .select({
      id: s.deals.id,
      name: s.deals.name,
      ownerId: s.deals.ownerId,
      teamId: s.deals.teamId,
      pipelineId: s.deals.pipelineId,
      pipelineKey: s.pipelines.key,
      stageId: s.deals.stageId,
      stageKey: s.stages.key,
      stageName: s.stages.name,
      status: s.deals.status,
      muu: s.deals.muu,
      revSharePct: s.deals.revSharePct,
      primaryContactId: s.deals.primaryContactId,
      contractValueCents: s.deals.contractValueCents,
      annualizedValueCents: s.deals.annualizedValueCents,
      expectedCloseDate: s.deals.expectedCloseDate,
      guaranteeType: s.deals.guaranteeType,
      termYears: s.deals.termYears,
      customFields: s.deals.customFields,
      accountId: s.deals.accountId,
    })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .where(and(await dealAccessWhere(user, action), eq(s.deals.id, id)));
  return d ?? null;
}

export async function accountAccessible(user: AppUser, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const [a] = await db.select({ id: s.accounts.id }).from(s.accounts).where(and(await accountWhere(user), eq(s.accounts.id, id)));
  return Boolean(a);
}

export async function stagesOfPipeline(pipelineId: string) {
  return db.select().from(s.stages).where(eq(s.stages.pipelineId, pipelineId)).orderBy(asc(s.stages.sortOrder));
}

export async function contactFlagsForEmails(user: AppUser, emails: string[]) {
  const list = emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return [];
  return db
    .select({ email: s.contacts.email, name: s.contacts.fullName, doNotContact: s.contacts.doNotContact, status: s.contacts.status })
    .from(s.contacts)
    .where(and(isNull(s.contacts.deletedAt), inArray(sql`lower(${s.contacts.email})`, list)));
}

export async function suppressed(values: string[]) {
  const list = values.map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return [];
  const domains = list.map((e) => e.split("@")[1]).filter((d): d is string => Boolean(d));
  return db
    .select({ value: s.suppressionList.value, kind: s.suppressionList.kind })
    .from(s.suppressionList)
    .where(inArray(s.suppressionList.value, [...list, ...domains]));
}

export async function userNames(ids: string[]) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map<string, string>();
  const rows = await db.select({ id: s.user.id, name: s.user.name }).from(s.user).where(inArray(s.user.id, uniq));
  return new Map(rows.map((r) => [r.id, r.name]));
}

