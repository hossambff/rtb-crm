/** Pure preference logic (docs/V2_SPEC.md §B2, Settings → Preferences). Client-safe, unit tested. */
import type { NavItem } from "@/lib/nav";

/** Items that can never be hidden from the sidebar. */
export const PINNED_NAV_HREFS = ["/home"];
/** Marker stored in `user_prefs.navHidden` once a user saved their own sidebar (kept for compatibility). */
export const NAV_CUSTOMIZED = "@customized";

/**
 * The user's sidebar: every permitted item except the ones they switched off in Settings → Preferences. There is no
 * "More" menu and no role preset — permissions already shape the list. Hidden items stay reachable via ⌘K and links.
 */
export function shapeNav(items: NavItem[], navHidden: readonly string[]): NavItem[] {
  const hidden = new Set(navHidden.filter((h) => h !== NAV_CUSTOMIZED && !PINNED_NAV_HREFS.includes(h)));
  return items.filter((i) => !hidden.has(i.href));
}

/** navHidden value to store for the hrefs a user switched off (only known, non-pinned hrefs). */
export function toNavHidden(hiddenList: readonly string[], known: readonly string[]): string[] {
  const ok = new Set(known);
  return [NAV_CUSTOMIZED, ...Array.from(new Set(hiddenList)).filter((h) => ok.has(h) && !PINNED_NAV_HREFS.includes(h)).sort()];
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
