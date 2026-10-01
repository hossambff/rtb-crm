import { requireUser, can } from "@/lib/rbac/server";
import { PageHeader } from "@/components/ui/misc";
import { forbidden } from "next/navigation";
import { headers } from "next/headers";
import { AdminNav, type AdminNavItem } from "@/components/admin/admin-nav";

const CONFIG_ITEMS: AdminNavItem[] = [
  { href: "/admin/users", label: "Users" },
  { href: "/admin/roles", label: "Roles & permissions" },
  { href: "/admin/pipelines", label: "Pipelines & stages" },
  { href: "/admin/fields", label: "Fields & picklists" },
  { href: "/admin/alerts", label: "Alert rules" },
  { href: "/admin/playbooks", label: "Stage playbooks" },
  { href: "/admin/slack", label: "Slack & approvals" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/claims", label: "Claims library" },
  { href: "/admin/templates", label: "Templates" },
  { href: "/admin/products", label: "Products" },
  { href: "/admin/teams", label: "Teams" },
];

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const user = await requireUser();
  const [configure, auditView] = await Promise.all([can(user, "admin", "configure"), can(user, "audit", "view")]);
  if (!configure && !auditView) forbidden(); // QA-09: real 403
  // NEW-1: audit-only users (executive, finance) get a real 403 on config sub-pages — decided here, before the
  // section's loading boundary starts streaming. Pages keep their own checks as defense in depth.
  const path = (await headers()).get("x-rso-pathname") ?? "";
  if (!configure && path !== "/admin" && path !== "/admin/audit" && !path.startsWith("/admin/audit/")) forbidden();
  const items = [...(configure ? CONFIG_ITEMS : []), ...(auditView ? [{ href: "/admin/audit", label: "Audit log" }] : [])];
  return (
    <>
      <PageHeader title="Admin" description="Configuration, access and governance. Every change is audit-logged." />
      <div className="grid gap-6 xl:grid-cols-[200px_minmax(0,1fr)]">
        <aside className="min-w-0 xl:sticky xl:top-20 xl:self-start">
          <AdminNav items={items} />
        </aside>
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </>
  );
}
