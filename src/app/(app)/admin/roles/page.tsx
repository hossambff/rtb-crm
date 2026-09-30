import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { fieldPermissions, rolePermissions } from "@/db/schema";
import { requireUser } from "@/lib/rbac/server";
import { ROLES, type Role } from "@/lib/rbac/model";
import { isAdmin, isSuperAdmin } from "@/lib/admin/guard";
import { buildGrid, defaultHiddenFields } from "@/lib/admin/permissions-core";
import { NoAccess } from "@/components/admin/admin-nav";
import { FieldSecurity, MatrixEditor, RoleTabs } from "@/components/admin/roles-editor";

export const metadata = { title: "Roles & permissions · Admin" };

const VISIBLE_ROLES = ROLES.filter((r) => r !== "pending") as Role[];

export default async function AdminRolesPage({ searchParams }: PageProps<"/admin/roles">) {
  const user = await requireUser();
  if (!(await isAdmin(user))) return <NoAccess />;
  const sp = await searchParams;
  const requested = Array.isArray(sp.role) ? sp.role[0] : sp.role;
  const role: Role = (VISIBLE_ROLES as string[]).includes(requested ?? "") ? (requested as Role) : "sales_leader";
  const [overrides, fieldRows] = [
    await db.select().from(rolePermissions).where(eq(rolePermissions.role, role)),
    await db.select().from(fieldPermissions).orderBy(asc(fieldPermissions.role), asc(fieldPermissions.entity), asc(fieldPermissions.field)),
  ];
  const grid = buildGrid(role, overrides);
  const overrideCount = grid.flat().filter((c) => c.override).length;
  const superAdmin = isSuperAdmin(user) && !user.impersonatedBy;
  return (
    <>
      <RoleTabs roles={VISIBLE_ROLES} current={role} />
      <MatrixEditor role={role} grid={grid} editable={superAdmin && role !== "super_admin"} overrideCount={overrideCount} />
      <FieldSecurity
        defaults={defaultHiddenFields()}
        overrides={fieldRows}
        editable={superAdmin}
        roles={VISIBLE_ROLES.filter((r) => r !== "super_admin")}
      />
    </>
  );
}
