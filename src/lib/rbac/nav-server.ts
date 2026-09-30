import "server-only";
import { NAV, type NavItem } from "@/lib/nav";
import { getMatrix, type AppUser } from "./server";

export async function visibleNav(user: AppUser): Promise<NavItem[]> {
  const matrix = await getMatrix(user.role);
  const has = (m: NavItem["module"], a: NavItem["action"]) => Boolean(m) && (matrix[m!]?.[a ?? "view"] ?? "none") !== "none";
  return NAV.filter((item) => {
    if (item.unless && has(item.unless.module, item.unless.action)) return false;
    if (item.anyOf) return item.anyOf.some((m) => (matrix[m]?.view ?? "none") !== "none");
    if (!item.module) return true;
    return (matrix[item.module]?.[item.action ?? "view"] ?? "none") !== "none";
  });
}
