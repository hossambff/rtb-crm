"use server";
import { revalidatePath } from "next/cache";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { type AppUser } from "@/lib/rbac/server";
import { getPrefs, patchPrefs, permittedMotions } from "@/lib/prefs";
import { SLACK_MEMBER_ID, slackIdChange } from "@/lib/prefs/core";
import { claimSlackMemberId } from "@/lib/slack/identity";
import { getPrefs as getIntegrationPrefs, savePrefs as saveIntegrationPrefs } from "@/lib/integrations/store";
import { notifyMany } from "@/lib/notifications/notify";
import { requestApproval } from "@/lib/approvals/service";
import { isPlaceholderEmail } from "@/lib/admin/claim-plan";
import { forecastWindow } from "@/lib/forecast/core";
import { isMeetingsRole, mayPropose, metricsForMotion, QUOTA_METRICS, toStoredTarget } from "@/lib/quotas/core";
import { wizardFacts } from "./queries";
import {
  applicableSteps,
  isRequiredStep,
  isSellingRole,
  mergeTags,
  normalizeHttpsUrl,
  normalizeLinkedIn,
  WIZARD_STEP_IDS,
  wizardProgress,
  type OnboardingState,
  type StepStatus,
  type WizardStepId,
} from "./core";

const now = () => new Date().toISOString();

/** "View as" sessions never change the viewed person's setup. */
function assertSelf(user: AppUser) {
  if (user.impersonatedBy) throw new UserError("Setup can't be changed while viewing as another user.");
}

/** Record a step's status on the user's own onboarding state (never someone else's). */
async function recordStep(user: AppUser, step: WizardStepId, status: StepStatus, extra: Partial<OnboardingState> = {}) {
  const before = (await getPrefs(user.id)).onboarding as OnboardingState;
  const onboarding: OnboardingState = {
    ...before,
    startedAt: before.startedAt ?? now(),
    ...extra,
    steps: { ...(before.steps ?? {}), [step]: { status, at: now() } },
  };
  await patchPrefs(user.id, { onboarding });
  return onboarding;
}

async function assertApplicable(user: AppUser, step: WizardStepId) {
  const steps = applicableSteps(await wizardFacts(user));
  if (!steps.includes(step)) throw new UserError("That step isn't part of your setup.");
  return steps;
}

function refresh() {
  revalidatePath("/welcome");
  revalidatePath("/home");
}

/** First visit to /welcome: stamp startedAt (the first-run redirect stops from here on). */
export const startOnboarding = action(z.object({}), async (_i, user) => {
  if (user.impersonatedBy) return { startedAt: null };
  const before = (await getPrefs(user.id)).onboarding as OnboardingState;
  if (before.startedAt) return { startedAt: before.startedAt };
  const onboarding = { ...before, startedAt: now() };
  await patchPrefs(user.id, { onboarding });
  await audit({ actorId: user.id, action: "onboarding.start", entity: "user_prefs", entityId: user.id, after: { startedAt: onboarding.startedAt } });
  return { startedAt: onboarding.startedAt };
});

/** Mark a step done / skipped. Required steps can't be skipped. */
export const markWizardStep = action(
  z.object({ step: z.enum(WIZARD_STEP_IDS), status: z.enum(["done", "skipped"]) }),
  async ({ step, status }, user) => {
    assertSelf(user);
    if (step === "done") throw new UserError("Use Finish to complete setup.");
    if (status === "skipped" && isRequiredStep(step)) throw new UserError("This step is needed to get you set up.");
    await assertApplicable(user, step);
    await recordStep(user, step, status);
    await audit({ actorId: user.id, action: `onboarding.step_${status}`, entity: "user_prefs", entityId: user.id, after: { step } });
    refresh();
    return { step, status };
  },
);

/** "Finish later": leave the wizard; nothing is forced again, remaining steps stay on My Day. */
export const deferOnboarding = action(z.object({}), async (_i, user) => {
  assertSelf(user);
  const before = (await getPrefs(user.id)).onboarding as OnboardingState;
  const onboarding = { ...before, startedAt: before.startedAt ?? now(), deferredAt: now() };
  await patchPrefs(user.id, { onboarding });
  await audit({ actorId: user.id, action: "onboarding.defer", entity: "user_prefs", entityId: user.id, after: { deferredAt: onboarding.deferredAt } });
  refresh();
  return { redirect: "/home" };
});

