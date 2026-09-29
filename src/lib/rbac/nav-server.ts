import "server-only";
import { NAV, type NavItem } from "@/lib/nav";
import { getMatrix, type AppUser } from "./server";

export async function visibleNav(user: AppUser): Promise<NavItem[]> {
  const matrix = await getMatrix(user.role);
  return NAV.filter((item) => {
    if (item.anyOf) return item.anyOf.some((m) => (matrix[m]?.view ?? "none") !== "none");
    if (!item.module) return true;
    return (matrix[item.module]?.[item.action ?? "view"] ?? "none") !== "none";
  });
}
