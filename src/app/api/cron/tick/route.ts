import { isAuthorizedCron, unauthorized } from "@/lib/alerts/cron";
import { runTick } from "@/lib/tick";

/**
 * Every-5-minutes tick, driven by Supabase pg_cron + pg_net (Vercel Hobby crons are daily only). See docs/V2_SPEC.md.
 * Accepts GET (Vercel/curl) and POST (pg_net).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: Request) {
  if (!isAuthorizedCron(req)) return unauthorized();
  const jobs = await runTick();
  return Response.json({ ok: jobs.every((j) => j.ok), jobs });
}
export const GET = handle;
export const POST = handle;