/** Finish: every required step must be done. */
export const finishOnboarding = action(z.object({}), async (_i, user) => {
  assertSelf(user);
  const steps = applicableSteps(await wizardFacts(user));
  const before = (await getPrefs(user.id)).onboarding as OnboardingState;
  const p = wizardProgress(before, steps);
  if (!p.canFinish) throw new UserError(`Finish these first: ${p.missingRequired.join(", ")}.`);
  const onboarding: OnboardingState = {
    ...before,
    startedAt: before.startedAt ?? now(),
    completedAt: before.completedAt ?? now(),
    deferredAt: null,
    steps: { ...(before.steps ?? {}), done: { status: "done", at: now() } },
  };
  await patchPrefs(user.id, { onboarding });
  await audit({ actorId: user.id, action: "onboarding.complete", entity: "user_prefs", entityId: user.id, after: { completedAt: onboarding.completedAt, skipped: p.skipped } });
  refresh();
  return { redirect: "/home" };
});

/** "Something's wrong? Tell an admin" — role/team/manager/employment are set by admins; notify them. */
export const reportProfileIssue = action(z.object({ message: z.string().trim().min(3, "Tell us what looks wrong.").max(500) }), async ({ message }, user) => {
  assertSelf(user);
  const admins = await db
    .select({ id: s.user.id, banned: s.user.banned })
    .from(s.user)
    .where(inArray(s.user.role, ["admin", "super_admin"]));
  const ids = admins.filter((a) => !a.banned && a.id !== user.id).map((a) => a.id);
  if (!ids.length) throw new UserError("No admin is set up yet — tell your manager.");
  await notifyMany(ids, {
    kind: "help",
    title: `${user.name} says their setup details look wrong`,
    body: message,
    href: `/admin/users?q=${encodeURIComponent(user.email)}`,
  });
  await audit({ actorId: user.id, action: "onboarding.report_issue", entity: "user", entityId: user.id, after: { message } });
  return { notified: ids.length };
});

const TZ = (() => {
  try {
    return new Set(Intl.supportedValuesOf("timeZone"));
  } catch {
    return new Set<string>();
  }
})();

const optionalText = (max: number) => z.string().trim().max(max).optional().default("");

/** Step b: profile → user (title, time zone, working hours), user_prefs.profile, signature (integration prefs). */
export const saveProfileStep = action(
  z
    .object({
      title: optionalText(120),
      phone: optionalText(40).refine((v) => !v || /^[+()\d\s.-]{6,40}$/.test(v), "Use digits, spaces and + ( ) -"),
      linkedinUrl: optionalText(300).refine((v) => !v || normalizeLinkedIn(v) !== null, "Paste your linkedin.com profile link"),
      bookingUrl: optionalText(300).refine((v) => !v || normalizeHttpsUrl(v) !== null, "Use a full https:// link (Calendly, Google booking page…)"),
      timezone: z.string().refine((tz) => TZ.has(tz) || tz === "UTC", "Pick a valid time zone"),
      workStartHour: z.number().int().min(0).max(23),
      workEndHour: z.number().int().min(1).max(24),
      signature: optionalText(2000),
    })
    .refine((v) => v.workEndHour > v.workStartHour, { message: "End must be after start", path: ["workEndHour"] }),
  async (input, user) => {
    assertSelf(user);
    const [before] = await db
      .select({ title: s.user.title, timezone: s.user.timezone, workStartHour: s.user.workStartHour, workEndHour: s.user.workEndHour })
      .from(s.user)
      .where(eq(s.user.id, user.id));
    const userPatch = { title: input.title || null, timezone: input.timezone, workStartHour: input.workStartHour, workEndHour: input.workEndHour };
    await db.update(s.user).set(userPatch).where(eq(s.user.id, user.id));
    const prefs = await getPrefs(user.id);
    const profile = {
      ...prefs.profile,
      phone: input.phone || null,
      linkedinUrl: input.linkedinUrl ? normalizeLinkedIn(input.linkedinUrl) : null,
      bookingUrl: input.bookingUrl ? normalizeHttpsUrl(input.bookingUrl) : null,
    };
    await patchPrefs(user.id, { profile });
    const integ = await getIntegrationPrefs(user.id);
    if ((integ.signature ?? "") !== input.signature) await saveIntegrationPrefs(user.id, { ...integ, signature: input.signature });
    await recordStep(user, "profile", "done");
    await audit({
      actorId: user.id,
      action: "user.profile_update",
      entity: "user",
      entityId: user.id,
      before: { ...before, profile: prefs.profile },
      after: { ...userPatch, profile, signatureChanged: (integ.signature ?? "") !== input.signature },
    });
    revalidatePath("/settings");
    refresh();
    return { ok: true };
  },
);

