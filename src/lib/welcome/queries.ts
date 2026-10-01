import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { can, type AppUser } from "@/lib/rbac/server";
import { ROLE_LABELS } from "@/lib/rbac/model";
import { getMyMotions, getPrefs } from "@/lib/prefs";
import { getSettingsState } from "@/lib/integrations/queries";
import { getSlackContext } from "@/lib/slack/config";
import { placeholderSummary } from "@/lib/admin/user-queries";
import { forecastWindow } from "@/lib/forecast/core";
import { defaultQuotaLines, isQuotaMetric, type QuotaMetric } from "@/lib/quotas/core";
import { applicableSteps, isSellingRole, wizardProgress, type OnboardingState, type WizardFacts } from "./core";

const manager = alias(s.user, "manager");

/** Cheap facts for step applicability (used by the wizard, the checklist and the board). */
export async function wizardFacts(user: AppUser): Promise<WizardFacts & { motionKeys: string[] }> {
  const [motions, canEmail, canCalls, slack] = await Promise.all([
    getMyMotions(user),
    can(user, "email", "view"),
    can(user, "calls", "view"),
    getSlackContext().catch(() => null),
  ]);
  const hasPlaceholders = isSellingRole(user.role) ? await unclaimedPlaceholderExists() : false;
  return {
    role: user.role,
    motionCount: motions.permitted.length,
    hasPlaceholders,
    canEmail,
    canCalls,
    slackConfigured: Boolean(slack),
    motionKeys: motions.keys,
  };
}

/** Is there an import placeholder, not yet claimed, that still owns a live deal? (one indexed EXISTS query) */
export async function unclaimedPlaceholderExists(): Promise<boolean> {
  const rows = await db
    .select({ x: sql`1` })
    .from(s.user)
    .where(
      and(
        sql`lower(${s.user.email}) like '%.placeholder@roundtable.invalid'`,
        sql`coalesce(${s.user.banReason}, '') not like 'Claimed by%'`,
        sql`exists (select 1 from ${s.deals} d where d.owner_id = ${s.user.id} and d.deleted_at is null)`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export type PlaceholderOption = { id: string; name: string; deals: number; accounts: number; tasks: number };
export type MyClaim = { id: string; placeholderId: string; placeholderName: string; status: string; note: string | null; createdAt: string };

export async function loadWizard(user: AppUser) {
  const [prefs, state, facts, motions, me] = await Promise.all([
    getPrefs(user.id),
    getSettingsState(user),
    wizardFacts(user),
    getMyMotions(user),
    db
      .select({
        title: s.user.title,
        employmentType: s.user.employmentType,
        teamName: s.teams.name,
        managerName: manager.name,
        timezone: s.user.timezone,
        workStartHour: s.user.workStartHour,
        workEndHour: s.user.workEndHour,
      })
      .from(s.user)
      .leftJoin(s.teams, eq(s.teams.id, s.user.teamId))
      .leftJoin(manager, eq(manager.id, s.user.managerId))
      .where(eq(s.user.id, user.id))
      .then((r) => r[0]),
  ]);
  const steps = applicableSteps(facts);
  const onboarding = prefs.onboarding as OnboardingState;
  const { current, next } = forecastWindow(new Date(), user.timezone);

  const sells = steps.includes("sell");
  const [placeholders, claims, quotaRows] = await Promise.all([
    steps.includes("book") ? placeholderSummary() : Promise.resolve([]),
    steps.includes("book")
      ? db
          .select()
          .from(s.approvals)
          .where(and(eq(s.approvals.kind, "placeholder_claim"), eq(s.approvals.requestedBy, user.id)))
          .orderBy(desc(s.approvals.createdAt))
          .limit(20)
      : Promise.resolve([]),
    sells
      ? db
          .select()
          .from(s.quotas)
          .where(and(eq(s.quotas.userId, user.id), inArray(s.quotas.period, [current, next])))
      : Promise.resolve([]),
  ]);

  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London"];
  }
  if (me?.timezone && !zones.includes(me.timezone)) zones = [me.timezone, ...zones];

  const quotas = quotaRows
    .filter((q) => isQuotaMetric(q.metric))
    .map((q) => ({ id: q.id, period: q.period, pipelineKey: q.pipelineKey, metric: q.metric as QuotaMetric, target: q.target, status: q.status }));

  return {
    steps,
    progress: wizardProgress(onboarding, steps),
    onboarding,
    who: {
      name: user.name,
      email: user.email,
      role: user.role,
      roleLabel: ROLE_LABELS[user.role],
      team: me?.teamName ?? null,
      manager: me?.managerName ?? null,
      employmentType: me?.employmentType ?? "staff",
    },
    profile: {
      title: me?.title ?? "",
      timezone: me?.timezone ?? user.timezone,
      /** Never confirmed yet → let the browser zone win as the smart default. */
      timezoneConfirmed: onboarding.steps?.profile?.status === "done",
      workStartHour: me?.workStartHour ?? 9,
      workEndHour: me?.workEndHour ?? 18,
      phone: prefs.profile.phone ?? "",
      linkedinUrl: prefs.profile.linkedinUrl ?? "",
      bookingUrl: prefs.profile.bookingUrl ?? "",
      signature: state.prefs.signature ?? "",
    },
    zones,
    sell: {
      motions: motions.permitted.map((m) => ({ key: m.key, name: m.name, color: m.color })),
      selected: motions.keys,
      regions: prefs.profile.regions ?? [],
      languages: prefs.profile.languages ?? [],
      focus: prefs.profile.focus ?? "",
    },
    book: {
      placeholders: placeholders
        .filter((p) => !p.claimed && p.deals + p.accounts + p.tasks > 0)
        .map((p): PlaceholderOption => ({ id: p.id, name: p.name, deals: p.deals, accounts: p.accounts, tasks: p.tasks })),
      claims: claims.map(
        (a): MyClaim => ({
          id: a.id,
          placeholderId: a.entityId,
          placeholderName: typeof a.payload?.placeholderName === "string" ? a.payload.placeholderName : "Placeholder",
          status: a.status,
          note: a.status === "rejected" ? a.note : null,
          createdAt: a.createdAt.toISOString(),
        }),
      ),
    },
    targets: {
      current,
      next,
      quotas,
      lines: defaultQuotaLines(user.role, motions.keys),
    },
    tools: {
      google: state.google,
      granola: state.granola,
      slackConfigured: facts.slackConfigured,
      slackDm: prefs.slackDm,
      slackUserId: prefs.slackUserId,
      canEmail: facts.canEmail,
      canCalls: facts.canCalls,
      mailboxRequired: state.mailboxRequired,
    },
    work: {
      alertBudgetPerDay: prefs.alertBudgetPerDay,
      postCall: prefs.autopilot.postCall ?? "review",
      meetingBriefs: prefs.autopilot.meetingBriefs ?? true,
    },
    canCopilot: await can(user, "copilot", "use_ai"),
  };
}
export type WizardData = Awaited<ReturnType<typeof loadWizard>>;
