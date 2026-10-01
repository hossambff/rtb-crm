import { forbidden } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { isAdmin } from "@/lib/admin/guard";
import { getAllPipelines, getStagesByPipeline } from "@/lib/deals/queries";
import { listPlaybooksForStages } from "@/lib/playbooks/service";
import { PlaybooksEditor } from "@/components/admin/playbooks-editor";
import { EmptyState } from "@/components/ui/misc";

export const metadata = { title: "Stage playbooks" };

export default async function PlaybooksAdminPage({ searchParams }: PageProps<"/admin/playbooks">) {
  const user = await requireUser();
  if (!(await isAdmin(user))) forbidden();
  const sp = await searchParams;
  const raw = Array.isArray(sp.pipeline) ? sp.pipeline[0] : sp.pipeline;
  const [pipelines, stagesBy] = await Promise.all([getAllPipelines(), getStagesByPipeline()]);
  if (!pipelines.length) return <EmptyState title="No pipelines" description="Run the seed script to install pipelines and stages first." />;
  const pipeline = pipelines.find((p) => p.key === raw?.toUpperCase()) ?? pipelines[0]!;
  const stages = stagesBy[pipeline.id] ?? [];
  const playbooks = await listPlaybooksForStages(stages.map((st) => st.id));
  return (
    <PlaybooksEditor
      pipelines={pipelines.map((p) => ({ key: p.key, name: p.name, color: p.color }))}
      pipelineKey={pipeline.key}
      stages={stages.map((st) => ({ id: st.id, name: st.name, category: st.category, slaDays: st.slaDays, probability: st.probability }))}
      playbooks={playbooks}
    />
  );
}
