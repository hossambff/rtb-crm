/** Pure preference logic (docs/V2_SPEC.md §B2, Settings → Preferences). Client-safe, unit tested. */
import type { NavItem } from "@/lib/nav";
import type { Role } from "@/lib/rbac/model";

export const SHORT_NAV_HREFS = ["/home", "/pipelines", "/contacts", "/inbox", "/sequences", "/scout", "/copilot"];
/** Most items any role's default sidebar shows before the rest goes under "More" (QA MAJ-22). */
export const NAV_DEFAULT_MAX = 12;
/**
 * Default sidebar per role (V2 §B2, QA MAJ-22): the role's daily surfaces, in NAV order, ≤ NAV_DEFAULT_MAX.
 * Everything else the role may open sits under "More" until the user customizes it in Settings → Preferences.
 * Roles without an entry get the first NAV_DEFAULT_MAX permitted items.
 */
export const ROLE_DEFAULT_NAV: Partial<Record<Role, string[]>> = {
  sdr: SHORT_NAV_HREFS,
  intern: SHORT_NAV_HREFS,
  commission_rep: SHORT_NAV_HREFS,
  ae: ["/home", "/pipelines", "/deals", "/accounts", "/contacts", "/tasks", "/inbox", "/sequences", "/calls", "/copilot", "/proposals", "/forecast"],
  sales_leader: ["/home", "/pipelines", "/deals", "/accounts", "/contacts", "/tasks", "/inbox", "/calls", "/forecast", "/review", "/team", "/analytics"],
  executive: ["/home", "/pipelines", "/deals", "/accounts", "/tasks", "/inbox", "/proposals", "/revenue", "/forecast", "/review", "/team", "/analytics"],
  admin: ["/home", "/pipelines", "/deals", "/accounts", "/contacts", "/tasks", "/forecast", "/review", "/team", "/analytics", "/import", "/admin"],
  super_admin: ["/home", "/pipelines", "/deals", "/accounts", "/contacts", "/tasks", "/forecast", "/review", "/team", "/analytics", "/import", "/admin"],
  finance: ["/home", "/deals", "/accounts", "/tasks", "/proposals", "/revenue", "/commissions", "/forecast", "/analytics", "/admin/audit"],
  onboarding: ["/home", "/pipelines", "/deals", "/accounts", "/contacts", "/tasks", "/inbox", "/calls", "/onboarding"],
};
/** Items that can never be moved under "More". */
export const PINNED_NAV_HREFS = ["/home"];
/**
 * Marker stored in `user_prefs.navHidden` once a user saved their own sidebar: from then on navHidden is the exact
 * list of hrefs under "More" (an empty customized list must not fall back to the role's short default).
 */
export const NAV_CUSTOMIZED = "@customized";

/** The hrefs a role sees in the sidebar by default (pure; `permitted` in NAV order). */
export function defaultPrimaryNav(permitted: readonly string[], role: Role): string[] {
  const preset = ROLE_DEFAULT_NAV[role];
  const list = preset ? permitted.filter((h) => preset.includes(h)) : [...permitted];
  const pinned = list.filter((h) => PINNED_NAV_HREFS.includes(h));
  const rest = list.filter((h) => !PINNED_NAV_HREFS.includes(h));
  return [...pinned, ...rest].slice(0, NAV_DEFAULT_MAX);
}

/**
 * Mark nav items that belong under "More" (`more: true`). Nothing is removed: a hidden item is one click away and its
 * pages, alerts and notification links keep working. A saved list (with the NAV_CUSTOMIZED marker — or a legacy
 * non-empty list) is used as is; otherwise the role default applies.
 */
export function shapeNav(items: NavItem[], role: Role, navHidden: readonly string[]): NavItem[] {
  const customized = navHidden.includes(NAV_CUSTOMIZED) || navHidden.length > 0;
  const hidden = new Set(navHidden);
  const primary = new Set(defaultPrimaryNav(items.map((i) => i.href), role));
  return items.map((i) => {
    if (PINNED_NAV_HREFS.includes(i.href)) return { ...i, more: false };
    const more = customized ? hidden.has(i.href) : !primary.has(i.href);
    return { ...i, more };
  });
}

/** navHidden value to store for a set of hrefs the user wants under "More" (only known, non-pinned hrefs). */
export function toNavHidden(moreList: readonly string[], known: readonly string[]): string[] {
  const ok = new Set(known);
  return [NAV_CUSTOMIZED, ...Array.from(new Set(moreList)).filter((h) => ok.has(h) && !PINNED_NAV_HREFS.includes(h)).sort()];
}

/**
 * "Motions I sell": explicit prefs (∩ permitted) → motions where the user owns open deals (∩ permitted) → all permitted.
 * Order follows `permitted` (admin sort order).
 */
export function resolveMotions(
  prefKeys: readonly string[],
  permitted: readonly string[],
  ownedKeys: readonly string[],
): { keys: string[]; source: "prefs" | "owned" | "all" } {
  const pick = (want: readonly string[]) => permitted.filter((k) => want.includes(k));
  const fromPrefs = pick(prefKeys);
  if (fromPrefs.length) return { keys: fromPrefs, source: "prefs" };
  const owned = pick(ownedKeys);
  if (owned.length) return { keys: owned, source: "owned" };
  return { keys: [...permitted], source: "all" };
}

/** Slack member IDs look like U0123ABCD / W0123ABCD. */
export const SLACK_MEMBER_ID = /^[UW][A-Z0-9]{6,20}$/;

export const POST_CALL_LABELS: Record<"off" | "review" | "auto", { label: string; hint: string }> = {
  off: { label: "Off", hint: "Calls are analyzed; you apply nothing automatically." },
  review: { label: "Review", hint: "Everything pre-checked — one click to apply and draft the follow-up." },
  auto: { label: "Auto-draft", hint: "High-confidence tasks and next step applied for you, follow-up saved as a Gmail draft. Never sent." },
};

/** Pickers (create deal, …) lead with "motions I sell" in that order; the rest keep their original order. Pure. */
export function leadWithMotions<T extends { key: string }>(items: readonly T[], motionKeys: readonly string[]): T[] {
  const rank = new Map(motionKeys.map((k, i) => [k, i]));
  return items
    .map((item, i) => ({ item, i, r: rank.get(item.key) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
}

/**
 * What a Preferences save should do with the Slack member ID: `undefined`/`null` input = keep what's stored (it may have
 * been auto-mapped), "" = clear, a new ID = verify with Slack and claim it (SEC M-4). Unchanged input = keep. Pure.
 */
export function slackIdChange(input: string | null | undefined, stored: string | null): { action: "keep" } | { action: "claim"; slackUserId: string | null } {
  if (input == null) return { action: "keep" };
  const next = input.trim().toUpperCase() || null;
  return next === stored ? { action: "keep" } : { action: "claim", slackUserId: next };
}

/** The "Set your alert budget" checklist step completes only when the user actually chose a value (QA MIN-02). Pure. */
export function alertBudgetChosen(touched: boolean | undefined, next: number, prev: number): boolean {
  return Boolean(touched) || next !== prev;
}
