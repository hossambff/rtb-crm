import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { getDealForUser } from "@/lib/deals/queries";
import { pendingHandoffReview } from "@/lib/handoffs/service";

/**
 * QA-09 / AT-02: a deal outside the caller's scope (or restricted without access) answers HTTP 403 before the page
 * streams. Missing and forbidden deals get the same response, so the status doesn't reveal whether a deal exists.
 * V2 §C3: the receiver of a pending handoff may open the read-only brief view even before they can see the deal.
 */
export default async function DealLayout({ children, params }: LayoutProps<"/deals/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) forbidden();
  if (!(await getDealForUser(user, id)) && !(await pendingHandoffReview(user, id))) forbidden();
  return children;
}
