/**
 * First-run checklist (docs/V2_SPEC.md §B9) — pure, role-aware, completion detected from real state. Unit tested.
 * Unified with the /welcome wizard: each item maps to a wizard step; when that step applies to the person, the item
 * deep-links into it ("Resume setup"), and a step finished in the wizard completes the item. Real-state detection
 * (Gmail connected, owns deals, …) still wins where it exists.
 */

export const CHECKLIST_STEP_IDS = ["profile", "google", "granola", "motions", "claimDeals", "targets", "slack", "copilot", "alertBudget"] as const;
export type ChecklistStepId = (typeof CHECKLIST_STEP_IDS)[number];

/** Which wizard step covers each checklist item (copilot has none — it's a "try it" moment). */
export const WIZARD_STEP_FOR: Partial<Record<ChecklistStepId, string>> = {
  profile: "profile",
  google: "tools",
  granola: "tools",
  slack: "tools",
  motions: "sell",
  claimDeals: "book",
  targets: "targets",
  alertBudget: "work",
};

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
  /** Wizard steps that apply to this person (src/lib/welcome/core.ts applicableSteps) and their recorded status. */
  wizardSteps?: readonly string[];
  wizardStatus?: Partial<Record<string, "done" | "skipped">>;
  /** The person has a quota (set or proposed) for the current quarter. */
  hasQuota?: boolean;
};

export type ChecklistStep = {
  id: ChecklistStepId;
  title: string;
  why: string;
  href: string;
  cta: string;
  done: boolean;
  /** Skipped in the wizard (still to do). */
  skipped?: boolean;
  /** Deep link into the wizard step that covers it (null when the wizard doesn't cover it for this person). */
  wizardHref?: string | null;
};

export function computeChecklist(f: ChecklistFacts): { steps: ChecklistStep[]; done: number; total: number; complete: boolean; resumeHref: string | null } {
  const wizard = new Set(f.wizardSteps ?? []);
  const wStatus = f.wizardStatus ?? {};
  const wizardDone = (id: ChecklistStepId) => {
    const w = WIZARD_STEP_FOR[id];
    return Boolean(w && wizard.has(w) && wStatus[w] === "done");
  };
  const steps: ChecklistStep[] = [];
  if (wizard.has("profile"))
    steps.push({
      id: "profile",
      title: "Complete your profile",
      why: "Time zone and hours drive quiet hours and SLAs; your booking link fills sequences.",
      href: "/settings#profile",
      cta: "Complete",
      done: wizardDone("profile"),
    });
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
      done: f.hasMotions || Boolean(f.manual.motions) || wizardDone("motions"),
    });
  if (f.canDeals && f.canOwnDeals)
    steps.push({
      id: "claimDeals",
      title: "Claim your imported deals",
      why: "Imported deals without an owner don't reach anyone's Today.",
      href: "/deals?owner=none",
      cta: "Review",
      // "None of these are mine" in the wizard also settles it.
      done: f.ownsOpenDeals || wizardDone("claimDeals"),
    });
  if (wizard.has("targets"))
    steps.push({
      id: "targets",
      title: "Check your targets",
      why: "See (or propose) your number for this quarter and next.",
      href: "/welcome?step=targets",
      cta: "Review",
      done: Boolean(f.hasQuota) || wizardDone("targets"),
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
    done: Boolean(f.manual.alertBudget) || wizardDone("alertBudget"),
  });
  // Wizard deep links: items the wizard covers for this person open that step ("Resume setup").
  for (const st of steps) {
    const w = WIZARD_STEP_FOR[st.id];
    st.wizardHref = w && wizard.has(w) ? `/welcome?step=${w}` : null;
    if (st.wizardHref && !st.done) {
      st.href = st.wizardHref;
      st.skipped = wStatus[w!] === "skipped";
    }
  }
  const done = steps.filter((s) => s.done).length;
  const firstOpen = steps.find((s) => !s.done && s.wizardHref);
  return { steps, done, total: steps.length, complete: done === steps.length, resumeHref: firstOpen?.wizardHref ?? null };
}
