import { requireUser } from "@/lib/rbac/server";
import { isAdmin, isSuperAdmin } from "@/lib/admin/guard";
import { aiAvailable } from "@/lib/ai";
import { getAdminSettings, getAllowedDomains } from "@/lib/admin/config-queries";
import { NoAccess } from "@/components/admin/admin-nav";
import { SettingsEditor } from "@/components/admin/settings-editor";

export const metadata = { title: "Settings" };

export default async function SettingsAdminPage() {
  const user = await requireUser();
  if (!(await isAdmin(user))) return <NoAccess />;
  const [settings, domains] = await Promise.all([getAdminSettings(), getAllowedDomains()]);
  return (
    <SettingsEditor
      settings={settings}
      domains={domains.map((d) => d.domain)}
      superAdmin={isSuperAdmin(user) && !user.impersonatedBy}
      aiReady={aiAvailable()}
    />
  );
}
