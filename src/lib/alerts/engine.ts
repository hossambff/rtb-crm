import "server-only";
import { and, count, eq, gte, inArray, isNotNull, isNull, lt, max, min, or, sql, sum, type SQL } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { env } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { getMatrix } from "@/lib/rbac/server";
import { ROLES, type Module, type Action, type Role } from "@/lib/rbac/model";
import { notify } from "@/lib/notifications/notify";
import {
  alertHref,
  alertKey,
  alertTriple,
  budgetThreshold,
  closeDatePassed,
  dataQualityGaps,
  docExpiring,
  docUnsigned,
  emailUnanswered,
  escalationDue,
  goLiveSlipped,
  healthCritical,
  highValueUnassigned,
  IMPLEMENTED_RULES,
  invoiceOverdueTier,
  meetingNeedsNotes,
  migrationStalled,
  missingNextStep,
  nextStepOverdue,
  num,
  numList,
  ourCommitmentState,
  r100ParticipationLapsing,
  registrationExpiring,
  renewalTier,
  repInactive,
  snoozedTooOften,
  staleBeyondSla,
  theirCommitmentPassed,
  unpublishedInterviews,
  type RuleParams,
  type Severity,
} from "./rules";
import { businessDaysBetween, isBusinessDay } from "./time";

/* ───────────── Types ───────────── */

export type AlertCandidate = {
  ruleCode: string;
  entity: string;
  entityId: string;
  recipientId: string;
  severity?: Severity;
  title: string;
  detail?: string | null;
  suggestedAction?: string | null;
  /** "entity" (default): one alert per record per rule (PRD §12.2). "recipient": one per recipient (fan-out rules). */
  dedupe?: "entity" | "recipient";
};

type Rule = typeof s.alertRules.$inferSelect;
type U = {
  id: string;
  name: string;
  role: Role;
  managerId: string | null;
  teamId: string | null;
  timezone: string;
  workStartHour: number;
  workEndHour: number;
  createdAt: Date;
  active: boolean;
};

export type SweepStats = {
  evaluated: string[];
  failed: { rule: string; error: string }[];
  created: number;
  updated: number;
  resolved: number;
  reopened: number;
  escalated: number;
  notified: number;
  ms: number;
};

const OPEN_STATES = ["open", "acknowledged", "snoozed", "escalated"] as const;
const DEFAULT_TZ = "America/New_York";
const SALES_ROLES: Role[] = ["ae", "sdr", "intern", "commission_rep"];

/* ───────────── Context ───────────── */

class Ctx {
  now = new Date();
  users = new Map<string, U>();
  teamLead = new Map<string, string | null>();
  private roleCache = new Map<string, string[]>();
  private openDealsP: Promise<OpenDeal[]> | null = null;

  async load() {
    const [users, teams] = await Promise.all([db.select().from(s.user), db.select({ id: s.teams.id, leadId: s.teams.leadId }).from(s.teams)]);
    for (const u of users) {
      const role = (ROLES as readonly string[]).includes(u.role) ? (u.role as Role) : "pending";
      this.users.set(u.id, {
        id: u.id,
        name: u.name,
        role,
        managerId: u.managerId,
        teamId: u.teamId,
        timezone: u.timezone ?? DEFAULT_TZ,
        workStartHour: u.workStartHour ?? 9,
        workEndHour: u.workEndHour ?? 18,
        createdAt: u.createdAt,
        active: role !== "pending" && !u.banned && (!u.accessExpiresAt || u.accessExpiresAt > this.now),
      });
    }
    for (const t of teams) this.teamLead.set(t.id, t.leadId);
  }

  tz(userId: string | null | undefined) {
    return (userId && this.users.get(userId)?.timezone) || DEFAULT_TZ;
  }
  isActive(userId: string | null | undefined): userId is string {
    return Boolean(userId && this.users.get(userId)?.active);
  }
  /** Manager for escalation: user.managerId, else the user's team lead. */
  managerOf(userId: string): string | null {
    const u = this.users.get(userId);
    if (!u) return null;
    if (u.managerId && u.managerId !== userId && this.isActive(u.managerId)) return u.managerId;
    const lead = u.teamId ? this.teamLead.get(u.teamId) : null;
    if (lead && lead !== userId && this.isActive(lead)) return lead;
    return null;
  }
  byRoles(roles: Role[]): string[] {
    const key = roles.join(",");
    let ids = this.roleCache.get(key);
    if (!ids) {
      ids = [...this.users.values()].filter((u) => u.active && roles.includes(u.role)).map((u) => u.id);
      this.roleCache.set(key, ids);
    }
    return ids;
  }
  /** Active users whose role has ≥ own scope on module/action (effective matrix incl. DB overrides). */
  async withPermission(module: Module, action: Action, minAll = false): Promise<string[]> {
    const roles: Role[] = [];
    for (const r of ROLES) {
      if (r === "pending") continue;
      const scope = (await getMatrix(r))[module]?.[action] ?? "none";
      if (scope === "none") continue;
      if (minAll && scope !== "all") continue;
      roles.push(r);
    }
    return this.byRoles(roles);
  }
  openDeals() {
    this.openDealsP ??= loadOpenDeals();
    return this.openDealsP;
  }
}

type OpenDeal = Awaited<ReturnType<typeof loadOpenDeals>>[number];

async function loadOpenDeals() {
  return db
    .select({
      id: s.deals.id,
      name: s.deals.name,
      ownerId: s.deals.ownerId,
      restricted: s.deals.restricted,
      priority: s.deals.priority,
      nextStep: s.deals.nextStep,
      nextStepDueAt: s.deals.nextStepDueAt,
      expectedCloseDate: s.deals.expectedCloseDate,
      stageEnteredAt: s.deals.stageEnteredAt,
      lastActivityAt: s.deals.lastActivityAt,
      healthScore: s.deals.healthScore,
      overrideStatus: s.deals.overrideStatus,
      probabilityOverride: s.deals.probabilityOverride,
      muu: s.deals.muu,
      contractValueCents: s.deals.contractValueCents,
      annualizedValueCents: s.deals.annualizedValueCents,
      primaryContactId: s.deals.primaryContactId,
      createdAt: s.deals.createdAt,
      stageName: s.stages.name,
      stageCategory: s.stages.category,
      slaDays: s.stages.slaDays,
      stageProbability: s.stages.probability,
      pipelineKey: s.pipelines.key,
      unit: s.pipelines.unit,
      contactEmailStatus: s.contacts.emailStatus,
    })
    .from(s.deals)
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .leftJoin(s.contacts, eq(s.contacts.id, s.deals.primaryContactId))
    .where(and(isNull(s.deals.deletedAt), eq(s.deals.status, "open")));
}

