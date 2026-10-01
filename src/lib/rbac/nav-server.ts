import "server-only";
import { NAV, filterNav, type NavItem } from "@/lib/nav";
import { getPrefs } from "@/lib/prefs";
import { shapeNav } from "@/lib/prefs/core";
import { getMatrix, type AppUser } from "./server";

/** Nav items the user's role permits (no personalization) — e.g. for Settings → Preferences. */
export async function permittedNav(user: AppUser): Promise<NavItem[]> {
  return filterNav(NAV, await getMatrix(user.role));
}

/**
 * Permitted nav, role-shaped (V2 §B2, QA MAJ-22): items the user moved out of the sidebar — or, until they customize,
 * everything beyond their role's short default (≤ 12) — come back with `more: true` and render under "More".
 * Nothing is dropped, so the command palette and every alert/notification link keep working.
 */
export async function visibleNav(user: AppUser): Promise<NavItem[]> {
  const items = await permittedNav(user);
  try {
    const prefs = await getPrefs(user.id);
    return shapeNav(items, user.role, prefs.navHidden);
  } catch {
    return items;
  }
}
