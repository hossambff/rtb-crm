import { isAuthorizedCron, unauthorized } from "@/lib/alerts/cron";
import { takePipelineSnapshot } from "@/lib/notifications/snapshots";
import { pregenerateForecasts } from "@/lib/forecast/pregenerate";

/**
 * Nightly pipeline snapshot at 23:55 UTC → rso.pipeline_snapshots (upsert by takenOn × pipeline × stage), then this
 * week's forecast entries for every rep with open deals (bounded; never fails the snapshot).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return unauthorized();
  const started = Date.now();
  const res = await takePipelineSnapshot();
  const forecast = await pregenerateForecasts({ deadlineMs: started + 100_000 });
  return Response.json({ ok: true, ...res, forecast });
}
