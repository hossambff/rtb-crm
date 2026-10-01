import { describe, expect, it } from "vitest";
import { reasonShape } from "../core";
import { sumUnscheduled } from "../unscheduled";

describe("forecast persistence ignores day counts (CR L9)", () => {
  it("masks numbers so a daily-changing reason isn't a material change", () => {
    expect(reasonShape("No activity for 8 days\nHealth 41")).toBe(reasonShape("No activity for 9 days\nHealth 40"));
    expect(reasonShape("No activity for 8 days")).not.toBe(reasonShape("Close date pushed"));
    expect(reasonShape(null)).toBe("");
  });
});

describe("Unscheduled bucket", () => {
  const by = {
    "NET|u1": { deals: 2, grossUsd: 100, weightedUsd: 10 },
    "NET|": { deals: 1, grossUsd: 50, weightedUsd: 5 },
    "ENT|u2": { deals: 3, grossUsd: 300, weightedUsd: 30 },
  };
  it("sums everything without filters", () => {
    expect(sumUnscheduled(by, null, null)).toEqual({ deals: 6, grossUsd: 450, weightedUsd: 45 });
  });
  it("applies motion and owner filters", () => {
    expect(sumUnscheduled(by, "NET", null)).toEqual({ deals: 3, grossUsd: 150, weightedUsd: 15 });
    expect(sumUnscheduled(by, null, "u2")).toEqual({ deals: 3, grossUsd: 300, weightedUsd: 30 });
    expect(sumUnscheduled(by, "NET", "u2")).toEqual({ deals: 0, grossUsd: 0, weightedUsd: 0 });
  });
});