/** Title for a deal-scoped alert. Restricted (MNPI) deal names are never shown to non-owners. */
function dealLabel(d: { name: string; restricted: boolean; ownerId: string | null }, recipientId: string) {
  return d.restricted && d.ownerId !== recipientId ? "Restricted deal" : d.name;
}

/* ───────────── Rule evaluators ───────────── */

type Evaluator = (ctx: Ctx, rule: Rule) => Promise<AlertCandidate[]>;
const P = (r: Rule) => (r.params ?? {}) as RuleParams;

const EVALUATORS: Record<string, Evaluator> = {
  "NS-01": async (ctx, rule) =>
    (await ctx.openDeals())
      .filter((d) => d.stageCategory === "open" && ctx.isActive(d.ownerId) && missingNextStep(d))
      .map((d) => ({
        ruleCode: rule.code,
        entity: "deal",
        entityId: d.id,
        recipientId: d.ownerId!,
        title: `${d.name}: no next step`,
        detail: `${d.pipelineKey} · ${d.stageName} — ${!d.nextStep?.trim() ? "next step missing" : "next step has no due date"}.`,
        suggestedAction: "Set a next step and due date.",
      })),

  "NS-02": async (ctx, rule) =>
    (await ctx.openDeals())
      .filter((d) => ctx.isActive(d.ownerId) && nextStepOverdue(d, ctx.now))
      .map((d) => ({
        ruleCode: rule.code,
        entity: "deal",
        entityId: d.id,
        recipientId: d.ownerId!,
        title: `${d.name}: next step overdue`,
        detail: `"${d.nextStep ?? "Next step"}" was due ${d.nextStepDueAt!.toISOString().slice(0, 10)}.`,
        suggestedAction: "Do it, or move the date with a reason.",
      })),

  "NS-03": async (ctx, rule) => {
    const mode = P(rule).mode === "business" ? "business" : "calendar";
    const out: AlertCandidate[] = [];
    for (const d of await ctx.openDeals()) {
      if (!ctx.isActive(d.ownerId)) continue;
      const { stale, idleDays } = staleBeyondSla(d, d.slaDays, ctx.now, { tz: ctx.tz(d.ownerId), mode });
      if (!stale) continue;
      out.push({
        ruleCode: rule.code,
        entity: "deal",
        entityId: d.id,
        recipientId: d.ownerId!,
        title: `${d.name}: stale in ${d.stageName}`,
        detail: `No activity for ${idleDays} ${mode === "business" ? "business " : ""}days (stage SLA ${d.slaDays}d).`,
        suggestedAction: "Log a touch or move the stage.",
      });
    }
    return out;
  },

  "NS-04": async (ctx, rule) => {
    const hours = num(P(rule), "hours", await getSetting<number>("email.unanswered_hours", 24));
    const rows = await db
      .select({
        id: s.emailThreads.id,
        subject: s.emailThreads.subject,
        mailboxUserId: s.emailThreads.mailboxUserId,
        lastMessageAt: s.emailThreads.lastMessageAt,
        awaitingReplyFrom: s.emailThreads.awaitingReplyFrom,
        private: s.emailThreads.private,
      })
      .from(s.emailThreads)
      .where(
        and(
          eq(s.emailThreads.awaitingReplyFrom, "us"),
          lt(s.emailThreads.lastMessageAt, new Date(ctx.now.getTime() - hours * 3_600_000)),
          or(isNotNull(s.emailThreads.dealId), isNotNull(s.emailThreads.accountId)),
        ),
      );
    return rows
      .filter((t) => {
        const u = ctx.users.get(t.mailboxUserId);
        return u?.active && emailUnanswered(t, ctx.now, { hours, tz: u.timezone, startHour: u.workStartHour, endHour: u.workEndHour });
      })
      .map((t) => ({
        ruleCode: rule.code,
        entity: "email_thread",
        entityId: t.id,
        recipientId: t.mailboxUserId,
        title: `Unanswered: ${t.private ? "private thread" : (t.subject ?? "(no subject)")}`,
        detail: `Prospect email waiting on us for more than ${hours} business hours.`,
        suggestedAction: "Reply now — Copilot can draft it.",
      }));
  },

  "NS-05": async (ctx, rule) => {
    const rows = await openCommitments("us");
    const out: AlertCandidate[] = [];
    for (const t of rows) {
      if (!ctx.isActive(t.assigneeId)) continue;
      const state = ourCommitmentState(t, ctx.now, num(P(rule), "reminderDays", 1));
      if (!state) continue;
      out.push({
        ruleCode: rule.code,
        entity: "task",
        entityId: t.id,
        recipientId: t.assigneeId!,
        severity: state === "overdue" ? undefined : "info",
        title: `${state === "overdue" ? "Overdue commitment" : "Commitment due"}: ${t.title}`,
        detail: t.evidence ? `We said: “${t.evidence.slice(0, 240)}”` : null,
        suggestedAction: "Deliver it, or tell them the new date.",
      });
    }
    return out;
  },

  "NS-06": async (ctx, rule) => {
    const grace = num(P(rule), "graceDays", 2);
    return (await openCommitments("them"))
      .filter((t) => ctx.isActive(t.assigneeId) && theirCommitmentPassed(t, ctx.now, grace))
      .map((t) => ({
        ruleCode: rule.code,
        entity: "task",
        entityId: t.id,
        recipientId: t.assigneeId!,
        title: `They owe us: ${t.title}`,
        detail: t.evidence ? `They said: “${t.evidence.slice(0, 240)}”` : `Their promised action is ${grace}+ days overdue.`,
        suggestedAction: "Send a nudge — draft ready in Copilot.",
      }));
  },

  "NS-07": async (ctx, rule) => {
    const hours = num(P(rule), "hours", 2);
    const domains = await internalDomains();
    const since = new Date(ctx.now.getTime() - 14 * 86_400_000);
    const rows = await db
      .select({
        id: s.meetings.id,
        title: s.meetings.title,
        ownerId: s.meetings.ownerId,
        endsAt: s.meetings.endsAt,
        attendees: s.meetings.attendees,
        transcriptId: s.meetings.transcriptId,
        hasNotes: sql<boolean>`exists (select 1 from rso.activities a where a.meeting_id = ${s.meetings.id}
          or (a.deal_id = ${s.meetings.dealId} and a.type in ('meeting','note','call') and a.occurred_at >= ${s.meetings.startsAt}))`,
      })
      .from(s.meetings)
      .where(and(isNull(s.meetings.transcriptId), gte(s.meetings.endsAt, since), lt(s.meetings.endsAt, ctx.now)));
    return rows
      .filter((m) => ctx.isActive(m.ownerId) && meetingNeedsNotes(m, ctx.now, { hours, internalDomains: domains }))
      .map((m) => ({
        ruleCode: rule.code,
        entity: "meeting",
        entityId: m.id,
        recipientId: m.ownerId!,
        title: `No notes: ${m.title ?? "external meeting"}`,
        detail: `Meeting ended over ${hours}h ago with no transcript or notes.`,
        suggestedAction: "Upload the transcript or log quick notes.",
      }));
  },

  "NS-09": async (ctx, rule) =>
    (await ctx.openDeals())
      .filter((d) => ctx.isActive(d.ownerId) && closeDatePassed(d, ctx.now, num(P(rule), "graceDays", 1)))
      .map((d) => ({
        ruleCode: rule.code,
        entity: "deal",
        entityId: d.id,
        recipientId: d.ownerId!,
        title: `${d.name}: close date passed`,
        detail: `Expected close ${d.expectedCloseDate!.toISOString().slice(0, 10)}; deal still open in ${d.stageName}.`,
        suggestedAction: "Update the close date or the stage.",
      })),

  "NS-10": async (ctx, rule) => {
    const days = num(P(rule), "businessDays", 5);
    const docs = await docsWithOwners(eq(s.documents.status, "sent"));
    return docs
      .filter((d) => ctx.isActive(d.recipientId) && docUnsigned(d, ctx.now, { businessDays: days, tz: ctx.tz(d.recipientId) }))
      .map((d) => ({
        ruleCode: rule.code,
        entity: d.dealId ? "deal" : "account",
        entityId: `${d.dealId ?? d.accountId}#doc:${d.id}`,
        recipientId: d.recipientId!,
        title: `Unsigned ${d.type.toUpperCase()}: ${d.restricted && d.dealOwnerId !== d.recipientId ? "restricted deal" : d.name}`,
        detail: `Sent ${days}+ business days ago and not signed.`,
        suggestedAction: "Chase the signature.",
      }));
  },

  "NS-11": async (ctx, rule) => {
    const days = num(P(rule), "days", 30);
    const docs = await docsWithOwners(isNotNull(s.documents.expiresAt));
    return docs
      .filter((d) => ctx.isActive(d.recipientId) && docExpiring(d, ctx.now, days))
      .map((d) => ({
        ruleCode: rule.code,
        entity: d.dealId ? "deal" : "account",
        entityId: `${d.dealId ?? d.accountId}#doc:${d.id}`,
        recipientId: d.recipientId!,
        title: `${d.type.toUpperCase()} expiring: ${d.name}`,
        detail: `Expires ${d.expiresAt!.toISOString().slice(0, 10)}.`,
        suggestedAction: "Start the renewal or extension.",
      }));
  },

  // Best effort: no health history table yet → fire on low absolute health (params.floor, default 40).
  "NS-12": async (ctx, rule) => {
    const floor = num(P(rule), "floor", 40);
    const out: AlertCandidate[] = [];
    for (const d of await ctx.openDeals()) {
      if (!ctx.isActive(d.ownerId) || !healthCritical(d.healthScore, floor)) continue;
      for (const r of [d.ownerId!, ctx.managerOf(d.ownerId!)]) {
        if (!r) continue;
        out.push({
          ruleCode: rule.code,
          entity: "deal",
          entityId: d.id,
          recipientId: r,
          dedupe: "recipient",
          title: `${dealLabel(d, r)}: health ${d.healthScore}`,
          detail: `Deal health is below ${floor}.`,
          suggestedAction: "Review risks and re-plan the next step.",
        });
      }
    }
    return out;
  },

  "NS-15": async (ctx, rule) => {
    const muuMin = num(P(rule), "muu", 10_000_000);
    const hours = num(P(rule), "hours", 4);
    const recipients = ctx.byRoles(["admin", "sales_leader"]);
    const out: AlertCandidate[] = [];
    for (const d of await ctx.openDeals()) {
      if (!highValueUnassigned(d, ctx.now, { muuMin, hours })) continue;
      for (const r of recipients) {
        if (d.restricted && ctx.users.get(r)?.role !== "super_admin") continue;
        out.push({
          ruleCode: rule.code,
          entity: "deal",
          entityId: d.id,
          recipientId: r,
          dedupe: "recipient",
          title: `Unassigned high-value lead: ${d.name}`,
          detail: `${d.pipelineKey} · ${d.muu ? `${Math.round(d.muu / 1e6)}M MUU` : (d.priority ?? "")} — no owner for ${hours}+ business hours.`,
          suggestedAction: "Assign an owner.",
        });
      }
    }
    return out;
  },

  "NS-16": async (ctx, rule) => {
    const days = num(P(rule), "days", 7);
    const rows = await db
      .select({ id: s.leadRegistrations.id, userId: s.leadRegistrations.userId, status: s.leadRegistrations.status, protectedUntil: s.leadRegistrations.protectedUntil, account: s.accounts.name })
      .from(s.leadRegistrations)
      .innerJoin(s.accounts, eq(s.accounts.id, s.leadRegistrations.accountId))
      .where(eq(s.leadRegistrations.status, "approved"));
    return rows
      .filter((r) => ctx.isActive(r.userId) && registrationExpiring(r, ctx.now, days))
      .map((r) => ({
        ruleCode: rule.code,
        entity: "lead_registration",
        entityId: r.id,
        recipientId: r.userId,
        title: `Registration expiring: ${r.account}`,
        detail: `Protection ends ${r.protectedUntil!.toISOString().slice(0, 10)}.`,
        suggestedAction: "Advance the deal or request an extension.",
      }));
    // TODO(data): conflict branch (two reps registering the same account) belongs to the Commissions module.
  },

  "NS-18": async (ctx, rule) => {
    let execs = ctx.byRoles(["executive"]);
    if (!execs.length) execs = ctx.byRoles(["super_admin"]);
    const out: AlertCandidate[] = [];
    const pending = (await ctx.openDeals()).filter((d) => d.overrideStatus === "pending");
    // Bulk overrides (AT-09) → one summary alert per approver instead of one per deal.
    const maxIndividual = num(P(rule), "maxIndividual", 5);
    if (pending.length > maxIndividual) {
      return execs.map((r) => ({
        ruleCode: rule.code,
        entity: "org",
        entityId: "probability_overrides",
        recipientId: r,
        dedupe: "recipient" as const,
        title: `${pending.length} probability overrides need approval`,
        detail: `Pending manual overrides across ${new Set(pending.map((d) => d.pipelineKey)).size} pipeline(s). Forecasts exclude them until approved.`,
        suggestedAction: "Review in Approvals.",
      }));
    }
    for (const d of pending) {
      for (const r of execs)
        out.push({
          ruleCode: rule.code,
          entity: "deal",
          entityId: d.id,
          recipientId: r,
          dedupe: "recipient",
          title: `Probability override needs approval: ${dealLabel(d, r)}`,
          detail: `Requested ${Math.round((d.probabilityOverride ?? 0) * 100)}% vs stage ${Math.round(d.stageProbability * 100)}%.`,
          suggestedAction: "Approve or reject in Approvals.",
        });
    }
    return out;
  },

  "NS-19": async (ctx, rule) => {
    const days = num(P(rule), "days", 10);
    return (await db.select().from(s.migrationProjects).where(eq(s.migrationProjects.launched, false)))
      .filter((p) => ctx.isActive(p.ownerId) && migrationStalled(p, ctx.now, days))
      .map((p) => ({
        ruleCode: rule.code,
        entity: "migration",
        entityId: p.id,
        recipientId: p.ownerId!,
        title: `Migration stalled: ${p.name}`,
        detail: `In "${p.stage}" for ${days}+ days.${p.blockers ? ` Blockers: ${p.blockers.slice(0, 160)}` : ""}`,
        suggestedAction: "Unblock or update the stage.",
      }));
  },

  "NS-20": async (ctx, rule) => {
    const rows = await db
      .select({ p: s.migrationProjects, dealOwnerId: s.deals.ownerId })
      .from(s.migrationProjects)
      .leftJoin(s.deals, eq(s.deals.id, s.migrationProjects.dealId))
      .where(and(eq(s.migrationProjects.launched, false), isNotNull(s.migrationProjects.targetGoLive)));
    const out: AlertCandidate[] = [];
    for (const { p, dealOwnerId } of rows) {
      if (!goLiveSlipped(p, ctx.now)) continue;
      for (const r of new Set([p.ownerId, dealOwnerId])) {
        if (!ctx.isActive(r)) continue;
        out.push({
          ruleCode: rule.code,
          entity: "migration",
          entityId: p.id,
          recipientId: r,
          dedupe: "recipient",
          title: `Go-live slipped: ${p.name}`,
          detail: `Target go-live was ${p.targetGoLive!.toISOString().slice(0, 10)}.`,
          suggestedAction: "Set a new date and tell the partner.",
        });
      }
    }
    return out;
  },

  "NS-21": async (ctx, rule) => {
    const rows = await db
      .select({ id: s.deals.id, name: s.deals.name, ownerId: s.deals.ownerId, r100: s.deals.r100 })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
      .where(and(isNull(s.deals.deletedAt), eq(s.pipelines.key, "R100"), eq(s.stages.category, "won")));
    return rows
      .filter((d) => ctx.isActive(d.ownerId) && r100ParticipationLapsing(d.r100, ctx.now, { tz: ctx.tz(d.ownerId), windowDays: num(P(rule), "windowDays", 7) }))
      .map((d) => ({
        ruleCode: rule.code,
        entity: "deal",
        entityId: `${d.id}#m${ctx.now.toISOString().slice(0, 7)}`,
        recipientId: d.ownerId!,
        title: `${d.name} hasn't posted this month`,
        detail: "RTB100 monthly participation is lapsing.",
        suggestedAction: "Send a participation nudge (draft ready).",
      }));
  },

  "NS-22": async (ctx, rule) => {
    const days = num(P(rule), "days", 14);
    const rows = await db
      .select({ id: s.deals.id, name: s.deals.name, ownerId: s.deals.ownerId, restricted: s.deals.restricted, customFields: s.deals.customFields })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .where(and(isNull(s.deals.deletedAt), eq(s.pipelines.key, "R100"), sql`${s.deals.customFields} ?| array['interviews','interview']`));
    const editorial = ctx.byRoles(["editorial"]);
    const out: AlertCandidate[] = [];
    for (const d of rows) {
      const recips = editorial.length ? editorial : ctx.isActive(d.ownerId) ? [d.ownerId!] : [];
      for (const iv of unpublishedInterviews(d.customFields, ctx.now, days))
        for (const r of recips)
          out.push({
            ruleCode: rule.code,
            entity: "deal",
            entityId: `${d.id}#iv:${iv.key}`,
            recipientId: r,
            dedupe: "recipient",
            title: `Interview unpublished: ${dealLabel(d, r)}${iv.guest ? ` (${iv.guest})` : ""}`,
            detail: `Filmed ${iv.filmedAt.toISOString().slice(0, 10)}, no publish date after ${days} days.`,
            suggestedAction: "Set a publish date.",
          });
    }
    return out;
  },

  "NS-23": async (ctx, rule) => {
    const tiers = numList(P(rule), "days", [1, 7, 14]).sort((a, b) => a - b);
    const rows = await db
      .select({ inv: s.invoices, dealName: s.deals.name, ownerId: s.deals.ownerId, restricted: s.deals.restricted })
      .from(s.invoices)
      .innerJoin(s.deals, eq(s.deals.id, s.invoices.dealId))
      .where(and(isNull(s.invoices.paidAt), inArray(s.invoices.status, ["scheduled", "sent", "overdue"]), lt(s.invoices.dueAt, ctx.now)));
    const finance = ctx.byRoles(["finance"]);
    const execs = ctx.byRoles(["executive"]);
    const out: AlertCandidate[] = [];
    for (const { inv, dealName, ownerId, restricted } of rows) {
      const tier = invoiceOverdueTier(inv, ctx.now, tiers);
      if (tier == null) continue;
      const recips = new Set<string>();
      if (ctx.isActive(ownerId)) recips.add(ownerId);
      if (tier >= (tiers[1] ?? 7)) finance.forEach((f) => recips.add(f));
      if (tier >= (tiers[2] ?? 14)) execs.forEach((e) => recips.add(e));
      for (const r of recips)
        out.push({
          ruleCode: rule.code,
          entity: "invoice",
          entityId: `${inv.id}#t${tier}`,
          recipientId: r,
          dedupe: "recipient",
          title: `Invoice ${tier}+ days overdue: ${restricted && ownerId !== r ? "restricted deal" : dealName}`,
          detail: `$${Math.round(inv.amountCents / 100).toLocaleString("en-US")} was due ${inv.dueAt.toISOString().slice(0, 10)}.`,
          suggestedAction: "Chase payment.",
        });
    }
    return out;
  },

  "NS-24": async (ctx, rule) => {
    const tiers = numList(P(rule), "days", [60, 30, 14]);
    const rows = await db
      .select({ id: s.deals.id, name: s.deals.name, ownerId: s.deals.ownerId, renewalAt: s.deals.renewalAt })
      .from(s.deals)
      .where(and(isNull(s.deals.deletedAt), isNotNull(s.deals.renewalAt), inArray(s.deals.status, ["open", "won"]), gte(s.deals.renewalAt, ctx.now)));
    const out: AlertCandidate[] = [];
    for (const d of rows) {
      const tier = renewalTier(d.renewalAt, ctx.now, tiers);
      if (tier == null || !ctx.isActive(d.ownerId)) continue;
      out.push({
        ruleCode: rule.code,
        entity: "deal",
        entityId: `${d.id}#t${tier}`,
        recipientId: d.ownerId!,
        title: `Renewal in ≤${tier} days: ${d.name}`,
        detail: `Renews ${d.renewalAt!.toISOString().slice(0, 10)}.`,
        suggestedAction: "Start the renewal conversation.",
      });
    }
    return out;
  },

  "NS-25": async (ctx, rule) => {
    if (!isBusinessDay(ctx.now, DEFAULT_TZ)) return [];
    const days = num(P(rule), "businessDays", 2);
    const last = await db.select({ actorId: s.activities.actorId, at: max(s.activities.occurredAt) }).from(s.activities).where(isNotNull(s.activities.actorId)).groupBy(s.activities.actorId);
    const lastBy = new Map(last.map((r) => [r.actorId!, r.at]));
    const out: AlertCandidate[] = [];
    for (const u of ctx.users.values()) {
      if (!u.active || !SALES_ROLES.includes(u.role)) continue;
      if (!repInactive(lastBy.get(u.id) ?? null, u.createdAt, ctx.now, { businessDays: days, tz: u.timezone })) continue;
      const mgr = ctx.managerOf(u.id);
      if (!mgr) continue;
      out.push({
        ruleCode: rule.code,
        entity: "user",
        entityId: u.id,
        recipientId: mgr,
        title: `${u.name}: no activity in ${days}+ business days`,
        detail: lastBy.get(u.id) ? `Last logged activity ${lastBy.get(u.id)!.toISOString().slice(0, 10)}.` : "No logged activity yet.",
        suggestedAction: "Check in with the rep.",
      });
    }
    return out;
  },

  "NS-26": async (ctx, rule) => {
    const threshold = num(P(rule), "snoozes", 3);
    const rows = await db
      .select({ id: s.tasks.id, title: s.tasks.title, assigneeId: s.tasks.assigneeId, status: s.tasks.status, snoozeCount: s.tasks.snoozeCount })
      .from(s.tasks)
      .where(and(eq(s.tasks.status, "open"), gte(s.tasks.snoozeCount, threshold)));
    const out: AlertCandidate[] = [];
    for (const t of rows) {
      if (!t.assigneeId || !snoozedTooOften(t, threshold)) continue;
      const c = ns26Candidate(ctx, t, rule.code);
      if (c) out.push(c);
    }
    return out;
  },

  "NS-27": async (ctx, rule) => {
    const threshold = num(P(rule), "engagedProbability", await getSetting<number>("pipeline.engaged_threshold", 0.5));
    const out: AlertCandidate[] = [];
    for (const d of await ctx.openDeals()) {
      if (d.stageCategory !== "open" || d.stageProbability < threshold || !ctx.isActive(d.ownerId)) continue;
      const gaps = dataQualityGaps({ ...d, primaryContactEmailStatus: d.contactEmailStatus, unit: d.unit === "activation" ? "activation" : d.unit });
      if (!gaps.length) continue;
      out.push({
        ruleCode: rule.code,
        entity: "deal",
        entityId: d.id,
        recipientId: d.ownerId!,
        title: `${d.name}: missing ${gaps.join(", ")}`,
        detail: `Engaged deal (${d.stageName}) has data gaps.`,
        suggestedAction: "Fill in the missing fields.",
      });
    }
    return out;
  },

  "NS-29": async (ctx, rule) => {
    const days = num(P(rule), "businessDays", 1);
    const approvers = await ctx.withPermission("proposals", "approve");
    const rows = await db
      .select({ id: s.proposals.id, createdAt: s.proposals.createdAt, version: s.proposals.version, dealName: s.deals.name, restricted: s.deals.restricted, ownerId: s.deals.ownerId })
      .from(s.proposals)
      .innerJoin(s.deals, eq(s.deals.id, s.proposals.dealId))
      .where(and(eq(s.proposals.status, "pending_approval"), isNull(s.deals.deletedAt)));
    const out: AlertCandidate[] = [];
    for (const p of rows) {
      if (businessDaysBetween(p.createdAt, ctx.now, DEFAULT_TZ) < days) continue;
      for (const r of approvers)
        out.push({
          ruleCode: rule.code,
          entity: "proposal",
          entityId: p.id,
          recipientId: r,
          dedupe: "recipient",
          title: `Proposal awaiting approval: ${dealLabel({ name: p.dealName, restricted: p.restricted, ownerId: p.ownerId }, r)} v${p.version}`,
          detail: `Waiting ${days}+ business day(s).`,
          suggestedAction: "Review and approve or send back.",
        });
    }
    return out;
  },

  "NS-30": async (ctx, rule) => {
    const rows = await db.select().from(s.integrationConnections).where(eq(s.integrationConnections.status, "error"));
    const admins = ctx.byRoles(["admin", "super_admin"]);
    const out: AlertCandidate[] = [];
    for (const c of rows) {
      const recips = c.userId ? (ctx.isActive(c.userId) ? [c.userId] : []) : admins;
      for (const r of recips)
        out.push({
          ruleCode: rule.code,
          entity: "integration",
          entityId: c.id,
          recipientId: r,
          dedupe: "recipient",
          title: `${c.provider} connection broken`,
          detail: c.lastError ? c.lastError.slice(0, 200) : "The connection reported an error.",
          suggestedAction: "Reconnect in Settings.",
        });
    }
    return out;
  },

  "NS-31": async (ctx, rule) => {
    const days = num(P(rule), "businessDays", 3);
    const rows = await db
      .select({ searchId: s.scoutCandidates.searchId, n: count(), oldest: min(s.scoutCandidates.createdAt), name: s.scoutSearches.name, ownerId: s.scoutSearches.ownerId })
      .from(s.scoutCandidates)
      .innerJoin(s.scoutSearches, eq(s.scoutSearches.id, s.scoutCandidates.searchId))
      .where(eq(s.scoutCandidates.state, "new"))
      .groupBy(s.scoutCandidates.searchId, s.scoutSearches.name, s.scoutSearches.ownerId);
    const svps = ctx.byRoles(["sales_leader"]);
    const out: AlertCandidate[] = [];
    for (const r of rows) {
      if (!r.oldest || businessDaysBetween(r.oldest, ctx.now, ctx.tz(r.ownerId)) < days) continue;
      const recips = ctx.isActive(r.ownerId) ? [r.ownerId] : svps;
      for (const u of recips)
        out.push({
          ruleCode: rule.code,
          entity: "scout_search",
          entityId: r.searchId!,
          recipientId: u,
          dedupe: "recipient",
          title: `${r.n} scout candidates awaiting review`,
          detail: `"${r.name}" has candidates waiting ${days}+ business days.`,
          suggestedAction: "Review the queue.",
        });
    }
    return out;
  },

  "NS-32": async (ctx, rule) => {
    const unassignedDays = num(P(rule), "unassignedDays", 1);
    const noTouchDays = num(P(rule), "noTouchDays", 5);
    const rows = await db
      .select({
        domain: s.scoutCandidates.domain,
        reviewedAt: s.scoutCandidates.reviewedAt,
        accountId: s.accounts.id,
        accountName: s.accounts.name,
        ownerId: s.accounts.ownerId,
        touched: sql<boolean>`exists (select 1 from rso.activities a where a.account_id = ${s.accounts.id} and a.occurred_at >= ${s.scoutCandidates.reviewedAt})`,
      })
      .from(s.scoutCandidates)
      .innerJoin(s.accounts, sql`${s.accounts.id}::text = ${s.scoutCandidates.crmMatch}->>'accountId'`)
      .where(and(eq(s.scoutCandidates.state, "accepted"), isNotNull(s.scoutCandidates.reviewedAt), isNull(s.accounts.deletedAt)));
    const svps = ctx.byRoles(["sales_leader"]);
    const out: AlertCandidate[] = [];
    for (const r of rows) {
      if (!r.ownerId) {
        if (businessDaysBetween(r.reviewedAt!, ctx.now, DEFAULT_TZ) < unassignedDays) continue;
        for (const u of svps)
          out.push({
            ruleCode: rule.code,
            entity: "account",
            entityId: r.accountId,
            recipientId: u,
            dedupe: "recipient",
            title: `Accepted target unassigned: ${r.accountName}`,
            detail: `${r.domain} was accepted from Lead Scout but has no owner.`,
            suggestedAction: "Assign an owner.",
          });
      } else if (!r.touched && ctx.isActive(r.ownerId) && businessDaysBetween(r.reviewedAt!, ctx.now, ctx.tz(r.ownerId)) >= noTouchDays) {
        out.push({
          ruleCode: rule.code,
          entity: "account",
          entityId: r.accountId,
          recipientId: r.ownerId,
          title: `No first touch: ${r.accountName}`,
          detail: `Accepted ${noTouchDays}+ business days ago with no outreach logged.`,
          suggestedAction: "Send the first outreach.",
        });
      }
    }
    return out;
  },

  "NS-33": async (ctx, rule) => {
    const budget = await getSetting<{ orgMonthlyCents?: number }>("scout.budget", {});
    const monthStart = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), 1));
    const [row] = await db.select({ spent: sum(s.enrichmentRuns.costCents) }).from(s.enrichmentRuns).where(gte(s.enrichmentRuns.createdAt, monthStart));
    const spent = Number(row?.spent ?? 0);
    const t = budgetThreshold(spent, budget.orgMonthlyCents ?? 0, numList(P(rule), "thresholds", [0.5, 0.8, 1]));
    if (t == null) return [];
    const month = ctx.now.toISOString().slice(0, 7);
    return ctx.byRoles(["admin", "super_admin", "finance"]).map((r) => ({
      ruleCode: rule.code,
      entity: "org",
      entityId: `apify:${month}#t${Math.round(t * 100)}`,
      recipientId: r,
      dedupe: "recipient" as const,
      severity: t >= 1 ? ("serious" as const) : undefined,
      title: `Apify spend at ${Math.round(t * 100)}% of monthly budget`,
      detail: `$${(spent / 100).toFixed(2)} of $${((budget.orgMonthlyCents ?? 0) / 100).toFixed(2)} used in ${month}.`,
      suggestedAction: t >= 1 ? "New runs are blocked until the budget is raised." : "Review scout/enrichment usage.",
    }));
  },
};

