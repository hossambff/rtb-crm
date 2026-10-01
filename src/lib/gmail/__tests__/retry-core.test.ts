import { describe, expect, it } from "vitest";
import { classifyRefreshFailure, defaultRetries, isIdempotentMethod, isRetryableStatus } from "../retry-core";

describe("defaultRetries (CR H-1)", () => {
  it("retries reads only", () => {
    expect(defaultRetries(undefined)).toBe(3);
    expect(defaultRetries("get")).toBe(3);
    expect(defaultRetries("HEAD")).toBe(3);
    expect(defaultRetries("POST")).toBe(0);
    expect(defaultRetries("DELETE")).toBe(0);
    expect(isIdempotentMethod("PUT")).toBe(false);
  });
  it("knows which statuses are retryable", () => {
    expect(isRetryableStatus(503, null)).toBe(true);
    expect(isRetryableStatus(429, null)).toBe(true);
    expect(isRetryableStatus(403, "rateLimitExceeded")).toBe(true);
    expect(isRetryableStatus(400, null)).toBe(false);
  });
});

describe("classifyRefreshFailure (CR M-8)", () => {
  it("treats a revoked grant as revoked", () => {
    expect(classifyRefreshFailure(400, "invalid_grant")).toBe("revoked");
    expect(classifyRefreshFailure(401, "invalid_client")).toBe("revoked");
    expect(classifyRefreshFailure(401, null)).toBe("revoked");
  });
  it("treats network / 5xx / unknown 400 as transient", () => {
    expect(classifyRefreshFailure(0, null)).toBe("transient");
    expect(classifyRefreshFailure(503, null)).toBe("transient");
    expect(classifyRefreshFailure(500, "internal_failure")).toBe("transient");
    expect(classifyRefreshFailure(429, null)).toBe("transient");
    expect(classifyRefreshFailure(400, "something_else")).toBe("transient");
  });
});
