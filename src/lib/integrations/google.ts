import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { account } from "@/db/schema";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { IntegrationAuthError } from "./store";
import { hasScope } from "./core";
import { decryptOAuthToken } from "better-auth/oauth2";
import { classifyRefreshFailure, defaultRetries, isRetryableStatus, type RefreshFailureKind } from "@/lib/gmail/retry-core";

export async function getGoogleAccount(userId: string) {
  const [row] = await db
    .select({ id: account.id, scope: account.scope, accountId: account.accountId, refreshToken: account.refreshToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "google")))
    .orderBy(desc(account.updatedAt))
    .limit(1);
  return row ?? null;
}

export async function googleScopeStatus(userId: string, scopes: string[]) {
  const acct = await getGoogleAccount(userId);
  return { linked: Boolean(acct), granted: Object.fromEntries(scopes.map((s) => [s, hasScope(acct?.scope, s)])) as Record<string, boolean> };
}

/**
 * A token refresh failed for a reason that is probably temporary (network, Google 5xx, timeout). Callers retry with
 * backoff; it must NOT be treated as "access revoked" (CR M-8: a 2 s OAuth blip used to pause every sequence).
 */
export class GoogleTokenTransientError extends Error {
  constructor(message = "Couldn't reach Google to refresh access. Will retry shortly.") {
    super(message);
    this.name = "GoogleTokenTransientError";
  }
}

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Better Auth swallows the refresh error, so when it fails we ask Google once more ourselves to learn WHY.
 * Only `invalid_grant`-style answers mean the grant is gone; anything else is transient. When this direct refresh
 * succeeds (the first failure was a blip) its token is used for this call. Never logs token material.
 */
async function diagnoseRefresh(storedRefreshToken: string | null): Promise<{ kind: "ok"; token: string } | { kind: RefreshFailureKind }> {
  if (!storedRefreshToken) return { kind: "revoked" };
  let status = 0;
  let error: string | null = null;
  try {
    const ctx = await auth.$context;
    const refreshToken = await decryptOAuthToken(storedRefreshToken, ctx as unknown as Parameters<typeof decryptOAuthToken>[1]);
    if (!refreshToken) return { kind: "revoked" };
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID ?? "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    status = res.status;
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (res.ok && body.access_token) return { kind: "ok", token: body.access_token };
    error = body.error ?? null;
  } catch {
    return { kind: "transient" };
  }
  return { kind: classifyRefreshFailure(status, error) };
}

/**
 * Fresh Google access token via Better Auth (refreshes when expired). Never log the returned value.
 * Throws IntegrationAuthError when access is missing/revoked (reconnect needed) and GoogleTokenTransientError when the
 * refresh failed for a temporary reason (retry later).
 */
export async function getGoogleAccessToken(userId: string, requiredScope?: string): Promise<string> {
  if (!env.googleConfigured) throw new IntegrationAuthError("Google OAuth isn't configured on this server (GOOGLE_CLIENT_ID).");
  const acct = await getGoogleAccount(userId);
  if (!acct) throw new IntegrationAuthError("No Google account is linked. Connect your inbox in Settings.");
  if (requiredScope && !hasScope(acct.scope, requiredScope)) {
    throw new IntegrationAuthError("Google permission missing. Reconnect your inbox in Settings to grant access.");
  }
  try {
    const res = await auth.api.getAccessToken({ body: { accountId: acct.id, userId } });
    if (res?.accessToken) return res.accessToken;
  } catch {
    /* diagnosed below */
  }
  const d = await diagnoseRefresh(acct.refreshToken);
  if (d.kind === "ok") return d.token;
  if (d.kind === "revoked") throw new IntegrationAuthError("Google access expired or was revoked. Reconnect your inbox in Settings.");
  throw new GoogleTokenTransientError();
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public reason: string | null = null,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch against Google REST APIs; maps 401/403 to IntegrationAuthError.
 * Retries 429/5xx ONLY for idempotent methods by default (CR H-1): a POST like messages/send or drafts.create is never
 * repeated here — Gmail may have accepted it before answering 5xx, and a blind retry would deliver it again.
 */
export async function googleFetch<T>(token: string, url: string, init: RequestInit = {}, retries = defaultRetries(init.method)): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
    let message = `Google API ${res.status}`;
    let reason: string | null = null;
    try {
      const body = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[]; status?: string } };
      message = `Google API ${res.status}: ${body.error?.message ?? res.statusText}`;
      reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? null;
    } catch {
      /* non-JSON error */
    }
    if (isRetryableStatus(res.status, reason) && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 500 * 2 ** attempt);
      continue;
    }
    if (res.status === 401) throw new IntegrationAuthError("Google rejected the access token. Reconnect your inbox in Settings.");
    if (res.status === 403 && reason !== "rateLimitExceeded" && reason !== "userRateLimitExceeded") {
      throw new IntegrationAuthError(`Google denied access (${reason ?? "forbidden"}). Reconnect your inbox in Settings.`);
    }
    throw new GoogleApiError(message, res.status, reason);
  }
}
