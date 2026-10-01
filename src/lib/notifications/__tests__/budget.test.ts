import { describe, expect, it } from "vitest";
import { bundledSection, clampBudget, decideDelivery, inQuietHours } from "../budget-core";
import { composeDailyDigest } from "../digest-core";

const base = { kind: "alert", severity: "warning" as const, sentToday: 0, budget: 3, minSeverity: "warning" as const, localHour: 11, quietStart: 20, quietEnd: 8 };

describe("alert budget", () => {
  it("interrupts within budget, bundles beyond it", () => {
    expect(decideDelivery({ ...base, sentToday: 2 })).toMatchObject({ digestOnly: false, slack: true, reason: "within_budget" });
    expect(decideDelivery({ ...base, sentToday: 3 })).toMatchObject({ digestOnly: true, slack: false, reason: "over_budget" });
  });
  it("critical always interrupts, even over budget and in quiet hours", () => {
    expect(decideDelivery({ ...base, severity: "critical", sentToday: 99, localHour: 23 })).toEqual({ digestOnly: false, slack: true, reason: "critical" });
  });
  it("people-driven kinds are never budgeted", () => {
    for (const kind of ["mention", "approval", "task", "digest", "handoff", "help", "assignment"]) expect(decideDelivery({ ...base, kind, sentToday: 99 }).digestOnly).toBe(false);
  });
  it("system notifications are budgeted", () => {
    expect(decideDelivery({ ...base, kind: "system", severity: null, sentToday: 3 }).digestOnly).toBe(true);
  });
  it("alerts below the user's minimum severity are bundled", () => {
    expect(decideDelivery({ ...base, severity: "info" })).toMatchObject({ digestOnly: true, reason: "below_min_severity" });
    expect(decideDelivery({ ...base, severity: "info", minSeverity: "info" }).digestOnly).toBe(false);
  });
  it("quiet hours keep Slack silent but still count in-app", () => {
    expect(decideDelivery({ ...base, localHour: 22 })).toMatchObject({ digestOnly: false, slack: false });
    expect(decideDelivery({ ...base, kind: "mention", localHour: 6 })).toMatchObject({ digestOnly: false, slack: false });
  });
  it("clamps the budget to 1..10", () => {
    expect(clampBudget(0)).toBe(1);
    expect(clampBudget(50)).toBe(10);
    expect(clampBudget("x")).toBe(3);
    expect(decideDelivery({ ...base, budget: 0, sentToday: 0 }).digestOnly).toBe(false);
  });
  it("quiet hours wrap midnight; equal bounds = none", () => {
    expect(inQuietHours(23, 20, 8)).toBe(true);
    expect(inQuietHours(7, 20, 8)).toBe(true);
    expect(inQuietHours(8, 20, 8)).toBe(false);
    expect(inQuietHours(13, 12, 14)).toBe(true);
    expect(inQuietHours(13, 9, 9)).toBe(false);
    expect(inQuietHours(null, 20, 8)).toBe(false);
  });
});

describe("Bundled for you", () => {
  it("lists bundled items, capped", () => {
    expect(bundledSection([])).toBeNull();
    const s = bundledSection(Array.from({ length: 10 }, (_, i) => ({ title: `A${i}` })), 3)!;
    expect(s).toContain("Bundled for you (10 quiet updates)");
    expect(s).toContain("• A2");
    expect(s).not.toContain("• A3");
    expect(s).toContain("7 more");
  });
  it("composes with the Today text and keeps the Today title prefix", () => {
    expect(composeDailyDigest(null, null)).toBeNull();
    expect(composeDailyDigest(null, "Bundled for you (1 quiet update):\n• X")!.title.startsWith("Today")).toBe(true);
    const d = composeDailyDigest({ title: "Today: plan", body: "• 1 task" }, "Bundled…")!;
    expect(d.body).toBe("• 1 task\n\nBundled…");
  });
});

describe("Bundled for you — MNPI (SEC H-1)", () => {
  it("never names sensitive rows; counts them in one neutral line", () => {
    const s = bundledSection([
      { title: "Idle past SLA: Arena acquisition", sensitive: true },
      { title: "Brief ready: TheStreet in 30 min", sensitive: true },
      { title: "No notes: Weekly sync", sensitive: false },
    ])!;
    expect(s).not.toContain("Arena");
    expect(s).not.toContain("TheStreet");
    expect(s).toContain("• No notes: Weekly sync");
    expect(s).toContain("2 updates about restricted records");
    expect(s).toContain("Bundled for you (3 quiet updates)");
  });
  it("a single sensitive row reads naturally", () => {
    const s = bundledSection([{ title: "Secret deal", sensitive: true }])!;
    expect(s).toContain("1 update about a restricted record");
    expect(s).not.toContain("Secret");
  });
  it("the cap applies to named rows only; the restricted count is always shown", () => {
    const items = [...Array.from({ length: 5 }, (_, i) => ({ title: `A${i}` })), { title: "X", sensitive: true }];
    const s = bundledSection(items, 2)!;
    expect(s).toContain("3 more");
    expect(s).toContain("1 update about a restricted record");
    expect(s).not.toContain("• X");
  });
  it("the composed digest never contains a sensitive title", () => {
    const d = composeDailyDigest(null, bundledSection([{ title: "Restricted: Paradium merger", sensitive: true }]))!;
    expect(`${d.title}\n${d.body}`).not.toContain("Paradium");
  });
});
