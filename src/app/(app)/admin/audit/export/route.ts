import { audit } from "@/lib/audit";
import { can, getCurrentUser } from "@/lib/rbac/server";
import { parseAuditFilters, toCsv } from "@/lib/admin/audit-core";
import { exportAudit } from "@/lib/admin/audit-queries";

/** CSV export of the audit log (admins only; the export itself is audited — PRD AUD-1 "exports"). */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return new Response("Unauthorized", { status: 401 });
  if (user.impersonatedBy || !(await can(user, "audit", "view")) || !(await can(user, "admin", "configure"))) {
    return new Response("Forbidden", { status: 403 });
  }
  const url = new URL(req.url);
  const f = parseAuditFilters(Object.fromEntries(url.searchParams.entries()));
  const rows = await exportAudit(user, f);
  await audit({ actorId: user.id, action: "audit.export", entity: "audit_log", after: { filters: { ...f, page: undefined }, rows: rows.length } });
  const csv = toCsv(
    ["id", "created_at_utc", "actor_id", "actor_name", "actor_kind", "action", "entity", "entity_id", "ip", "before", "after"],
    rows.map((r) => [
      r.id,
      new Date(r.createdAt).toISOString(),
      r.actorId,
      r.actorName,
      r.actorKind,
      r.action,
      r.entity,
      r.entityId,
      r.ip,
      r.redacted ? "[restricted]" : r.before,
      r.redacted ? "[restricted]" : r.after,
    ]),
  );
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rtb-audit-log-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
