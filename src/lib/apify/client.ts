import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { actorPath } from "./template";

/**
 * Minimal Apify API v2 client over fetch (no SDK; works in any runtime).
 * - Token: env APIFY_TOKEN, else the org-level integration_connections row (provider "apify", userId null), decrypted
 *   server-side only (SCOUT-26). The token is sent as a Bearer header and never logged or returned to clients.
 * - Short jobs:  POST /v2/acts/{user~actor}/run-sync-get-dataset-items  (≤ 300 s, returns dataset items)
 * - Long jobs:   POST /v2/acts/{user~actor}/runs  (+ ad-hoc webhook) → GET /v2/actor-runs/{id} → GET /v2/datasets/{id}/items
 */
/** Override only for local fixture servers / egress proxies (server env, never user input). */
export const APIFY_BASE = (process.env.APIFY_API_BASE || "https://api.apify.com/v2").replace(/\/$/, "");
/** run-sync endpoints return 408 after 300 s; keep a margin. */
export const SYNC_MAX_SECS = 280;

export class ApifyError extends Error {
  constructor(
    message: string,
    public status: number | null = null,
    public retriable = false,
  ) {
    super(message);
    this.name = "ApifyError";
  }
}

export type ApifyTokenSource = "env" | "org";

export async function getApifyToken(): Promise<{ token: string; source: ApifyTokenSource } | null> {
  if (env.apifyToken) return { token: env.apifyToken, source: "env" };
  const [row] = await db
    .select({ secret: s.integrationConnections.secretEncrypted, status: s.integrationConnections.status })
    .from(s.integrationConnections)
    .where(and(eq(s.integrationConnections.provider, "apify"), isNull(s.integrationConnections.userId)));
  if (!row?.secret || row.status === "revoked") return null;
  try {
    return { token: decryptSecret(row.secret), source: "org" };
  } catch {
    return null;
  }
}

export async function apifyConfigured(): Promise<boolean> {
  return (await getApifyToken()) != null;
}

async function call<T>(token: string, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ data: T; headers: Headers }> {
  const { timeoutMs = 30_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${APIFY_BASE}${path}`, {
      ...rest,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(rest.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (e) {
    const name = (e as Error)?.name;
    throw new ApifyError(name === "TimeoutError" || name === "AbortError" ? "Apify request timed out" : "Could not reach Apify", null, true);
  }
  if (!res.ok) {
    let msg = `Apify API error ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string; type?: string } };
      if (body?.error?.message) msg = `${msg}: ${body.error.message.slice(0, 200)}`;
    } catch {
      /* non-JSON error body */
    }
    throw new ApifyError(msg, res.status, res.status === 408 || res.status === 429 || res.status >= 500);
  }
  const data = (await res.json()) as T;
  return { data, headers: res.headers };
}

export type RunOptions = {
  actorId: string;
  input: Record<string, unknown>;
  timeoutSecs?: number;
  maxItems?: number;
  /** Pay-per-result actors stop charging past this (budget guard). */
  maxTotalChargeUsd?: number;
};

function runQuery(o: RunOptions, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  if (o.timeoutSecs) q.set("timeout", String(Math.max(10, Math.round(o.timeoutSecs))));
  if (o.maxItems) q.set("maxItems", String(Math.max(1, Math.round(o.maxItems))));
  if (o.maxTotalChargeUsd != null && o.maxTotalChargeUsd > 0) q.set("maxTotalChargeUsd", o.maxTotalChargeUsd.toFixed(4));
  return q.toString();
}

/** Short job: run and return dataset items in one call (Apify returns 408 if the run exceeds 300 s). */
export async function runActorSync(token: string, o: RunOptions): Promise<unknown[]> {
  const timeoutSecs = Math.min(o.timeoutSecs ?? 120, SYNC_MAX_SECS);
  const qs = runQuery({ ...o, timeoutSecs }, { clean: "true", format: "json" });
  const { data } = await call<unknown>(token, `/acts/${actorPath(o.actorId)}/run-sync-get-dataset-items?${qs}`, {
    method: "POST",
    body: JSON.stringify(o.input),
    timeoutMs: (timeoutSecs + 20) * 1000,
  });
  if (!Array.isArray(data)) throw new ApifyError("Unexpected response from Apify (expected dataset items array)");
  return data;
}

export type ApifyRun = {
  id: string;
  actId?: string;
  status: "READY" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMING-OUT" | "TIMED-OUT" | "ABORTING" | "ABORTED" | string;
  defaultDatasetId?: string;
  usageTotalUsd?: number;
  startedAt?: string;
  finishedAt?: string;
};

export const TERMINAL_RUN_STATUSES = ["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"];

/** Long job: start a run with an ad-hoc webhook that calls us back on completion. */
export async function startActorRun(token: string, o: RunOptions & { webhookUrl?: string }): Promise<ApifyRun> {
  const extra: Record<string, string> = {};
  if (o.webhookUrl) {
    const hooks = [
      {
        eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.TIMED_OUT", "ACTOR.RUN.ABORTED"],
        requestUrl: o.webhookUrl,
      },
    ];
    extra.webhooks = Buffer.from(JSON.stringify(hooks), "utf8").toString("base64");
  }
  const { data } = await call<{ data: ApifyRun }>(token, `/acts/${actorPath(o.actorId)}/runs?${runQuery(o, extra)}`, {
    method: "POST",
    body: JSON.stringify(o.input),
  });
  return data.data;
}

export async function getRun(token: string, runId: string): Promise<ApifyRun> {
  if (!/^[A-Za-z0-9]{8,32}$/.test(runId)) throw new ApifyError("Invalid run id");
  const { data } = await call<{ data: ApifyRun }>(token, `/actor-runs/${runId}`);
  return data.data;
}

export async function getDatasetItems(token: string, datasetId: string, limit = 1000): Promise<unknown[]> {
  if (!/^[A-Za-z0-9]{8,32}$/.test(datasetId)) throw new ApifyError("Invalid dataset id");
  const { data } = await call<unknown>(token, `/datasets/${datasetId}/items?clean=true&format=json&limit=${Math.max(1, Math.min(10_000, limit))}`, { timeoutMs: 60_000 });
  if (!Array.isArray(data)) throw new ApifyError("Unexpected dataset response");
  return data;
}

/** Validate a token by reading the account it belongs to. Returns the Apify username. */
export async function verifyApifyToken(token: string): Promise<{ username: string; plan: string | null }> {
  const { data } = await call<{ data: { username?: string; plan?: { id?: string } } }>(token, "/users/me", { timeoutMs: 15_000 });
  return { username: data.data?.username ?? "unknown", plan: data.data?.plan?.id ?? null };
}
