import { guardPage } from "@/lib/page-guard";
import { SCOPE_RANK } from "@/lib/rbac/model";
import { scoutPermissions } from "@/lib/scout/queries";

/** QA-09: Lead Scout is visible with scout view OR enrichment view (same rule as the page). */
export default async function ScoutLayout({ children }: LayoutProps<"/scout">) {
  await guardPage(async (user) => {
    const perms = await scoutPermissions(user);
    return SCOPE_RANK[perms.view] > 0 || SCOPE_RANK[perms.enrichView] > 0;
  });
  return children;
}
