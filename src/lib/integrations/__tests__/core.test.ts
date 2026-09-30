import { describe, expect, it } from "vitest";
import { autonomyLevel, backoffMs, hasScope, readPrefs, safeErrorMessage, shouldSkipForBackoff } from "../core";

describe("integration core", () => {
  it("checks scopes", () => {
    const s = "openid email https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send";
    expect(hasScope(s, "https://www.googleapis.com/auth/gmail.readonly")).toBe(true);
    expect(hasScope(s, "https://www.googleapis.com/auth/calendar.readonly")).toBe(false);
    expect(hasScope(null, "x")).toBe(false);
  });
  it("reads prefs tolerantly", () => {
    expect(readPrefs(null).notifications.emailDigest).toBe("daily");
    const p = readPrefs({ blocklist: ["a.com", 3], notifications: { emailDigest: "bogus" }, signature: "— J" });
    expect(p.blocklist).toEqual(["a.com"]);
    expect(p.signature).toBe("— J");
    expect(p.notifications.emailDigest).toBe("daily");
  });
  it("backs off exponentially with a cap", () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(5 * 60_000);
    expect(backoffMs(3)).toBe(20 * 60_000);
    expect(backoffMs(20)).toBe(6 * 60 * 60_000);
    const now = new Date("2026-09-30T12:00:00Z");
    expect(shouldSkipForBackoff({ nextRetryAt: "2026-09-30T12:05:00Z" }, now)).toBe(true);
    expect(shouldSkipForBackoff({ nextRetryAt: "2026-09-30T11:55:00Z" }, now)).toBe(false);
    expect(shouldSkipForBackoff({}, now)).toBe(false);
  });
  it("redacts secrets in error messages", () => {
    const m = safeErrorMessage(new Error("401 Bearer ya29.abc-def token=xyz123 access_token=foo&x=1"));
    expect(m).not.toContain("ya29.abc");
    expect(m).not.toContain("xyz123");
    expect(m).not.toContain("foo&");
  });
  it("reads autonomy with defaults", () => {
    expect(autonomyLevel({ task_from_commitment: 1 }, "task_from_commitment")).toBe(1);
    expect(autonomyLevel({}, "stage_change")).toBe(1);
    expect(autonomyLevel({ stage_change: 9 }, "stage_change")).toBe(1);
  });
});
