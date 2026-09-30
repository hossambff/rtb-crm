import { can, requireUser } from "@/lib/rbac/server";
import { parseAuditFilters } from "@/lib/admin/audit-core";
import { AUDIT_PAGE_SIZE, auditFacets, listAudit } from "@/lib/admin/audit-queries";
import { NoAccess } from "@/components/admin/admin-nav";
import { AdminSection } from "@/components/admin/form";
import { AuditFilterBar, AuditTable } from "@/components/admin/audit-log";

export const metadata = { title: "Audit log · Admin" };

export default async function AuditLogPage({ searchParams }: PageProps<"/admin/audit">) {
  const user = await requireUser();
  if (!(await can(user, "audit", "view"))) return <NoAccess />;
  const f = parseAuditFilters(await searchParams);
  const facets = await auditFacets();
  const { rows, total } = await listAudit(user, f);
  const canExport = await can(user, "admin", "configure");
  return (
    <>
      <AdminSection title="Filter" description="Actor, entity, action and date (UTC). CSV export is limited to admins and is itself audit-logged.">
        <AuditFilterBar f={f} actors={facets.actors} entities={facets.entities} hasSystem={facets.hasSystem} canExport={canExport} />
      </AdminSection>
      <AuditTable rows={rows} total={total} f={f} pageSize={AUDIT_PAGE_SIZE} />
    </>
  );
}
