import "server-only";
import { isSlackResponseUrl } from "./core";

/**
 * Minimal Slack Web API client. Every call has a hard timeout (3 s by default — Slack's own interactivity budget),
 * never throws, and never logs the token or message content.
 */
export type SlackResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string };

const FORM_METHODS = new Set(["users.lookupByEmail", "users.info", "auth.test", "conversations.info"]);

export async function slackCall<T = Record<string, unknown>>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  opts: { timeoutMs?: number } = {},
): Promise<SlackResult<T>> {
  try {
    const form = FORM_METHODS.has(method);
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": form ? "application/x-www-form-urlencoded; charset=utf-8" : "application/json; charset=utf-8",
      },
      body: form
        ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString()
        : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
      cache: "no-store",
    });
    if (res.status === 429) return { ok: false, error: "rate_limited" };
    const json = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
    if (!json) return { ok: false, error: `http_${res.status}` };
    if (!json.ok) return { ok: false, error: typeof json.error === "string" ? json.error.slice(0, 80) : "unknown_error" };
    return json as { ok: true } & T;
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network_error" };
  }
}

/** Reply through an interaction/command response_url (only ever hooks.slack.com). */
export async function postToResponseUrl(url: string, body: Record<string, unknown>): Promise<boolean> {
  if (!isSlackResponseUrl(url)) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Log a Slack failure without content or secrets. */
export function logSlack(where: string, error: string) {
  console.error(`[slack] ${where}: ${error.replace(/[^\w.:-]/g, "").slice(0, 80)}`);
}
