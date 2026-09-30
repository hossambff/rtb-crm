import { requireUser, can } from "@/lib/rbac/server";
import { PageHeader } from "@/components/ui/misc";
import { AdminNav, NoAccess, type AdminNavItem } from "@/components/admin/admin-nav";

const CONFIG_ITEMS: AdminNavItem[] = [
  { href: "/admin/users", label: "Users" },
  { href: "/admin/roles", label: "Roles & permissions" },
  { href: "/admin/pipelines", label: "Pipelines & stages" },
  { href: "/admin/fields", label: "Fields & picklists" },
  { href: "/admin/alerts", label: "Alert rules" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/claims", label: "Claims library" },
  { href: "/admin/products", label: "Products" },
  { href: "/admin/teams", label: "Teams" },
];

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const user = await requireUser();
  const [configure, auditView] = await Promise.all([can(user, "admin", "configure"), can(user, "audit", "view")]);
  if (!configure && !auditView) {
    return (
      <>
        <PageHeader title="Admin" />
        <NoAccess message="The admin console is available to admins only." />
      </>
    );
  }
  const items = [...(configure ? CONFIG_ITEMS : []), ...(auditView ? [{ href: "/admin/audit", label: "Audit log" }] : [])];
  return (
    <>
      <PageHeader title="Admin" description="Configuration, access and governance. Every change is audit-logged." />
      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <AdminNav items={items} />
        </aside>
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </>
  );
}
