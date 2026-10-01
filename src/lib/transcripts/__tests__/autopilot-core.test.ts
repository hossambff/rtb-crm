import { describe, expect, it } from "vitest";
import { AUTOPILOT_UNDO_MS, autopilotSummary, MAX_AUTO_TASKS, planAutoApply, undoAvailable } from "../autopilot-core";
import { heuristicTranscriptAnalysis } from "../analysis-core";
import { evaluateDraftGuard, firstNameFromEmail, gmailDraftUrl, personalizeDraft, withSignature } from "@/lib/gmail/drafts-core";

const due = new Date("2026-10-06T17:00:00Z");
const item = (id: string, over: Partial<{ owner: string; task: string; due: string | null; evidence: string; timestamp: string | null }> = {}) => ({
  id,
  owner: "us",
  task: `Send the pro forma ${id}`,
  due: null,
  evidence: `I'll send the pro forma ${id}`,
  timestamp: null,
  ...over,
});

describe("planAutoApply", () => {
  it("keeps grounded AI items, drops ungrounded/short/duplicate ones, caps the count", () => {
    const plan = planAutoApply(
      {
        engine: "ai:openai/gpt-5-mini",
        action_items: [
          item("a1"),
          item("a2", { evidence: "" }), // ungrounded
          item("a3", { task: "Call" }), // too short
          item("a4", { task: "Send the pro forma a1" }), // duplicate text
          ...Array.from({ length: 10 }, (_, i) => item(`b${i}`)),
        ],
        field_updates: [],
      },
      { defaultDue: due },
    );
    expect(plan.tasks.map((t) => t.itemId)).toContain("a1");
    expect(plan.tasks.map((t) => t.itemId)).not.toContain("a2");
    expect(plan.tasks.map((t) => t.itemId)).not.toContain("a3");
    expect(plan.tasks.map((t) => t.itemId)).not.toContain("a4");
    expect(plan.tasks.length).toBe(MAX_AUTO_TASKS);
  });
  it("is stricter for heuristic analyses (needs a due date or to be ours)", () => {
    const plan = planAutoApply(
      { engine: "heuristic", action_items: [item("t1", { owner: "them" }), item("t2", { owner: "them", due: "2026-10-09T17:00:00.000Z" }), item("u1")], field_updates: [] },
      { defaultDue: due },
    );
    expect(plan.tasks.map((t) => t.itemId)).toEqual(["t2", "u1"]);
  });
  it("skips items applied before", () => {
    const plan = planAutoApply({ engine: "ai:x", action_items: [item("a1"), item("a2")], field_updates: [] }, { defaultDue: due, alreadyAppliedItemIds: new Set(["a1"]) });
    expect(plan.tasks.map((t) => t.itemId)).toEqual(["a2"]);
  });
  it("next step: grounded field update first, else our first dated commitment, else default due", () => {
    const withField = planAutoApply(
      { engine: "ai:x", action_items: [item("a1", { due: "2026-10-08T17:00:00.000Z" })], field_updates: [{ field: "next_step", value: "Send the pro forma a1", evidence: "I'll send the pro forma a1" }] },
      { defaultDue: due },
    );
    expect(withField.nextStep).toMatchObject({ text: "Send the pro forma a1", due: "2026-10-08T17:00:00.000Z" });
    const fromTask = planAutoApply({ engine: "ai:x", action_items: [item("t", { owner: "them" }), item("u")], field_updates: [] }, { defaultDue: due });
    expect(fromTask.nextStep).toMatchObject({ text: "Send the pro forma u", due: due.toISOString() });
    expect(planAutoApply({ engine: "ai:x", action_items: [], field_updates: [] }, { defaultDue: due }).nextStep).toBeNull();
  });
  it("works end to end on the heuristic analysis of a real-looking call", () => {
    const text = [
      "[00:00:01] Alex Rep: Thanks for joining today, Jane.",
      "[00:03:40] Alex Rep: I'll send the pro forma and the NDA by Friday.",
      "[00:04:05] Jane Doe: We'll review it with our CEO next week and get back to you.",
    ].join("\n");
    const a = heuristicTranscriptAnalysis(text, { title: "Intro", occurredAt: new Date("2026-09-30T15:00:00Z"), ourNames: ["Alex Rep"], ownerName: "Alex Rep" });
    const plan = planAutoApply(a, { defaultDue: due });
    expect(plan.tasks.length).toBeGreaterThanOrEqual(1);
    expect(plan.tasks.every((t) => t.evidence.length > 0)).toBe(true);
    expect(plan.nextStep?.text).toMatch(/pro forma/i);
  });
});

describe("summary + undo window", () => {
  it("phrases the notification", () => {
    expect(autopilotSummary({ who: "TheStreet", tasks: 3, nextStep: true, draft: "app" })).toBe("Call with TheStreet processed: 3 tasks, next step set, follow-up drafted");
    expect(autopilotSummary({ who: null, tasks: 1, nextStep: false, draft: "gmail" })).toBe("Call processed: 1 task, follow-up drafted in Gmail");
    expect(autopilotSummary({ who: "X", tasks: 0, nextStep: false, draft: null })).toMatch(/nothing to apply/);
  });
  it("undo is available for 24 h and only once", () => {
    const now = new Date("2026-10-02T12:00:00Z");
    expect(undoAvailable(new Date(now.getTime() - 1000).toISOString(), null, now)).toBe(true);
    expect(undoAvailable(new Date(now.getTime() - AUTOPILOT_UNDO_MS - 1).toISOString(), null, now)).toBe(false);
    expect(undoAvailable(now.toISOString(), now.toISOString(), now)).toBe(false);
    expect(undoAvailable(null, null, now)).toBe(false);
  });
});

describe("draft guard + helpers", () => {
  it("clean drafts are ok; claims or MNPI hits keep the draft in-app; banned in block mode blocks", () => {
    expect(evaluateDraftGuard([], "warn", [])).toEqual({ status: "ok", warnings: [] });
    const hit = { status: "banned" as const, match: "paid in 8 seconds", alternative: "fast payouts (beta)" };
    expect(evaluateDraftGuard([hit], "warn", []).status).toBe("flagged");
    expect(evaluateDraftGuard([hit], "block", []).status).toBe("blocked");
    expect(evaluateDraftGuard([{ ...hit, status: "restricted" }], "block", []).status).toBe("flagged");
    const m = evaluateDraftGuard([], "warn", ["Mentions internal pipeline/forecast figures"]);
    expect(m.status).toBe("flagged");
    expect(m.warnings[0]).toMatch(/confidential/);
  });
  it("personalizes, signs once, guesses names safely", () => {
    expect(personalizeDraft("Hi {{first_name}},", "Jane Doe")).toBe("Hi Jane,");
    expect(personalizeDraft("Hi {{ first_name }},", null)).toBe("Hi there,");
    expect(withSignature("Body", "-- Alex")).toBe("Body\n\n-- Alex");
    expect(withSignature("Body\n\n-- Alex", "-- Alex")).toBe("Body\n\n-- Alex");
    expect(firstNameFromEmail("jane.doe@reach.co.uk")).toBe("Jane");
    expect(firstNameFromEmail("info@reach.co.uk")).toBeNull();
    expect(firstNameFromEmail("j2@x.com")).toBeNull();
    expect(gmailDraftUrl("abc")).toContain("compose=abc");
  });
});
