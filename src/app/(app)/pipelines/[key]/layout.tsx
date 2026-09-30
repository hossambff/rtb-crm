import { forbidden, notFound } from "next/navigation";
import { requireUser } from "@/lib/rbac/server";
import { getPipelineByKey, pipelinePerms } from "@/lib/deals/queries";

/** NEW-1: answer 403 for pipelines the caller can't view before the board's loading boundary streams. */
export default async function PipelineLayout({ children, params }: LayoutProps<"/pipelines/[key]">) {
  const user = await requireUser();
  const key = (await params).key.toUpperCase();
  if (!(await getPipelineByKey(key))) notFound();
  if (!(await pipelinePerms(user, key)).canView) forbidden();
  return children;
}
