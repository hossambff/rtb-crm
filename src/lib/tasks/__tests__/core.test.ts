import { describe, expect, it } from "vitest";
import { bucketFor, bucketTasks, fmtInTz, snoozePreset } from "../core";
import { aggregateSnapshot, snapshotDelta } from "../../notifications/snapshot-core";
import { myDayDigestText } from "../../notifications/digest-core";

const NY = "America/New_York";
const NOW = new Date("2026-09-30T15:00:00Z"); // Wed 11:00 NY

describe("task buckets (user timezone)", () => {
  it("overdue / today / upcoming / no date", () => {
    expect(bucketFor({ dueAt: "2026-09-29T15:00:00Z" }, NOW, NY)).toBe("overdue");
    expect(bucketFor({ dueAt: "2026-09-30T14:00:00Z" }, NOW, NY)).toBe("overdue"); // earlier today, already past
    expect(bucketFor({ dueAt: "2026-10-01T03:30:00Z" }, NOW, NY)).toBe("today"); // 23:30 NY
    expect(bucketFor({ dueAt: "2026-10-01T04:30:00Z" }, NOW, NY)).toBe("upcoming"); // 00:30 NY tomorrow
    expect(bucketFor({ dueAt: null }, NOW, NY)).toBe("no_date");
  });
  it("a future snooze wins over an older due date", () => {
    expect(bucketFor({ dueAt: "2026-09-29T15:00:00Z", snoozedUntil: "2026-10-02T13:00:00Z" }, NOW, NY)).toBe("upcoming");
  });
  it("sorts by due then priority", () => {
    const b = bucketTasks(
      [
        { id: "b", dueAt: "2026-10-03T13:00:00Z", priority: "low" },
        { id: "a", dueAt: "2026-10-03T13:00:00Z", priority: "top10" },
        { id: "c", dueAt: "2026-10-02T13:00:00Z", priority: "medium" },
      ],
      NOW,
      NY,
    );
    expect(b.upcoming.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });
  it("formats in the given timezone", () => {
    expect(fmtInTz("2026-09-30T15:00:00Z", NY, "time")).toBe("11:00 AM");
    expect(fmtInTz(null, NY)).toBe("—");
  });
  it("snooze presets land on local 09:00", () => {
    expect(snoozePreset("tomorrow", NOW, NY).toISOString()).toBe("2026-10-01T13:00:00.000Z");
    expect(snoozePreset("nextweek", NOW, NY).toISOString()).toBe("2026-10-05T13:00:00.000Z");
  });
});

describe("pipeline snapshot aggregation", () => {
  const base = {
    pipelineKey: "NET",
    stageKey: "hot",
    unit: "muu" as const,
    muu: 1_000_000,
    usdPerMuu: null,
    pipelineUsdPerMuu: 1,
    revSharePct: null,
    pipelineRevSharePct: 0.5,
    contractValueCents: null,
    annualizedValueCents: null,
    stageProbability: 0.5,
    probabilityOverride: null,
    overrideStatus: null,
  };
  it("counts, gross, weighted, override-weighted per stage (zero rows kept)", () => {
    const rows = aggregateSnapshot(
      [base, { ...base, probabilityOverride: 0.9, overrideStatus: "approved" }, { ...base, probabilityOverride: 0.9, overrideStatus: "pending" }],
      [
        { pipelineKey: "NET", stageKey: "hot" },
        { pipelineKey: "NET", stageKey: "live" },
      ],
    );
    const hot = rows.find((r) => r.stageKey === "hot")!;
    expect(hot.dealCount).toBe(3);
    expect(hot.muu).toBe(3_000_000);
    expect(hot.grossCents).toBe(300_000_000);
    expect(hot.weightedCents).toBe(150_000_000);
    expect(hot.overrideWeightedCents).toBe(50_000_000 + 90_000_000 + 50_000_000);
    expect(rows.find((r) => r.stageKey === "live")!.dealCount).toBe(0);
  });
  it("week-over-week delta", () => {
    const cur = [{ pipelineKey: "NET", stageKey: "hot", dealCount: 5, muu: 0, grossCents: 0, weightedCents: 0, overrideWeightedCents: 1000 }];
    const prev = [{ pipelineKey: "NET", stageKey: "hot", dealCount: 3, muu: 0, grossCents: 0, weightedCents: 0, overrideWeightedCents: 400 }];
    expect(snapshotDelta(cur, prev)).toEqual([{ pipelineKey: "NET", count: 5, countDelta: 2, weightedCents: 1000, weightedDeltaCents: 600 }]);
  });
});

describe("My Day digest text", () => {
  const zero = { overdueTasks: 0, dueToday: 0, commitmentsDue: 0, meetingsToday: 0, awaitingReply: 0, dealsAtRisk: 0, alerts: { critical: 0, serious: 0, warning: 0, info: 0 } };
  it("skips empty days", () => {
    expect(myDayDigestText(zero)).toBeNull();
  });
  it("summarizes counts", () => {
    const t = myDayDigestText({ ...zero, overdueTasks: 2, meetingsToday: 1, alerts: { critical: 1, serious: 0, warning: 2, info: 0 } })!;
    expect(t.title).toBe("Today: 3 items need attention");
    expect(t.body).toContain("2 overdue tasks");
    expect(t.body).toContain("1 meeting today");
    expect(t.body).toContain("3 open alerts (1 critical, 2 warning)");
  });
});