/* ───────────── Rule data helpers ───────────── */

async function openCommitments(owedBy: "us" | "them") {
  return db
    .select({
      id: s.tasks.id,
      title: s.tasks.title,
      assigneeId: s.tasks.assigneeId,
      status: s.tasks.status,
      owedBy: s.tasks.owedBy,
      dueAt: s.tasks.dueAt,
      snoozedUntil: s.tasks.snoozedUntil,
      evidence: s.tasks.evidence,
    })
    .from(s.tasks)
    .where(and(eq(s.tasks.status, "open"), eq(s.tasks.owedBy, owedBy), isNotNull(s.tasks.dueAt)));
}

async function docsWithOwners(where: SQL) {
  const rows = await db
    .select({
      id: s.documents.id,
      type: s.documents.type,
      name: s.documents.name,
      status: s.documents.status,
      createdAt: s.documents.createdAt,
      expiresAt: s.documents.expiresAt,
      dealId: s.documents.dealId,
      accountId: s.documents.accountId,
      dealOwnerId: s.deals.ownerId,
      restricted: s.deals.restricted,
      accountOwnerId: s.accounts.ownerId,
    })
    .from(s.documents)
    .leftJoin(s.deals, eq(s.deals.id, s.documents.dealId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.documents.accountId))
    .where(and(where, or(isNull(s.documents.dealId), isNull(s.deals.deletedAt))));
  return rows.map((r) => ({ ...r, restricted: Boolean(r.restricted), recipientId: r.dealOwnerId ?? r.accountOwnerId }));
}

