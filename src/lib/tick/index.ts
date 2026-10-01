import "server-only";
import { runDueSequences } from "@/lib/sequences/runner";
import { prepareUpcomingMeetingBriefs } from "@/lib/briefs/meeting";
import { escalateOverdueApprovals } from "@/lib/approvals/sla";
import { detectClosedDealsForStories } from "@/lib/team/stories";
import { escalateStaleHandoffs } from "@/lib/handoffs/escalation";

/**
 * The 5-minute tick (docs/V2_SPEC.md §Scheduler). Vercel Hobby only allows daily crons, so Supabase pg_cron + pg_net
 * call /api/cron/tick every 5 minutes with the CRON_SECRET bearer. Each job is isolated: one failure never stops the rest,
 * and the whole tick stays inside a wall-clock budget so overlapping ticks don't pile up.
 */
const BUDGET_MS = 240_000;

type JobResult = { job: string; ok: boolean; ms: number; result?: unknown; error?: string };

async function run(job: string, fn: () => Promise<unknown>): Promise<JobResult> {
  const t = Date.now();
  try {
    return { job, ok: true, ms: Date.now() - t, result: await fn() };
  } catch (e) {
    const error = e instanceof Error ? e.message.split("\nparams:")[0].slice(0, 200) : "error";
    console.error(`[tick] ${job} failed`, error);
    return { job, ok: false, ms: Date.now() - t, error };
  }
}

export async function runTick(now = Date.now()): Promise<JobResult[]> {
  const deadlineMs = now + BUDGET_MS;
  // Independent jobs run concurrently; the DB client's in-flight limiter keeps the pooler safe.
  return Promise.all([
    run("sequences", () => runDueSequences({ limit: 50, deadlineMs })),
    run("meeting_briefs", () => prepareUpcomingMeetingBriefs({ withinMin: 45, deadlineMs })),
    run("approval_sla", () => escalateOverdueApprovals()),
    run("stories", () => detectClosedDealsForStories({ deadlineMs })),
    run("handoff_escalation", () => escalateStaleHandoffs({ deadlineMs })),
  ]);
}