/** Step c: what you sell → user_prefs.pipelineKeys (∩ permitted) + profile regions / languages / focus. */
export const saveSellStep = action(
  z.object({
    pipelineKeys: z.array(z.string().min(1).max(40)).max(30),
    regions: z.array(z.string().max(40)).max(20),
    regionsOther: optionalText(200),
    languages: z.array(z.string().max(40)).max(20),
    languagesOther: optionalText(200),
    focus: optionalText(500),
  }),
  async (input, user) => {
    assertSelf(user);
    await assertApplicable(user, "sell");
    const allowed = new Set((await permittedMotions(user)).map((m) => m.key));
    const pipelineKeys = Array.from(new Set(input.pipelineKeys)).filter((k) => allowed.has(k));
    if (!pipelineKeys.length) throw new UserError("Pick at least one motion you sell.");
    const prefs = await getPrefs(user.id);
    const profile = {
      ...prefs.profile,
      regions: mergeTags(input.regions, input.regionsOther),
      languages: mergeTags(input.languages, input.languagesOther),
      focus: input.focus || null,
    };
    const checklist = { ...prefs.checklist, done: { ...(prefs.checklist.done ?? {}), motions: prefs.checklist.done?.motions ?? now() } };
    await patchPrefs(user.id, { pipelineKeys, profile, checklist });
    await recordStep(user, "sell", "done");
    await audit({
      actorId: user.id,
      action: "prefs.update",
      entity: "user_prefs",
      entityId: user.id,
      before: { pipelineKeys: prefs.pipelineKeys, profile: prefs.profile },
      after: { pipelineKeys, profile },
    });
    revalidatePath("/", "layout");
    return { pipelineKeys };
  },
);

/**
 * Step d: "These are mine" → a placeholder_claim approval (admins / executives decide; SLA from the approvals settings).
 * Only counts are carried in the request — never deal names (MNPI).
 */
export const requestPlaceholderClaim = action(
  z.object({ placeholderId: z.string().min(1).max(64), note: z.string().trim().max(300).optional() }),
  async ({ placeholderId, note }, user) => {
    assertSelf(user);
    if (!isSellingRole(user.role)) throw new UserError("Only people who sell can claim imported deals.");
    if (user.impersonatedBy) throw new UserError("Claims are disabled while viewing as another user.");
    const [ph] = await db
      .select({ id: s.user.id, name: s.user.name, email: s.user.email, banReason: s.user.banReason })
      .from(s.user)
      .where(eq(s.user.id, placeholderId));
    if (!ph || !isPlaceholderEmail(ph.email)) throw new UserError("That isn't an imported placeholder.");
    if ((ph.banReason ?? "").startsWith("Claimed by")) throw new UserError("Someone already claimed that placeholder.");
    const open = await db
      .select({ id: s.approvals.id, requestedBy: s.approvals.requestedBy })
      .from(s.approvals)
      .where(and(eq(s.approvals.kind, "placeholder_claim"), eq(s.approvals.entityId, ph.id), eq(s.approvals.status, "pending")));
    if (open.some((a) => a.requestedBy === user.id)) throw new UserError("You already asked for this one — it's with an admin.");
    const [counts] = await db
      .select({ deals: count() })
      .from(s.deals)
      .where(and(eq(s.deals.ownerId, ph.id), isNull(s.deals.deletedAt)));
    const row = await requestApproval({
      kind: "placeholder_claim",
      entity: "user",
      entityId: ph.id,
      requestedBy: user.id,
      approverRole: "admin",
      payload: { placeholderId: ph.id, placeholderName: ph.name, requesterName: user.name, deals: Number(counts?.deals ?? 0), competing: open.length },
      note: note || null,
      title: `${user.name} says ${ph.name} is them (${Number(counts?.deals ?? 0)} deals)`,
    });
    refresh();
    revalidatePath("/admin/team-setup");
    revalidatePath("/team/setup");
    return { id: row.id };
  },
);

