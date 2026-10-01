import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { can, type AppUser } from "@/lib/rbac/server";
import { getSlackContext } from "@/lib/slack/config";
import { getGoogleAccount } from "@/lib/integrations/google";
import { getConnection } from "@/lib/integrations/store";
import { CALENDAR_READ_SCOPE, GMAIL_READ_SCOPE, hasScope } from "@/lib/integrations/core";
import { getMyMotions, getPrefs } from "./index";
import { computeChecklist } from "./checklist-core";
import { applicableSteps, isSellingRole, type OnboardingState } from "@/lib/welcome/core";
import { unclaimedPlaceholderExists } from "@/lib/welcome/queries";
import { forecastWindow } from "@/lib/forecast/core";

export type ChecklistView = ReturnType<typeof computeChecklist> & { dismissed: boolean; wizardStarted: boolean; wizardComplete: boolean };

/** First-run checklist for My Day / Settings, from real state. Never throws (null = don't show). */
export async function loadChecklist(user: AppUser): Promise<ChecklistView | null> {
  try {
    const prefs = await getPrefs(user.id);
    const [canEmail, canCalls, canCopilot, motions] = await Promise.all([
      can(user, "email", "view"),
      can(user, "calls", "view"),
      can(user, "copilot", "use_ai"),
      getMyMotions(user),
    ]);
    const canOwnDeals = motions.permitted.length > 0 && (await canEditAnyDeals(user));
    const [acct, granola, copilotRun, owned, slack] = await Promise.all([
      canEmail ? getGoogleAccount(user.id) : Promise.resolve(null),
      canCalls ? getConnection(user.id, "granola") : Promise.resolve(null),
      canCopilot
        ? db
            .select({ x: sql`1` })
            .from(s.agentRuns)
            .where(and(eq(s.agentRuns.userId, user.id), inArray(s.agentRuns.kind, ["copilot_chat", "chat"])))
            .limit(1)
        : Promise.resolve([]),
      canOwnDeals
        ? db
            .select({ x: sql`1` })
            .from(s.deals)
            .where(and(eq(s.deals.ownerId, user.id), eq(s.deals.status, "open"), isNull(s.deals.deletedAt)))
            .limit(1)
        : Promise.resolve([]),
      getSlackContext().catch(() => null),
    ]);
    const onboarding = prefs.onboarding as OnboardingState;
    const sells = isSellingRole(user.role) && motions.permitted.length > 0;
    const [hasPlaceholders, quota] = await Promise.all([
      sells && !onboarding.steps?.book ? unclaimedPlaceholderExists() : Promise.resolve(Boolean(onboarding.steps?.book)),
      sells
        ? db
            .select({ x: sql`1` })
            .from(s.quotas)
            .where(and(eq(s.quotas.userId, user.id), eq(s.quotas.period, forecastWindow(new Date(), user.timezone).current)))
            .limit(1)
        : Promise.resolve([]),
    ]);
    const wizardSteps = applicableSteps({
      role: user.role,
      motionCount: motions.permitted.length,
      hasPlaceholders,
      canEmail,
      canCalls,
      slackConfigured: Boolean(slack),
    });
    const wizardStatus = Object.fromEntries(Object.entries(onboarding.steps ?? {}).map(([k, v]) => [k, v.status]));
    const r = computeChecklist({
      canEmail,
      canCalls,
      canDeals: motions.permitted.length > 0,
      canCopilot,
      canOwnDeals,
      slackConfigured: Boolean(slack),
      googleConnected: hasScope(acct?.scope, GMAIL_READ_SCOPE) && hasScope(acct?.scope, CALENDAR_READ_SCOPE),
      granolaConnected: Boolean(granola && granola.status !== "revoked" && granola.secretEncrypted),
      hasMotions: prefs.pipelineKeys.length > 0 || motions.source === "owned",
      slackDm: prefs.slackDm,
      usedCopilot: copilotRun.length > 0,
      ownsOpenDeals: owned.length > 0,
      manual: prefs.checklist.done ?? {},
      wizardSteps,
      wizardStatus,
      hasQuota: quota.length > 0,
    });
    return { ...r, dismissed: Boolean(prefs.checklist.dismissedAt), wizardStarted: Boolean(onboarding.startedAt), wizardComplete: Boolean(onboarding.completedAt) };
  } catch (e) {
    console.error("[checklist] failed", (e as Error).message?.slice(0, 160));
    return null;
  }
}

/** Sellers: any deals module with create/edit scope (viewers, finance and onboarding don't own deals). */
async function canEditAnyDeals(user: AppUser): Promise<boolean> {
  const mods = ["deals_NET", "deals_ENT", "deals_SPT", "deals_R100", "deals_ADS", "deals_PAY"] as const;
  const checks = await Promise.all(mods.map((m) => can(user, m, "create")));
  return checks.some(Boolean);
}
