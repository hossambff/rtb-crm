/** First-run checklist (docs/V2_SPEC.md §B9) — pure, role-aware, completion detected from real state. Unit tested. */

export const CHECKLIST_STEP_IDS = ["google", "granola", "motions", "claimDeals", "slack", "copilot", "alertBudget"] as const;
export type ChecklistStepId = (typeof CHECKLIST_STEP_IDS)[number];

export type ChecklistFacts = {
  /** What the role can use — steps for unusable features are not shown. */
  canEmail: boolean;
  canCalls: boolean;
  canDeals: boolean;
  canCopilot: boolean;
  /** The role owns deals (sells) — shows "Claim your imported deals". */
  canOwnDeals: boolean;
  /** Slack is connected for the organization — otherwise the Slack step is a dead end and is hidden. */
  slackConfigured: boolean;
  /** Real state. */
  googleConnected: boolean; // Gmail read + Calendar scopes granted
  granolaConnected: boolean;
  hasMotions: boolean; // motions-I-sell saved, or the user already owns deals
  slackDm: boolean;
  usedCopilot: boolean;
  ownsOpenDeals: boolean; // the user owns at least one open deal (imported deals claimed / created)
  /** Steps marked done manually (user_prefs.checklist.done). Only trusted for steps without a real-state signal. */
  manual: Partial<Record<ChecklistStepId, string>>;
};

export type ChecklistStep = { id: ChecklistStepId; title: string; why: string; href: string; cta: string; done: boolean };

export function computeChecklist(f: ChecklistFacts): { steps: ChecklistStep[]; done: number; total: number; complete: boolean } {
  const steps: ChecklistStep[] = [];
  if (f.canEmail)
    steps.push({
      id: "google",
      title: "Connect Gmail & Calendar",
      why: "Replies, promises and meetings flow in on their own.",
      href: "/settings#connections",
      cta: "Connect",
      done: f.googleConnected,
    });
  if (f.canCalls)
    steps.push({
      id: "granola",
      title: "Add your Granola key",
      why: "Calls turn into notes, tasks and a drafted follow-up.",
      href: "/settings#connections",
      cta: "Add key",
      done: f.granolaConnected,
    });
  if (f.canDeals)
    steps.push({
      id: "motions",
      title: "Set the motions you sell",
      why: "Pipelines and pickers show your motions first.",
      href: "/settings#preferences",
      cta: "Choose",
      done: f.hasMotions || Boolean(f.manual.motions),
    });
  if (f.canDeals && f.canOwnDeals)
    steps.push({
      id: "claimDeals",
      title: "Claim your imported deals",
      why: "Imported deals without an owner don't reach anyone's Today.",
      href: "/deals?owner=none",
      cta: "Review",
      done: f.ownsOpenDeals,
    });
  if (f.slackConfigured)
    steps.push({
      id: "slack",
      title: "Turn on Slack DMs",
      why: "Only what matters pings you; the rest waits for the digest.",
      href: "/settings#preferences",
      cta: "Turn on",
      done: f.slackDm,
    });
  if (f.canCopilot)
    steps.push({
      id: "copilot",
      title: "Ask Copilot a question",
      why: "Try “Which of my deals have no next step?”",
      href: "/copilot",
      cta: "Try it",
      done: f.usedCopilot || Boolean(f.manual.copilot),
    });
  steps.push({
    id: "alertBudget",
    title: "Set your alert budget",
    why: "Decide how many interruptions a day you want.",
    href: "/settings#preferences",
    cta: "Set",
    done: Boolean(f.manual.alertBudget),
  });
  const done = steps.filter((s) => s.done).length;
  return { steps, done, total: steps.length, complete: done === steps.length };
}