/** Step e: propose targets (when the leader hasn't set them). Never overwrites a leader-set quota. */
export const proposeTargets = action(
  z.object({
    period: z.string().regex(/^\d{4}-Q[1-4]$/),
    lines: z
      .array(
        z.object({
          pipelineKey: z.string().max(40),
          metric: z.enum(QUOTA_METRICS),
          target: z.number().min(0, "Targets can't be negative").max(1e12),
        }),
      )
      .min(1)
      .max(12),
  }),
  async ({ period, lines }, user) => {
    assertSelf(user);
    await assertApplicable(user, "targets");
    const { current, next } = forecastWindow(new Date(), user.timezone);
    if (period !== current && period !== next) throw new UserError("Propose for this quarter or next.");
    const allowed = new Set((await permittedMotions(user)).map((m) => m.key));
    const existing = await db.select().from(s.quotas).where(and(eq(s.quotas.userId, user.id), eq(s.quotas.period, period)));
    let saved = 0;
    for (const l of lines) {
      const lineOk = l.pipelineKey === "" ? isMeetingsRole(user.role) : allowed.has(l.pipelineKey);
      if (!lineOk || !metricsForMotion(l.pipelineKey).includes(l.metric)) continue;
      if (!(l.target > 0)) continue;
      const cur = existing.find((q) => q.pipelineKey === l.pipelineKey && q.metric === l.metric);
      if (!mayPropose(cur)) continue;
      const target = toStoredTarget(l.metric, l.target);
      await db
        .insert(s.quotas)
        .values({ userId: user.id, period, pipelineKey: l.pipelineKey, metric: l.metric, target, status: "proposed", setBy: user.id })
        .onConflictDoUpdate({ target: [s.quotas.userId, s.quotas.period, s.quotas.pipelineKey, s.quotas.metric], set: { target, status: "proposed", setBy: user.id } });
      await audit({ actorId: user.id, action: "quota.propose", entity: "quota", entityId: `${user.id}:${period}:${l.pipelineKey}:${l.metric}`, before: cur ?? null, after: { period, ...l, target } });
      saved++;
    }
    if (!saved) throw new UserError("Nothing to propose — enter at least one target above zero.");
    await recordStep(user, "targets", "done");
    revalidatePath("/admin/team-setup");
    revalidatePath("/team/setup");
    refresh();
    return { saved };
  },
);

/** Step f: Slack DMs + member ID (verified against Slack and claimed uniquely, same as Settings). */
export const saveSlackStep = action(
  z.object({
    slackDm: z.boolean(),
    slackUserId: z
      .string()
      .trim()
      .max(32)
      .transform((v) => v.toUpperCase())
      .refine((v) => v === "" || SLACK_MEMBER_ID.test(v), "Looks like U0123ABCD — in Slack: Profile → ⋯ → Copy member ID")
      .nullish(),
  }),
  async (input, user) => {
    assertSelf(user);
    const before = await getPrefs(user.id);
    let slackUserId = before.slackUserId;
    const change = slackIdChange(input.slackUserId, before.slackUserId);
    if (change.action === "claim") {
      const claim = await claimSlackMemberId(user, change.slackUserId);
      if (!claim.ok) throw new UserError(claim.reason);
      slackUserId = claim.slackUserId;
    }
    await patchPrefs(user.id, { slackDm: input.slackDm });
    await audit({
      actorId: user.id,
      action: "prefs.update",
      entity: "user_prefs",
      entityId: user.id,
      before: { slackDm: before.slackDm, slackUserId: before.slackUserId },
      after: { slackDm: input.slackDm, slackUserId },
    });
    refresh();
    return { slackDm: input.slackDm, slackUserId };
  },
);

/** Step g: alert budget + post-call autopilot + meeting briefs (same prefs as Settings → Preferences). */
export const saveWorkStep = action(
  z.object({
    alertBudgetPerDay: z.number().int().min(1, "At least 1").max(10, "At most 10"),
    postCall: z.enum(["off", "review", "auto"]),
    meetingBriefs: z.boolean(),
  }),
  async (input, user) => {
    assertSelf(user);
    const before = await getPrefs(user.id);
    const autopilot = { ...before.autopilot, postCall: input.postCall, meetingBriefs: input.meetingBriefs };
    const checklist = { ...before.checklist, done: { ...(before.checklist.done ?? {}), alertBudget: before.checklist.done?.alertBudget ?? now() } };
    await patchPrefs(user.id, { alertBudgetPerDay: input.alertBudgetPerDay, autopilot, checklist });
    await recordStep(user, "work", "done");
    await audit({
      actorId: user.id,
      action: "prefs.update",
      entity: "user_prefs",
      entityId: user.id,
      before: { alertBudgetPerDay: before.alertBudgetPerDay, autopilot: before.autopilot },
      after: { alertBudgetPerDay: input.alertBudgetPerDay, autopilot },
    });
    revalidatePath("/settings");
    refresh();
    return { ok: true };
  },
);
