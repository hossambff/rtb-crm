import "server-only";
import { after } from "next/server";
import { runEnrichment } from "./enrichment";
import { runScout } from "./pipeline";
import { loadRun, saveSteps, stepsOf } from "./runs";

/** Execute (or resume) a run by kind. Errors are persisted on the run, never thrown to callers. */
export async function resumeRun(runId: string): Promise<void> {
  const run = await loadRun(runId);
  if (!run) return;
  try {
    if (run.kind === "scout") await runScout(runId);
    else if (run.kind === "enrich") await runEnrichment(runId);
  } catch (e) {
    console.error("[scout] run failed", runId, e instanceof Error ? e.message : "unknown");
    const fresh = await loadRun(runId);
    if (fresh && !["succeeded", "blocked"].includes(fresh.status))
      await saveSteps(runId, stepsOf(fresh), { status: "failed", error: e instanceof Error && !/^Failed query/i.test(e.message) ? e.message.slice(0, 500) : "Run failed (internal error, logged)", finishedAt: new Date() });
  }
}

/** Kick a run off after the response is sent (Server Action / Route Handler). */
export function runInBackground(runId: string) {
  after(() => resumeRun(runId));
}
