import { isAuthorizedCron, unauthorized } from "@/lib/alerts/cron";
import { takePipelineSnapshot } from "@/lib/notifications/snapshots";

/** Nightly pipeline snapshot at 23:55 UTC → rso.pipeline_snapshots (upsert by takenOn × pipeline × stage). */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return unauthorized();
  const res = await takePipelineSnapshot();
  return Response.json({ ok: true, ...res });
}
