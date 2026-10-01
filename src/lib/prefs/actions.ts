"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { permittedNav } from "@/lib/rbac/nav-server";
import { getPrefs, patchPrefs, permittedMotions } from "./index";
import { SLACK_MEMBER_ID, alertBudgetChosen, slackIdChange, toNavHidden } from "./core";
import { claimSlackMemberId } from "@/lib/slack/identity";
import { getPrefs as getIntegrationPrefs, savePrefs as saveIntegrationPrefs } from "@/lib/integrations/store";

const PrefsInput = z.object({
  pipelineKeys: z.array(z.string().min(1).max(40)).max(30),
  moreNav: z.array(z.string().min(1).max(80)).max(60),
  alertBudgetPerDay: z.number().int().min(1, "At least 1").max(10, "At most 10"),
  autopilot: z.object({
    postCall: z.enum(["off", "review", "auto"]),
    meetingBriefs: z.boolean(),
    emailSignals: z.boolean(),
    forecastSuggest: z.boolean(),
  }),
  slackDm: z.boolean(),
  slackUserId: z
    .string()
    .trim()
    .max(32)
    .transform((v) => v.toUpperCase())
    .refine((v) => v === "" || SLACK_MEMBER_ID.test(v), "Looks like U0123ABCD — find it in Slack under Profile → ⋯ → Copy member ID")
    .nullish(),
  /** Did the user touch the alert-budget slider (even back to the same value)? Completes the checklist step. */
  alertBudgetTouched: z.boolean().optional(),
  /** Interruptions saved with the same button (stored with the notification prefs; merged fresh server-side). */
  interruptions: z
    .object({
      minSeverity: z.enum(["info", "warning", "serious", "critical"]),
      quietHoursStart: z.number().int().min(0).max(23),
      quietHoursEnd: z.number().int().min(0).max(23),
    })
    .optional(),
});

/** Merge a patch into the integration-stored notification prefs, reading them fresh (no stale-form overwrite). */
async function patchNotificationPrefs(userId: string, patch: Record<string, unknown>, extra: { signature?: string; voiceSamples?: string } = {}) {
  const current = await getIntegrationPrefs(userId);
  await saveIntegrationPrefs(userId, { ...current, ...extra, notifications: { ...current.notifications, ...patch } });
}

/** Settings → Preferences. A user only ever edits their own row. */
export const savePreferences = action(PrefsInput, async (input, user) => {
  const [before, motions, nav] = await Promise.all([getPrefs(user.id), permittedMotions(user), permittedNav(user)]);
  const allowed = new Set(motions.map((m) => m.key));
  const pipelineKeys = Array.from(new Set(input.pipelineKeys)).filter((k) => allowed.has(k));
  if (input.pipelineKeys.length && !pipelineKeys.length) throw new UserError("Pick motions you have access to.");
  // undefined/null = leave as is (WS-E1 may have auto-mapped it); "" = clear; otherwise the member ID, verified with
  // Slack (profile email = the user's email) and claimed uniquely before it is stored (SEC M-4 / QA MAJ-18).
  let slackUserId = before.slackUserId;
  const slackChange = slackIdChange(input.slackUserId, before.slackUserId);
  if (slackChange.action === "claim") {
    const claim = await claimSlackMemberId(user, slackChange.slackUserId);
    if (!claim.ok) throw new UserError(claim.reason);
    slackUserId = claim.slackUserId;
  }
  const now = new Date().toISOString();
  const done = { ...(before.checklist.done ?? {}) };
  if (alertBudgetChosen(input.alertBudgetTouched, input.alertBudgetPerDay, before.alertBudgetPerDay)) done.alertBudget ??= now;
  if (pipelineKeys.length) done.motions ??= now;
  const patch = {
    pipelineKeys,
    navHidden: toNavHidden(input.moreNav, nav.map((n) => n.href)),
    alertBudgetPerDay: input.alertBudgetPerDay,
    autopilot: input.autopilot,
    slackDm: input.slackDm,
    checklist: { ...before.checklist, done },
  };
  await patchPrefs(user.id, patch);
  if (input.interruptions) await patchNotificationPrefs(user.id, input.interruptions);
  await audit({
    actorId: user.id,
    action: "prefs.update",
    entity: "user_prefs",
    entityId: user.id,
    before: { pipelineKeys: before.pipelineKeys, navHidden: before.navHidden, alertBudgetPerDay: before.alertBudgetPerDay, autopilot: before.autopilot, slackDm: before.slackDm, slackUserId: before.slackUserId },
    after: { ...patch, slackUserId, interruptions: input.interruptions, checklist: undefined },
  });
  revalidatePath("/", "layout");
  return { ok: true };
});

/** Hide the first-run checklist on My Day (it can be reopened from Settings). */
export const setChecklistDismissed = action(z.object({ dismissed: z.boolean() }), async ({ dismissed }, user) => {
  const before = await getPrefs(user.id);
  await patchPrefs(user.id, { checklist: { ...before.checklist, dismissedAt: dismissed ? new Date().toISOString() : null } });
  revalidatePath("/home");
  revalidatePath("/settings");
  return { dismissed };
});

/** Settings → "Email & drafting": AI-action notices, signature and voice samples (merged fresh — never overwrites interruptions). */
export const saveDraftingPrefs = action(
  z.object({ aiActions: z.boolean(), signature: z.string().max(2000), voiceSamples: z.string().max(8000) }),
  async ({ aiActions, signature, voiceSamples }, user) => {
    // "In-app notifications" is no longer a separate toggle (notify() never read it); the AI-actions switch is the control.
    await patchNotificationPrefs(user.id, { aiActions, inApp: true }, { signature, voiceSamples });
    revalidatePath("/settings");
    return { ok: true };
  },
);
