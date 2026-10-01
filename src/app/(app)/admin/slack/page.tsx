import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { getSlaSettings } from "@/lib/approvals/sla";
import { getSlackAdminView } from "@/lib/slack/admin";
import { SlackAdmin } from "@/components/slack/slack-admin";
import { SlaEditor } from "@/components/slack/sla-editor";

export const metadata = { title: "Slack & approvals" };

export default async function SlackAdminPage() {
  const user = await requireUser();
  if (!(await isAdmin(user))) forbidden();
  const [view, sla] = await Promise.all([getSlackAdminView(), getSlaSettings()]);
  return (
    <>
      <SlackAdmin view={view} readOnly={Boolean(user.impersonatedBy)} />
      <SlaEditor initial={sla} />
    </>
  );
}
