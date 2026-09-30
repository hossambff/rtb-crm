import { isAuthorizedCron, unauthorized } from "@/lib/alerts/cron";
import { runSweep } from "@/lib/alerts/engine";

/**
 * Nothing Slips sweep (PRD §12). Target cadence: every 15 min. vercel.json schedules it hourly ("0 * * * *") —
 * Vercel Hobby only allows daily crons, so on Hobby change it to daily or upgrade to Pro for "*\/15 * * * *".
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return unauthorized();
  const stats = await runSweep();
  return Response.json({ ok: stats.failed.length === 0, ...stats });
}
