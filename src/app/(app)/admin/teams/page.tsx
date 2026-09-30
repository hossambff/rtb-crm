import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { getActiveUsers, getPicklistLabels, getPipelineOptions, getTeams } from "@/lib/admin/config-queries";
import { TeamsEditor } from "@/components/admin/teams-editor";

export const metadata = { title: "Teams" };

export default async function TeamsAdminPage() {
  const user = await requireUser();
  if (!(await isAdmin(user))) forbidden(); // NEW-1: real 403
  const [teams, users, pipelines, lists] = await Promise.all([
    getTeams(),
    getActiveUsers(),
    getPipelineOptions(),
    getPicklistLabels(["league", "category"]),
  ]);
  return (
    <TeamsEditor
      teams={teams}
      users={users}
      pipelines={pipelines.map((p) => ({ key: p.key, name: p.name, color: p.color }))}
      leagues={lists.league ?? []}
      verticals={lists.category ?? []}
    />
  );
}
