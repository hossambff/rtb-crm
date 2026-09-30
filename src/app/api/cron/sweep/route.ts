import { isAuthorizedCron, unauthorized } from "@/lib/alerts/cron";
import { runSweep } from "@/lib/alerts/engine";
import { recordSweep } from "@/lib/background";

/**
 * Nothing Slips sweep (PRD §12). Target cadence: every 15 min. vercel.json schedules it daily (Vercel Hobby) —
 * on Pro switch it to hourly ("0 * * * *") or "*\/15 * * * *". My Day also triggers a catch-up sweep when the last one is > 60 min old.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return unauthorized();
  const stats = await runSweep();
  await recordSweep();
  return Response.json({ ok: stats.failed.length === 0, ...stats });
}
