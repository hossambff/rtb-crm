import { after, NextResponse, type NextRequest } from "next/server";
import { getApifyToken } from "@/lib/apify/client";
import { resumeRun } from "@/lib/scout/dispatch";
import { completeAsyncStep, hookTokenMatches, loadRun, stepsOf } from "@/lib/scout/runs";

export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Apify run-completion webhook (ad-hoc webhook registered when an async actor run starts).
 * Verification: the URL carries a random per-step secret; only its SHA-256 is stored on the step, compared in
 * constant time. The payload body is NOT trusted — the run status, dataset and cost are re-fetched from the
 * Apify API with our own token. Idempotent: an already-finished step is a no-op (Apify retries on non-2xx).
 */
export async function POST(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get("run") ?? "";
  const stepKey = req.nextUrl.searchParams.get("step") ?? "";
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!UUID.test(runId) || !/^[a-z_]{2,40}$/.test(stepKey) || token.length < 20) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const run = await loadRun(runId);
  const step = run ? stepsOf(run).find((s) => s.key === stepKey) : undefined;
  if (!run || !step || !hookTokenMatches(token, step.hookHash)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (step.status !== "waiting") return NextResponse.json({ ok: true, idempotent: true });

  const apify = await getApifyToken();
  if (!apify) return NextResponse.json({ error: "apify not configured" }, { status: 503 });
  try {
    const done = await completeAsyncStep(apify.token, runId, stepKey);
    if (done) after(() => resumeRun(runId));
    return NextResponse.json({ ok: true, done });
  } catch {
    // transient Apify/API failure → non-2xx so Apify retries the webhook
    return NextResponse.json({ error: "retry" }, { status: 502 });
  }
}
