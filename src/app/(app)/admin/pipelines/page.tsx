import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { getDealCustomFieldKeys, getPipelinesWithStages } from "@/lib/admin/config-queries";
import { PipelinesEditor } from "@/components/admin/pipelines-editor";

export const metadata = { title: "Pipelines & stages" };

export default async function PipelinesAdminPage() {
  const user = await requireUser();
  if (!(await isAdmin(user))) forbidden(); // NEW-1: real 403
  const [pipelines, customFields] = await Promise.all([getPipelinesWithStages(), getDealCustomFieldKeys()]);
  return <PipelinesEditor pipelines={pipelines} customFields={customFields} />;
}
