import "server-only";
import { NAV, filterNav, type NavItem } from "@/lib/nav";
import { getPrefs } from "@/lib/prefs";
import { shapeNav } from "@/lib/prefs/core";
import { getMatrix, type AppUser } from "./server";

/** Nav items the user's role permits (no personalization) — e.g. for Settings → Preferences. */
export async function permittedNav(user: AppUser): Promise<NavItem[]> {
  return filterNav(NAV, await getMatrix(user.role));
}

/** Permitted nav minus the items the user switched off (Settings → Preferences). ⌘K and links still reach them. */
export async function visibleNav(user: AppUser): Promise<NavItem[]> {
  const items = await permittedNav(user);
  try {
    const prefs = await getPrefs(user.id);
    return shapeNav(items, prefs.navHidden);
  } catch {
    return items;
  }
}
