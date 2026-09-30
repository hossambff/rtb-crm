import { redirect } from "next/navigation";
import { can, requireUser } from "@/lib/rbac/server";

export const metadata = { title: "Admin" };

export default async function AdminIndex() {
  const user = await requireUser();
  if (await can(user, "admin", "configure")) redirect("/admin/users");
  if (await can(user, "audit", "view")) redirect("/admin/audit");
  return null; // layout renders the no-access state
}
