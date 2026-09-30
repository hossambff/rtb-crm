import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { account } from "@/db/schema";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { IntegrationAuthError } from "./store";
import { hasScope } from "./core";

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

/** Fresh Google access token via Better Auth (refreshes when expired). Never log the returned value. */
export async function getGoogleAccessToken(userId: string, requiredScope?: string): Promise<string> {
  if (!env.googleConfigured) throw new IntegrationAuthError("Google OAuth isn't configured on this server (GOOGLE_CLIENT_ID).");
  const acct = await getGoogleAccount(userId);
  if (!acct) throw new IntegrationAuthError("No Google account is linked. Connect your inbox in Settings.");
  if (requiredScope && !hasScope(acct.scope, requiredScope)) {
    throw new IntegrationAuthError("Google permission missing. Reconnect your inbox in Settings to grant access.");
  }
  try {
    const res = await auth.api.getAccessToken({ body: { accountId: acct.id, userId } });
    if (!res?.accessToken) throw new Error("empty token");
    return res.accessToken;
  } catch {
    throw new IntegrationAuthError("Google access expired or was revoked. Reconnect your inbox in Settings.");
  }
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

/** fetch against Google REST APIs with retry on 429/5xx; maps 401/403 to IntegrationAuthError. */
export async function googleFetch<T>(token: string, url: string, init: RequestInit = {}, retries = 3): Promise<T> {
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
    const retryable = res.status === 429 || res.status >= 500 || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
    if (retryable && attempt < retries) {
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