async function internalDomains(): Promise<string[]> {
  const rows = await db.select({ d: s.allowedDomains.domain }).from(s.allowedDomains);
  return Array.from(new Set([...env.allowedDomains, ...rows.map((r) => r.d.toLowerCase())]));
}

function ns26Candidate(ctx: Ctx, t: { id: string; title: string; assigneeId: string | null; snoozeCount: number }, code = "NS-26"): AlertCandidate | null {
  if (!t.assigneeId) return null;
  const mgr = ctx.managerOf(t.assigneeId);
  if (!mgr) return null;
  const who = ctx.users.get(t.assigneeId)?.name ?? "A rep";
  return {
    ruleCode: code,
    entity: "task",
    entityId: t.id,
    recipientId: mgr,
    title: `${who} snoozed "${t.title}" ${t.snoozeCount}×`,
    detail: "Repeated snoozes usually mean the task is blocked or unclear.",
    suggestedAction: "Check in, reassign, or cancel the task.",
  };
}

/* ───────────── Upsert / resolve / escalate ───────────── */

type AlertRow = typeof s.alerts.$inferSelect;

async function insertAlert(c: AlertCandidate & { severity: Severity }, extra: Partial<typeof s.alerts.$inferInsert> = {}): Promise<AlertRow | null> {
  const [row] = await db
    .insert(s.alerts)
    .values({
      ruleCode: c.ruleCode,
      entity: c.entity,
      entityId: c.entityId,
      recipientId: c.recipientId,
      severity: c.severity,
      title: c.title.slice(0, 300),
      detail: c.detail ?? null,
      suggestedAction: c.suggestedAction ?? null,
      ...extra,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Group new-alert notifications per recipient (≤3 individual, otherwise one summary). */
async function notifyNew(created: AlertRow[]): Promise<number> {
  const byUser = new Map<string, AlertRow[]>();
  for (const a of created) if (a.recipientId) byUser.set(a.recipientId, [...(byUser.get(a.recipientId) ?? []), a]);
  let n = 0;
  for (const [userId, list] of byUser) {
    if (list.length <= 3) {
      for (const a of list) {
        await notify(userId, { kind: "alert", title: a.title, body: a.detail, href: alertHref(a.entity, a.entityId) });
        n++;
      }
    } else {
      const crit = list.filter((a) => a.severity === "critical" || a.severity === "serious").length;
      await notify(userId, {
        kind: "alert",
        title: `${list.length} new alerts${crit ? ` (${crit} serious or critical)` : ""}`,
        body: list
          .slice(0, 5)
          .map((a) => `• ${a.title}`)
          .join("\n"),
        href: "/tasks?tab=alerts",
      });
      n++;
    }
  }
  return n;
}

/**
 * Raise a single alert immediately (outside the sweep), e.g. NS-26 when a task is snoozed the 3rd time.
 * Respects rule enabled/severity and the open-alert dedupe index. Returns true when a new alert was created.
 */
export async function raiseAlert(c: AlertCandidate): Promise<boolean> {
  const [rule] = await db.select().from(s.alertRules).where(eq(s.alertRules.code, c.ruleCode));
  if (rule && !rule.enabled) return false;
  const row = await insertAlert({ ...c, severity: c.severity ?? rule?.severity ?? "warning" });
  if (row) await notifyNew([row]);
  return Boolean(row);
}

/** Build + raise NS-26 for a task (called from the snooze action). */
export async function raiseSnoozeAlert(task: { id: string; title: string; assigneeId: string | null; snoozeCount: number }) {
  const ctx = new Ctx();
  await ctx.load();
  const c = ns26Candidate(ctx, task);
  return c ? raiseAlert(c) : false;
}

/**
 * The sweep (PRD §12): evaluate every enabled rule, upsert alerts (deduped), auto-resolve cleared ones,
 * wake expired snoozes, escalate unresolved alerts to the recipient's manager, notify. Idempotent.
 */
export async function runSweep(opts: { only?: string[] } = {}): Promise<SweepStats> {
  const t0 = Date.now();
  const ctx = new Ctx();
  await ctx.load();
  const rules = await db.select().from(s.alertRules);
  const ruleBy = new Map(rules.map((r) => [r.code, r]));
  const stats: SweepStats = { evaluated: [], failed: [], created: 0, updated: 0, resolved: 0, reopened: 0, escalated: 0, notified: 0, ms: 0 };

  // 1) evaluate (rules in parallel; one failing rule never blocks the others or resolves its alerts)
  const candidates: (AlertCandidate & { severity: Severity })[] = [];
  const implemented = new Set<string>(IMPLEMENTED_RULES);
  const active = rules.filter((r) => r.enabled && implemented.has(r.code) && EVALUATORS[r.code] && (!opts.only || opts.only.includes(r.code)));
  const evalRule = async (rule: Rule, attempt = 1): Promise<{ rule: Rule; list: AlertCandidate[] } | { rule: Rule; error: string }> => {
    try {
      return { rule, list: await withTimeout(EVALUATORS[rule.code]!(ctx, rule), RULE_TIMEOUT_MS, rule.code) };
    } catch (e) {
      // one retry: pooled connections occasionally reset (ECONNRESET) under load
      if (attempt < 2) return evalRule(rule, attempt + 1);
      console.error(`[sweep] ${rule.code} failed`, e);
      return { rule, error: (e as Error).message.slice(0, 200) };
    }
  };
  const results: Awaited<ReturnType<typeof evalRule>>[] = [];
  for (const group of chunks(active, 4)) results.push(...(await Promise.all(group.map((r) => evalRule(r)))));
  for (const r of results) {
    if ("error" in r) stats.failed.push({ rule: r.rule.code, error: r.error ?? "error" });
    else {
      stats.evaluated.push(r.rule.code);
      for (const c of r.list) candidates.push({ ...c, severity: c.severity ?? r.rule.severity });
    }
  }
  const evaluated = new Set(stats.evaluated);
  const disabled = new Set(rules.filter((r) => !r.enabled).map((r) => r.code));

  // 2) existing open alerts
  const existing = await db.select().from(s.alerts).where(inArray(s.alerts.state, [...OPEN_STATES]));
  const byKey = new Map(existing.map((a) => [alertKey(a), a]));
  const byTriple = new Map<string, AlertRow[]>();
  for (const a of existing) byTriple.set(alertTriple(a), [...(byTriple.get(alertTriple(a)) ?? []), a]);

  // 3) upsert (batched: updates in small parallel groups, inserts in chunks)
  const created: AlertRow[] = [];
  const seenTriples = new Set<string>();
  const seenKeys = new Set<string>();
  const toInsert: (AlertCandidate & { severity: Severity })[] = [];
  const toUpdate: { id: string; c: AlertCandidate & { severity: Severity } }[] = [];
  for (const c of candidates) {
    const key = alertKey(c);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    seenTriples.add(alertTriple(c));
    const match = byKey.get(key);
    // One alert per record per rule: if it was reassigned or escalated, it keeps living under its new recipient.
    if (!match && (c.dedupe ?? "entity") === "entity" && (byTriple.get(alertTriple(c)) ?? []).length) continue;
    if (match) {
      if (match.title !== c.title || match.detail !== (c.detail ?? null) || match.severity !== c.severity) toUpdate.push({ id: match.id, c });
      continue;
    }
    toInsert.push(c);
  }
  for (const group of chunks(toUpdate, 10)) {
    await Promise.all(
      group.map(({ id, c }) =>
        db
          .update(s.alerts)
          .set({ title: c.title.slice(0, 300), detail: c.detail ?? null, severity: c.severity, suggestedAction: c.suggestedAction ?? null })
          .where(eq(s.alerts.id, id)),
      ),
    );
  }
  stats.updated = toUpdate.length;
  for (const group of chunks(toInsert, 500)) {
    const rows = await db
      .insert(s.alerts)
      .values(
        group.map((c) => ({
          ruleCode: c.ruleCode,
          entity: c.entity,
          entityId: c.entityId,
          recipientId: c.recipientId,
          severity: c.severity,
          title: c.title.slice(0, 300),
          detail: c.detail ?? null,
          suggestedAction: c.suggestedAction ?? null,
        })),
      )
      .onConflictDoNothing()
      .returning();
    created.push(...rows);
  }
  stats.created = created.length;

  // 4) auto-resolve alerts whose condition no longer holds (only for rules evaluated successfully) or whose rule is off
  const toResolve = existing.filter(
    (a) => (evaluated.has(a.ruleCode) && !seenTriples.has(alertTriple(a))) || (disabled.has(a.ruleCode) && !opts.only),
  );
  if (toResolve.length) {
    for (const chunk of chunks(toResolve, 500)) {
      await db
        .update(s.alerts)
        .set({ state: "resolved", resolvedAt: ctx.now, resolution: "Auto-resolved: condition cleared" })
        .where(inArray(s.alerts.id, chunk.map((a) => a.id)));
    }
    stats.resolved = toResolve.length;
  }
  const resolvedIds = new Set(toResolve.map((a) => a.id));

  // 5) wake expired snoozes
  const woke = await db
    .update(s.alerts)
    .set({ state: "open", snoozedUntil: null })
    .where(and(eq(s.alerts.state, "snoozed"), lt(s.alerts.snoozedUntil, ctx.now)))
    .returning({ id: s.alerts.id });
  stats.reopened = woke.length;
  const wokeIds = new Set(woke.map((w) => w.id));

  // 6) escalate (business days only; to manager / team lead)
  for (const a of existing) {
    if (resolvedIds.has(a.id) || !a.recipientId) continue;
    const state = wokeIds.has(a.id) ? "open" : a.state;
    const rule = ruleBy.get(a.ruleCode);
    const u = ctx.users.get(a.recipientId);
    if (!rule || !u) continue;
    if (!escalationDue({ ...a, state }, rule.escalateAfterHours, ctx.now, { tz: u.timezone, startHour: u.workStartHour, endHour: u.workEndHour })) continue;
    const mgr = ctx.managerOf(a.recipientId);
    await db
      .update(s.alerts)
      .set(mgr ? { state: "escalated", escalatedAt: ctx.now } : { escalatedAt: ctx.now })
      .where(eq(s.alerts.id, a.id));
    if (!mgr) continue;
    const copy = await insertAlert(
      {
        ruleCode: a.ruleCode,
        entity: a.entity,
        entityId: a.entityId,
        recipientId: mgr,
        severity: a.severity,
        title: `Escalated: ${a.title}`,
        detail: `Unresolved by ${u.name} for ${rule.escalateAfterHours}h+ of business time. ${a.detail ?? ""}`.trim(),
        suggestedAction: a.suggestedAction,
      },
      { escalatedAt: ctx.now },
    );
    if (copy) {
      created.push(copy);
      stats.escalated++;
    }
  }

  // 7) notify (grouped)
  stats.notified = await notifyNew(created);
  stats.ms = Date.now() - t0;

  await db
    .insert(s.agentRuns)
    .values({ kind: "sweep", model: "rules", output: stats as never, latencyMs: stats.ms, error: stats.failed.length ? JSON.stringify(stats.failed) : null })
    .catch(() => {});
  return stats;
}

const RULE_TIMEOUT_MS = 60_000;

/** A hung DB connection must not stall the whole sweep: a timed-out rule counts as failed (its alerts stay as-is). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    }),
  ]);
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

