import { asc } from "drizzle-orm";
import { db } from "@/db";
import { allowedDomains } from "@/db/schema";
import { requireUser } from "@/lib/rbac/server";
import { isAdmin, isSuperAdmin } from "@/lib/admin/guard";
import { listAdminUsers, listTeamsLite, placeholderSummary } from "@/lib/admin/user-queries";
import { NoAccess } from "@/components/admin/admin-nav";
import { PlaceholdersPanel, UsersAdmin } from "@/components/admin/users-admin";

export const metadata = { title: "Users · Admin" };

export default async function AdminUsersPage() {
  const user = await requireUser();
  if (!(await isAdmin(user))) return <NoAccess />;
  const users = await listAdminUsers();
  const teams = await listTeamsLite();
  const placeholders = await placeholderSummary();
  const domains = await db.select({ d: allowedDomains.domain }).from(allowedDomains).orderBy(asc(allowedDomains.domain));
  const active = users.filter((u) => !u.banned && !u.placeholder).map((u) => ({ id: u.id, name: u.name }));
  return (
    <>
      {user.impersonatedBy ? (
        <p className="rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-xs text-secondary">You are viewing as another user — admin changes are disabled.</p>
      ) : null}
      <UsersAdmin users={users} teams={teams} isSuperAdmin={isSuperAdmin(user)} currentUserId={user.id} allowedDomains={domains.map((d) => d.d)} />
      <PlaceholdersPanel placeholders={placeholders} users={active} />
    </>
  );
}
