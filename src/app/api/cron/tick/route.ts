import { createHash, timingSafeEqual } from "node:crypto";
import { isAuthorizedCron, unauthorized } from "@/lib/alerts/cron";
import { getSetting } from "@/lib/settings";
import { runTick } from "@/lib/tick";

/**
 * Every-5-minutes tick, driven by Supabase pg_cron + pg_net (Vercel Hobby crons are daily only). See docs/DEPLOY.md §9.
 * Accepts GET (Vercel/curl) and POST (pg_net).
 *
 * Auth: the Vercel CRON_SECRET bearer, or the scheduler's own secret. That one is generated inside Postgres, kept in
 * Supabase Vault for pg_cron, and only its sha256 is stored in app_settings (`tick.secret_sha256`) — the plaintext
 * never leaves the database.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function schedulerAuthorized(req: Request): Promise<boolean> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ") || header.length < 40) return false;
  const expected = await getSetting<string | null>("tick.secret_sha256", null).catch(() => null);
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) return false;
  const got = createHash("sha256").update(header.slice(7)).digest();
  return timingSafeEqual(got, Buffer.from(expected, "hex"));
}

async function handle(req: Request) {
  if (!isAuthorizedCron(req) && !(await schedulerAuthorized(req))) return unauthorized();
  const jobs = await runTick();
  return Response.json({ ok: jobs.every((j) => j.ok), jobs });
}
export const GET = handle;
export const POST = handle;
