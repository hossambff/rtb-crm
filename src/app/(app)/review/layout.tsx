import { forbidden } from "next/navigation";
import { requireUser, scopeFor } from "@/lib/rbac/server";
import { listVisiblePipelines } from "@/lib/deals/queries";

/**
 * QA C5 / MIN-40: pipeline review is a leader ritual that ends in deal edits. Roles without analytics scope, or that
 * can't edit any deal (finance), get a real HTTP 403 — decided here, before the review's loading boundary streams.
 */
export default async function ReviewLayout({ children }: LayoutProps<"/review">) {
  const user = await requireUser();
  if ((await scopeFor(user, "analytics", "view")) === "none") forbidden();
  if (!(await listVisiblePipelines(user)).some((p) => p.perms.canEdit)) forbidden();
  return children;
}
