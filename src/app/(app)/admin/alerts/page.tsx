import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { getAlertRules } from "@/lib/admin/config-queries";
import { AlertsEditor } from "@/components/admin/alerts-editor";

export const metadata = { title: "Alert rules" };

export default async function AlertsAdminPage() {
  const user = await requireUser();
  if (!(await isAdmin(user))) forbidden(); // NEW-1: real 403
  const rules = await getAlertRules();
  return <AlertsEditor rules={rules} />;
}
