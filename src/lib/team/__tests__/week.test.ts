import { describe, expect, it } from "vitest";
import { isoWeekBounds, isoWeekKey, isoWeekLabel, isoWeeksInYear, isValidIsoWeek, parseIsoWeek, shiftIsoWeek } from "../week";

describe("isoWeekKey", () => {
  it("matches known ISO weeks (UTC)", () => {
    expect(isoWeekKey(new Date("2026-10-01T12:00:00Z"))).toBe("2026-W40");
    expect(isoWeekKey(new Date("2026-01-01T12:00:00Z"))).toBe("2026-W01"); // Thursday → week 1
    expect(isoWeekKey(new Date("2021-01-03T12:00:00Z"))).toBe("2020-W53"); // Sunday belongs to 2020's last week
    expect(isoWeekKey(new Date("2024-12-30T12:00:00Z"))).toBe("2025-W01"); // Monday of 2025-W01
    expect(isoWeekKey(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
  });

  it("uses the user's local day, not UTC", () => {
    // Monday 02:00 UTC is still Sunday evening in New York → previous ISO week
    const d = new Date("2026-10-05T02:00:00Z");
    expect(isoWeekKey(d, "UTC")).toBe("2026-W41");
    expect(isoWeekKey(d, "America/New_York")).toBe("2026-W40");
    // Sunday 23:00 UTC is already Monday in Tokyo
    expect(isoWeekKey(new Date("2026-10-04T23:00:00Z"), "Asia/Tokyo")).toBe("2026-W41");
  });
});

describe("parse / bounds / shift", () => {
  it("validates keys", () => {
    expect(parseIsoWeek("2026-W40")).toEqual({ year: 2026, week: 40 });
    expect(isValidIsoWeek("2026-W54")).toBe(false);
    expect(isValidIsoWeek("2026-W53")).toBe(true);
    expect(isValidIsoWeek("2025-W53")).toBe(false);
    expect(isValidIsoWeek("2026-W00")).toBe(false);
    expect(isValidIsoWeek("2026W40")).toBe(false);
    expect(isoWeeksInYear(2020)).toBe(53);
    expect(isoWeeksInYear(2025)).toBe(52);
  });

  it("returns Monday 00:00 local bounds", () => {
    const b = isoWeekBounds("2026-W40", "UTC")!;
    expect(b.start.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(b.end.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    const ny = isoWeekBounds("2026-W40", "America/New_York")!;
    expect(ny.start.toISOString()).toBe("2026-09-28T04:00:00.000Z");
    expect(isoWeekBounds("nope")).toBeNull();
  });

  it("round-trips keys through bounds", () => {
    for (const key of ["2026-W01", "2026-W40", "2026-W53", "2020-W53"]) {
      const b = isoWeekBounds(key, "America/Los_Angeles")!;
      expect(isoWeekKey(b.start, "America/Los_Angeles")).toBe(key);
      expect(isoWeekKey(new Date(b.end.getTime() - 1), "America/Los_Angeles")).toBe(key);
    }
  });

  it("shifts across year boundaries", () => {
    expect(shiftIsoWeek("2026-W40", -1)).toBe("2026-W39");
    expect(shiftIsoWeek("2026-W01", -1)).toBe("2025-W52");
    expect(shiftIsoWeek("2026-W53", 1)).toBe("2027-W01");
    expect(shiftIsoWeek("bad", 1)).toBeNull();
  });

  it("labels", () => {
    expect(isoWeekLabel("2026-W40")).toBe("Week 40 · 28 Sept – 4 Oct".replace("Sept", new Date(Date.UTC(2026, 8, 28)).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })));
  });
});
