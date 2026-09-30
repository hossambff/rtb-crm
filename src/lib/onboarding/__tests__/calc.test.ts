import { describe, expect, it } from "vitest";
import { checklistProgress, defaultChecklist, hasSlipped, isStalled, stageTransition } from "../calc";

const now = new Date("2026-09-30T12:00:00Z");
const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("onboarding calc", () => {
  it("stall and slip", () => {
    expect(isStalled({ stage: "scoping", stageEnteredAt: d("2026-09-10") }, now)).toBe(true);
    expect(isStalled({ stage: "launched", stageEnteredAt: d("2026-01-10") }, now)).toBe(false);
    expect(hasSlipped({ targetGoLive: d("2026-09-01"), actualGoLive: null, launched: false }, now)).toBe(true);
    expect(hasSlipped({ targetGoLive: d("2026-09-01"), actualGoLive: null, launched: true }, now)).toBe(false);
  });
  it("checklist + transition", () => {
    const c = defaultChecklist();
    expect(c).toHaveLength(9);
    expect(checklistProgress([{ done: true }, { done: false }]).pct).toBe(0.5);
    expect(stageTransition({ launched: false, actualGoLive: null }, "launched", now)).toEqual({ launched: true, actualGoLive: now });
  });
});
