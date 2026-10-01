/**
 * Team onboarding wizard (/welcome) — pure, client-safe, unit tested (src/lib/welcome/__tests__/core.test.ts).
 *
 * State lives in user_prefs.onboarding: { startedAt, completedAt, deferredAt, steps: { [id]: { status, at } } }.
 * Steps are role-aware: irrelevant ones are hidden (not "skipped"). Required steps must be done to finish; every other
 * step can be skipped and stays on the My Day checklist until it is done.
 */
import type { Role } from "@/lib/rbac/model";

export const WIZARD_STEP_IDS = ["welcome", "profile", "sell", "book", "targets", "tools", "work", "done"] as const;
export type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

export type StepStatus = "done" | "skipped";
export type OnboardingState = {
  startedAt?: string;
  completedAt?: string | null;
  deferredAt?: string | null;
  steps?: Record<string, { status: StepStatus; at: string }>;
};

export const STEP_META: Record<WizardStepId, { title: string; short: string; blurb: string }> = {
  welcome: { title: "Welcome", short: "Welcome", blurb: "Check who you are in Roundtable." },
  profile: { title: "Your profile", short: "Profile", blurb: "How people reach you, and when." },
  sell: { title: "What you sell", short: "What you sell", blurb: "Motions, markets and languages." },
  book: { title: "Your book", short: "Your book", blurb: "Claim the deals that are already yours." },
  targets: { title: "Targets", short: "Targets", blurb: "This quarter and next." },
  tools: { title: "Connect your tools", short: "Tools", blurb: "Email, calendar, call notes, Slack." },
  work: { title: "How you want to work", short: "How you work", blurb: "Interruptions and autopilot." },
  done: { title: "You're set", short: "Done", blurb: "Three moves to start." },
};

/** Roles that carry a book and a number. Admins / executives get the shorter path; finance, editorial, viewer never sell. */
export const SELLING_ROLES: readonly Role[] = ["sales_leader", "ae", "sdr", "intern", "commission_rep"];

export function isSellingRole(role: Role): boolean {
  return SELLING_ROLES.includes(role);
}

export type WizardFacts = {
  role: Role;
  /** Pipelines the role may view (motions it could sell). */
  motionCount: number;
  /** Unclaimed import placeholders that still own deals exist. */
  hasPlaceholders: boolean;
  canEmail: boolean;
  canCalls: boolean;
  slackConfigured: boolean;
};

/** The steps this person sees, in order. */
export function applicableSteps(f: WizardFacts): WizardStepId[] {
  const sells = isSellingRole(f.role) && f.motionCount > 0;
  return WIZARD_STEP_IDS.filter((id) => {
    switch (id) {
      case "sell":
      case "targets":
        return sells;
      case "book":
        return sells && f.hasPlaceholders;
      case "tools":
        return f.canEmail || f.canCalls || f.slackConfigured;
      default:
        return true;
    }
  });
}

/** Required steps (cannot be skipped). "What you sell" only for sellers — it's hidden for everyone else anyway. */
export function isRequiredStep(id: WizardStepId): boolean {
  return id === "welcome" || id === "profile" || id === "sell";
}

export function stepStatus(state: OnboardingState, id: WizardStepId): StepStatus | null {
  return state.steps?.[id]?.status ?? null;
}

/** Steps that count towards progress ("n/8"): everything except the closing screen. */
export function progressSteps(steps: readonly WizardStepId[]): WizardStepId[] {
  return steps.filter((s) => s !== "done");
}

export type WizardProgress = {
  steps: WizardStepId[];
  done: number;
  skipped: WizardStepId[];
  /** Required steps still missing — finishing is blocked while non-empty. */
  missingRequired: WizardStepId[];
  canFinish: boolean;
  /** First step that is neither done nor skipped (resume point), else the first skipped one, else "done". */
  next: WizardStepId;
};

