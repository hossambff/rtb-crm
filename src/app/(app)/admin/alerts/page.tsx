import { requireUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { getAlertRules } from "@/lib/admin/config-queries";
import { NoAccess } from "@/components/admin/admin-nav";
import { AlertsEditor } from "@/components/admin/alerts-editor";

export const metadata = { title: "Alert rules" };

export default async function AlertsAdminPage() {
  const user = await requireUser();
  if (!(await isAdmin(user))) return <NoAccess />;
  const rules = await getAlertRules();
  return <AlertsEditor rules={rules} />;
}
