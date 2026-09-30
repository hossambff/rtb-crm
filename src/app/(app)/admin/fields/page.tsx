import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { getFieldDefs, getPicklists, getPipelineOptions } from "@/lib/admin/config-queries";
import { FieldsEditor } from "@/components/admin/fields-editor";
import { PicklistsEditor } from "@/components/admin/picklists-editor";

export const metadata = { title: "Fields & picklists" };

export default async function FieldsAdminPage() {
  const user = await requireUser();
  if (!(await isAdmin(user))) forbidden(); // NEW-1: real 403
  const [fields, pipelines, picklists] = await Promise.all([getFieldDefs(), getPipelineOptions(), getPicklists()]);
  return (
    <>
      <FieldsEditor fields={fields} pipelines={pipelines} />
      <PicklistsEditor values={picklists} />
    </>
  );
}
