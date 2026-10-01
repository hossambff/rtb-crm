import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ account: {} }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/env", () => ({ env: { googleConfigured: true } }));
vi.mock("better-auth/oauth2", () => ({ decryptOAuthToken: vi.fn() }));
vi.mock("@/lib/integrations/store", () => ({ IntegrationAuthError: class IntegrationAuthError extends Error {} }));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: "backendError", errors: [{ reason: "backendError" }] } }), { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("googleFetch / Gmail send (CR H-1)", () => {
  it("never retries messages/send on a 5xx — the runner's intent ledger owns retries", async () => {
    const { sendMessage } = await import("../client");
    await expect(sendMessage("t", "raw")).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("never retries drafts.create", async () => {
    const { createDraft } = await import("../client");
    await expect(createDraft("t", "raw")).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("still retries idempotent reads", async () => {
    const { getProfile } = await import("../client");
    const p = getProfile("t");
    const done = expect(p).rejects.toThrow(/503/);
    await vi.runAllTimersAsync();
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
