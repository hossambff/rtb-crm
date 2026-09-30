import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { env } from "@/lib/env";
import { ApifyError, getDatasetItems, getRun, SYNC_MAX_SECS, startActorRun, TERMINAL_RUN_STATUSES } from "@/lib/apify/client";
import { mapItems, type Purpose, type Quarantined, type RecordFor } from "@/lib/apify/mappers";
import { actorsFor, runPurposeSync } from "@/lib/apify/registry";
import { renderInputTemplate, type TemplateVars } from "@/lib/apify/template";

/**
 * Durable-ish step runner shared by scouting and enrichment (PRD M25.9: resumable, idempotent on completion).
 * Every step's status/cost/output is persisted to enrichment_runs.actors, so a refresh shows progress and a
 * crashed/timed-out invocation can be resumed: finished steps are skipped, "waiting" steps poll Apify or wait for
 * the webhook (/api/webhooks/apify, verified with a per-step secret whose SHA-256 is stored here).
 */

export type StepStatus = "pending" | "running" | "waiting" | "succeeded" | "skipped" | "failed";

export type StepState = {
  key: string;
  label: string;
  purpose?: Purpose;
  actorId: string; // "" for non-actor steps
  status: StepStatus;
  runId?: string; // Apify run id (async steps)
  costUsd?: number;
  costEstimated?: boolean;
  items?: number;
  quarantined?: number;
  quarantineSamples?: Quarantined[];
  note?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  hookHash?: string;
  output?: unknown;
};

export type RunRow = typeof s.enrichmentRuns.$inferSelect;

export function stepsOf(run: Pick<RunRow, "actors">): StepState[] {
  return (run.actors as unknown as StepState[]) ?? [];
}

export async function loadRun(runId: string): Promise<RunRow | null> {
  const [r] = await db.select().from(s.enrichmentRuns).where(eq(s.enrichmentRuns.id, runId));
  return r ?? null;
}

export async function saveSteps(runId: string, steps: StepState[], patch: Partial<typeof s.enrichmentRuns.$inferInsert> = {}) {
  const costUsd = steps.reduce((a, st) => a + (st.costUsd ?? 0), 0);
  await db
    .update(s.enrichmentRuns)
    .set({ actors: steps as unknown as RunRow["actors"], costCents: Math.round(costUsd * 100), ...patch })
    .where(eq(s.enrichmentRuns.id, runId));
}

export function upsertStep(steps: StepState[], st: StepState): StepState[] {
  const i = steps.findIndex((x) => x.key === st.key);
  if (i < 0) return [...steps, st];
  const copy = [...steps];
  copy[i] = st;
  return copy;
}

export function hashHookToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

