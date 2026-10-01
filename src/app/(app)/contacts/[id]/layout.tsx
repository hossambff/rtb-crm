import { forbidden } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { requireUser } from "@/lib/rbac/server";
import { contactVisibilityWhere } from "@/lib/contacts/queries";

/**
 * QA MIN-40: a contact outside the caller's scope answers a real HTTP 403 before the page's loading boundary streams
 * (same pattern as deals). Missing and forbidden contacts get the same response.
 */
export default async function ContactLayout({ children, params }: LayoutProps<"/contacts/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) forbidden();
  const [row] = await db
    .select({ id: s.contacts.id })
    .from(s.contacts)
    .where(and(eq(s.contacts.id, id), isNull(s.contacts.deletedAt), await contactVisibilityWhere(user, "view")))
    .limit(1);
  if (!row) forbidden();
  return children;
}
