/**
 * Pure retry / token-refresh rules for Google REST calls (unit-tested; no server deps).
 *
 * - CR H-1: only idempotent requests (GET/HEAD) are retried inside `googleFetch`. A POST such as `messages/send` or
 *   `drafts` that Gmail accepted but answered with a 5xx would otherwise be delivered 2–4 times. Non-idempotent calls
 *   surface the error to the caller (the sequence runner's intent/reconcile ledger handles ambiguous sends).
 * - CR M-8: a failed token refresh only counts as a revoked grant when Google says so (`invalid_grant`, or a 401/400
 *   client error naming the client/grant). Network errors, timeouts and 5xx are transient: retry with backoff, never
 *   pause every sequence of the rep.
 */

export function isIdempotentMethod(method: string | null | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD";
}

/** Default retry budget for a Google REST call: 3 for reads, 0 for anything that changes state. */
export function defaultRetries(method: string | null | undefined): number {
  return isIdempotentMethod(method) ? 3 : 0;
}

export function isRetryableStatus(status: number, reason: string | null): boolean {
  return status === 429 || status >= 500 || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
}

export type RefreshFailureKind = "revoked" | "transient";

/**
 * Classify a failed OAuth refresh against Google's token endpoint.
 * `status` = HTTP status (0 when the request never completed), `error` = the OAuth `error` field.
 */
export function classifyRefreshFailure(status: number, error: string | null | undefined): RefreshFailureKind {
  const e = (error ?? "").toLowerCase();
  if (e === "invalid_grant" || e === "unauthorized_client" || e === "invalid_client" || e === "access_denied") return "revoked";
  if (status === 401) return "revoked";
  // 400 without a recognised OAuth error, 429, 5xx and network failures are retried later
  return "transient";
}