export function hookTokenMatches(token: string, hash: string | undefined): boolean {
  if (!hash || !token) return false;
  const a = Buffer.from(hashHookToken(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicAppUrl(): string | null {
  try {
    const u = new URL(env.appUrl);
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".localhost")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Run lease (M-12): a DB lease on enrichment_runs.lease_until, so a resume, the Apify webhook and the cron on
 * DIFFERENT instances can't advance the same run at once (double actor starts = real spend). The lease outlives the
 * longest invocation (maxDuration 300 s) and is released at the end; a crashed holder's lease simply expires.
 */
const LEASE_MS = 6 * 60_000;
export async function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T | null> {
  const until = new Date(Date.now() + LEASE_MS);
  const [got] = await db
    .update(s.enrichmentRuns)
    .set({ leaseUntil: until })
    .where(and(eq(s.enrichmentRuns.id, runId), or(isNull(s.enrichmentRuns.leaseUntil), lt(s.enrichmentRuns.leaseUntil, new Date()))))
    .returning({ id: s.enrichmentRuns.id });
  if (!got) return null;
  try {
    return await fn();
  } finally {
    await db
      .update(s.enrichmentRuns)
      .set({ leaseUntil: null })
      .where(and(eq(s.enrichmentRuns.id, runId), eq(s.enrichmentRuns.leaseUntil, until)))
      .catch(() => {});
  }
}

export type StepCtx = {
  runId: string;
  token: string;
  steps: StepState[];
  /** Remaining USD this run may spend (per-run / user / org caps). */
  remainingUsd: () => number;
};

export type ActorStepResult<P extends Purpose> = { state: "done"; records: RecordFor<P>[] } | { state: "waiting" } | { state: "skipped"; note: string };

/**
 * Execute (or reuse) one actor-backed step. Short jobs use run-sync; actors whose registry timeout exceeds the
 * run-sync limit start an async run with a webhook, then poll briefly in-process.
 */
export async function actorStep<P extends Purpose>(
  ctx: StepCtx,
  key: string,
  label: string,
  purpose: P,
  vars: TemplateVars,
  opts: { maxItems?: number; expectedResults: number } = { expectedResults: 1 },
): Promise<ActorStepResult<P>> {
  const existing = ctx.steps.find((x) => x.key === key);
  if (existing?.status === "succeeded") return { state: "done", records: (existing.output as RecordFor<P>[]) ?? [] };
  if (existing?.status === "skipped") return { state: "skipped", note: existing.note ?? "" };
  if (existing?.status === "waiting" && existing.runId) return pollAsync(ctx, existing, purpose);

  const actors = await actorsFor(purpose);
  if (!actors.length) {
    await setStep(ctx, { key, label, purpose, actorId: "", status: "skipped", note: `No compliant actor registered for "${purpose}"` });
    return { state: "skipped", note: "no actor" };
  }
  const primary = actors[0]!;
  const remaining = ctx.remainingUsd();
  const expectedCost = opts.expectedResults * primary.costPerResultUsd;
  if (remaining <= 0 || expectedCost > remaining + 1e-9) {
    // shrink the batch if possible, otherwise skip within budget
    const affordable = primary.costPerResultUsd > 0 ? Math.floor(remaining / primary.costPerResultUsd) : opts.expectedResults;
    if (affordable < 1) {
      await setStep(ctx, { key, label, purpose, actorId: primary.actorId, status: "skipped", note: "Skipped — run budget exhausted" });
      return { state: "skipped", note: "budget" };
    }
    opts = { ...opts, maxItems: Math.min(opts.maxItems ?? affordable, affordable) };
  }
  const started = new Date().toISOString();
  await setStep(ctx, { key, label, purpose, actorId: primary.actorId, status: "running", startedAt: started });

  try {
    if (primary.timeoutSecs > SYNC_MAX_SECS) {
      const hookToken = randomBytes(24).toString("base64url");
      const base = publicAppUrl();
      const maxItems = Math.max(1, Math.min(opts.maxItems ?? primary.maxItems, primary.maxItems || 1000));
      const run = await startActorRun(ctx.token, {
        actorId: primary.actorId,
        input: renderInputTemplate(primary.inputTemplate, { maxItems, ...vars }),
        timeoutSecs: primary.timeoutSecs,
        maxItems,
        maxTotalChargeUsd: remaining,
        webhookUrl: base ? `${base}/api/webhooks/apify?run=${ctx.runId}&step=${encodeURIComponent(key)}&token=${hookToken}` : undefined,
      });
      const waiting: StepState = { key, label, purpose, actorId: primary.actorId, status: "waiting", runId: run.id, hookHash: hashHookToken(hookToken), startedAt: started, note: "Running on Apify (async)" };
      await setStep(ctx, waiting);
      return pollAsync(ctx, waiting, purpose, 45_000);
    }
    const res = await runPurposeSync(ctx.token, purpose, vars, { maxItems: opts.maxItems, maxChargeUsd: remaining > 0 ? remaining : undefined, actors });
    await setStep(ctx, {
      key,
      label,
      purpose,
      actorId: res.actorId,
      status: "succeeded",
      costUsd: res.costUsd,
      costEstimated: res.costEstimated,
      items: res.itemCount,
      quarantined: res.quarantined.length,
      quarantineSamples: res.quarantined.slice(0, 5),
      note: res.attempts.length > 1 ? `Fell back after: ${res.attempts.filter((a) => a.error).map((a) => a.actorId).join(", ")}` : undefined,
      startedAt: started,
      finishedAt: new Date().toISOString(),
      output: res.records,
    });
    return { state: "done", records: res.records };
  } catch (e) {
    const msg = e instanceof ApifyError || e instanceof Error ? e.message : "Actor run failed";
    await setStep(ctx, { key, label, purpose, actorId: primary.actorId, status: "failed", error: msg, startedAt: started, finishedAt: new Date().toISOString() });
    throw e;
  }
}

async function setStep(ctx: StepCtx, st: StepState) {
  ctx.steps = upsertStep(ctx.steps, st);
  await saveSteps(ctx.runId, ctx.steps);
}

/** Poll an async Apify run (used right after start, and on resume if the webhook hasn't arrived). */
async function pollAsync<P extends Purpose>(ctx: StepCtx, st: StepState, purpose: P, budgetMs = 5_000): Promise<ActorStepResult<P>> {
  const deadline = Date.now() + budgetMs;
  while (true) {
    const done = await completeAsyncStep(ctx.token, ctx.runId, st.key);
    if (done) {
      const fresh = await loadRun(ctx.runId);
      if (fresh) ctx.steps = stepsOf(fresh);
      const now = ctx.steps.find((x) => x.key === st.key);
      if (now?.status === "succeeded") return { state: "done", records: (now.output as RecordFor<P>[]) ?? [] };
      throw new ApifyError(now?.error ?? "Actor run failed");
    }
    if (Date.now() > deadline) return { state: "waiting" };
    await new Promise((r) => setTimeout(r, 4_000));
  }
}

/**
 * Finalize an async step if its Apify run is terminal: fetch dataset, map + validate, record the ACTUAL cost
 * (usageTotalUsd). Idempotent — a finished step is left untouched. Returns true when the step is finished.
 */
export async function completeAsyncStep(token: string, runId: string, stepKey: string): Promise<boolean> {
  const run = await loadRun(runId);
  if (!run) return true;
  const steps = stepsOf(run);
  const st = steps.find((x) => x.key === stepKey);
  if (!st || st.status !== "waiting" || !st.runId) return true;
  const apifyRun = await getRun(token, st.runId);
  if (!TERMINAL_RUN_STATUSES.includes(apifyRun.status)) return false;
  let next: StepState;
  if (apifyRun.status === "SUCCEEDED" && apifyRun.defaultDatasetId) {
    const items = await getDatasetItems(token, apifyRun.defaultDatasetId);
    const [actor] = (await actorsFor(st.purpose!)).filter((a) => a.actorId === st.actorId);
    const mapped = mapItems(st.purpose!, items, actor?.outputMapping);
    const actual = typeof apifyRun.usageTotalUsd === "number" ? apifyRun.usageTotalUsd : null;
    next = {
      ...st,
      status: "succeeded",
      costUsd: actual ?? Math.round(items.length * (actor?.costPerResultUsd ?? 0) * 10000) / 10000,
      costEstimated: actual == null,
      items: items.length,
      quarantined: mapped.quarantined.length,
      quarantineSamples: mapped.quarantined.slice(0, 5),
      output: mapped.records,
      finishedAt: new Date().toISOString(),
      note: undefined,
    };
  } else {
    next = {
      ...st,
      status: "failed",
      error: `Apify run ${apifyRun.status.toLowerCase()}`,
      costUsd: typeof apifyRun.usageTotalUsd === "number" ? apifyRun.usageTotalUsd : st.costUsd,
      finishedAt: new Date().toISOString(),
    };
  }
  // re-read to avoid clobbering concurrent step writes
  const latest = await loadRun(runId);
  const merged = upsertStep(latest ? stepsOf(latest) : steps, next);
  await saveSteps(runId, merged);
  return true;
}

/** Record a non-actor step (planning, CRM match, staging…). */
export async function localStep<T>(ctx: StepCtx, key: string, label: string, fn: () => Promise<{ output?: T; note?: string }>): Promise<T | undefined> {
  const existing = ctx.steps.find((x) => x.key === key);
  if (existing?.status === "succeeded") return existing.output as T | undefined;
  const started = new Date().toISOString();
  await setStep(ctx, { key, label, actorId: "", status: "running", startedAt: started });
  try {
    const r = await fn();
    await setStep(ctx, { key, label, actorId: "", status: "succeeded", startedAt: started, finishedAt: new Date().toISOString(), output: r.output, note: r.note });
    return r.output;
  } catch (e) {
    await setStep(ctx, { key, label, actorId: "", status: "failed", startedAt: started, finishedAt: new Date().toISOString(), error: e instanceof Error ? e.message.slice(0, 300) : "failed" });
    throw e;
  }
}

export async function skipStep(ctx: StepCtx, key: string, label: string, note: string) {
  const existing = ctx.steps.find((x) => x.key === key);
  if (existing && existing.status !== "pending") return;
  await setStep(ctx, { key, label, actorId: "", status: "skipped", note });
}
