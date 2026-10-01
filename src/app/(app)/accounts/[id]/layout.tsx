import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { getVisibleAccount } from "@/lib/accounts/queries";

/**
 * QA MIN-40: an account outside the caller's scope (or restricted without access) answers a real HTTP 403 before the
 * page's loading boundary streams — same pattern as deals. Missing and forbidden accounts get the same response, so
 * the status doesn't reveal whether an account exists.
 */
export default async function AccountLayout({ children, params }: LayoutProps<"/accounts/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  if (!(await getVisibleAccount(user, id))) forbidden();
  return children;
}