export function wizardProgress(state: OnboardingState, steps: readonly WizardStepId[]): WizardProgress {
  const counted = progressSteps(steps);
  const done = counted.filter((s) => stepStatus(state, s) === "done").length;
  const skipped = counted.filter((s) => stepStatus(state, s) === "skipped");
  const missingRequired = counted.filter((s) => isRequiredStep(s) && stepStatus(state, s) !== "done");
  const untouched = counted.find((s) => !stepStatus(state, s));
  return {
    steps: [...steps],
    done,
    skipped,
    missingRequired,
    canFinish: missingRequired.length === 0,
    next: untouched ?? missingRequired[0] ?? skipped[0] ?? "done",
  };
}

export type OnboardingStatus = "not_started" | "in_progress" | "done" | "deferred";

/** Board status for the Team setup console. */
export function onboardingStatus(state: OnboardingState): OnboardingStatus {
  if (state.completedAt) return "done";
  if (state.deferredAt) return "deferred";
  if (state.startedAt || Object.keys(state.steps ?? {}).length) return "in_progress";
  return "not_started";
}

/** A step id from a URL param, if valid and applicable. */
export function parseStep(raw: string | null | undefined, steps: readonly WizardStepId[]): WizardStepId | null {
  return raw && (steps as readonly string[]).includes(raw) ? (raw as WizardStepId) : null;
}

/* ───────────── First-run routing ───────────── */

/**
 * The day the wizard shipped. Accounts created before it that have already used the app (lastActiveAt set) are
 * pre-existing users: treated as "deferred" — never forced through /welcome (they get the setup checklist on My Day
 * and can open /welcome any time). Accounts created before launch that never signed in (pre-provisioned) still onboard.
 */
export const ONBOARDING_LAUNCH = "2026-10-01T00:00:00Z";

/** Paths never redirected: the wizard itself, Settings (connect flows return there), Admin (fix-ups), API. */
const EXEMPT_PREFIXES = ["/welcome", "/settings", "/admin", "/api", "/pending", "/sign-in"];

export function isExemptPath(path: string): boolean {
  return EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

const ts = (v: Date | string | null | undefined) => (v == null ? NaN : new Date(v).getTime());

/** Pre-existing user (see ONBOARDING_LAUNCH). */
export function isLegacyUser(createdAt: Date | string | null | undefined, lastActiveAt: Date | string | null | undefined, launch = ONBOARDING_LAUNCH): boolean {
  const created = ts(createdAt);
  return lastActiveAt != null && Number.isFinite(ts(lastActiveAt)) && Number.isFinite(created) && created < Date.parse(launch);
}

/**
 * Should this request be sent to /welcome? Only signed-in, non-pending users who never started (no startedAt,
 * completedAt or deferredAt), are not being impersonated, are not pre-existing users, and aren't on an exempt path.
 */
export function shouldRedirectToWelcome(i: {
  path: string;
  state: OnboardingState;
  impersonating: boolean;
  createdAt: Date | string | null;
  lastActiveAt: Date | string | null;
  role: Role;
  launch?: string;
}): boolean {
  if (i.role === "pending") return false;
  if (i.impersonating) return false;
  if (isExemptPath(i.path)) return false;
  if (i.state.startedAt || i.state.completedAt || i.state.deferredAt) return false;
  return !isLegacyUser(i.createdAt, i.lastActiveAt, i.launch);
}

/* ───────────── Profile validation ───────────── */

/** https URL (booking links, LinkedIn). Returns the normalized URL or null when invalid. */
export function normalizeHttpsUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:") return null;
    if (!u.hostname.includes(".") || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** LinkedIn profile/company URL on linkedin.com. */
export function normalizeLinkedIn(raw: string): string | null {
  const u = normalizeHttpsUrl(raw);
  if (!u) return null;
  const host = new URL(u).hostname.toLowerCase();
  return host === "linkedin.com" || host.endsWith(".linkedin.com") ? u : null;
}

export const REGION_OPTIONS = ["UK", "US", "EU", "MENA", "APAC", "Global"] as const;
export const LANGUAGE_OPTIONS = ["English", "Arabic", "French", "German", "Spanish", "Portuguese", "Italian", "Mandarin", "Hindi"] as const;

/** Merge picked options with free text ("LatAm, Nordics"), de-duplicated case-insensitively, capped. */
export function mergeTags(picked: readonly string[], freeText: string, max = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...picked, ...freeText.split(/[,;\n]/)]) {
    const t = raw.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
