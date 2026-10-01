import { describe, expect, it } from "vitest";
import { autopilotSummary, nextStepUntouched, taskStillAutopilots } from "../autopilot-core";

describe("autopilot undo (CR L4)", () => {
  const after = { text: "Send pro forma", due: "2026-10-03T17:00:00.000Z" };
  it("restores the next step only when text AND due date are unchanged", () => {
    expect(nextStepUntouched({ text: "Send pro forma", due: new Date("2026-10-03T17:00:00Z") }, after)).toBe(true);
    expect(nextStepUntouched({ text: "Send pro forma", due: new Date("2026-10-07T17:00:00Z") }, after)).toBe(false);
    expect(nextStepUntouched({ text: "Call legal", due: after.due }, after)).toBe(false);
  });
  it("leaves tasks the rep reassigned, renamed or finished", () => {
    const t = { status: "open", assigneeId: "rep", title: "Send deck" };
    expect(taskStillAutopilots(t, "rep", "Send deck")).toBe(true);
    expect(taskStillAutopilots({ ...t, assigneeId: "other" }, "rep", "Send deck")).toBe(false);
    expect(taskStillAutopilots({ ...t, title: "Send deck v2" }, "rep", "Send deck")).toBe(false);
    expect(taskStillAutopilots({ ...t, status: "done" }, "rep", "Send deck")).toBe(false);
    expect(taskStillAutopilots(t, "rep", undefined)).toBe(true);
  });
});

describe("autopilotSummary (QA MIN-22)", () => {
  it("never says drafted when there was no recipient", () => {
    const s = autopilotSummary({ who: "Acme", tasks: 1, nextStep: false, draft: "needs_recipients" });
    expect(s).toContain("add a recipient");
    expect(s).not.toMatch(/drafted/);
  });
});
