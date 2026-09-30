import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runScheduledSync } from "@/lib/integrations/sync-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Scheduled sync (suggested schedule: every 5–10 min): Gmail (backfill → history), Calendar (−2d…+14d),
 * Granola notes, then pending email analysis — per connected user, least-recently-synced first, with backoff.
 */
async function handle(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  const res = await runScheduledSync(started + 240_000);
  return NextResponse.json({
    ok: true,
    users: res.users,
    processed: res.processed,
    ms: Date.now() - started,
    // summary only — no message content
    reports: res.reports.map((r) => ({ userId: r.userId, gmail: r.gmail, calendar: r.calendar, granola: r.granola, analyzed: r.analyzed })),
  });
}

export const GET = handle;
export const POST = handle;
