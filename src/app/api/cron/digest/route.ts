import { isAuthorizedCron, unauthorized } from "@/lib/alerts/cron";
import { sendDailyDigests, sendWeeklyManagerDigests } from "@/lib/notifications/digest";

/**
 * Daily "My Day" digest (NOT-2) at 12:00 UTC (≈ 08:00 New York). On Mondays (UTC) it also sends the weekly
 * manager digest (NOT-3). `?weekly=1` forces the weekly digest (still deduped to one per manager per week).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return unauthorized();
  const now = new Date();
  const daily = await sendDailyDigests(now);
  const forceWeekly = new URL(req.url).searchParams.get("weekly") === "1";
  const weekly = forceWeekly || now.getUTCDay() === 1 ? await sendWeeklyManagerDigests(now) : null;
  return Response.json({ ok: true, daily, weekly });
}
