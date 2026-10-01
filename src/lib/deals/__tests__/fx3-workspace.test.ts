import { describe, expect, it } from "vitest";
import { nextStepPrefill, shouldPromptNextStep } from "../gates";
import { COLLISION_KINDS, TOUCH_KINDS } from "../collisions-core";

describe("B5 next-step prompt (QA MAJ-07)", () => {
  it("always prompts for open target stages unless the role can't edit the next step", () => {
    expect(shouldPromptNextStep({ category: "open" }, [])).toBe(true);
    expect(shouldPromptNextStep({ category: "won" }, [])).toBe(false);
    expect(shouldPromptNextStep({ category: "lost" }, [])).toBe(false);
    expect(shouldPromptNextStep({ category: "open" }, ["nextStep"])).toBe(false);
    expect(shouldPromptNextStep({ category: "open" }, ["nextStepDueAt"])).toBe(false);
    expect(shouldPromptNextStep({ category: "open" }, ["*"])).toBe(false);
  });

  it("prefills the playbook suggestion when it differs, offering the current step as the alternative", () => {
    expect(nextStepPrefill("Book intro call", { title: "Send the MSA", dueInDays: 2 })).toEqual({ value: "Send the MSA", fromPlaybook: true, alternative: "Book intro call" });
  });

  it("keeps the current next step when the playbook says the same thing or has no hint", () => {
    expect(nextStepPrefill("Send the MSA", { title: "send the msa", dueInDays: 2 })).toEqual({ value: "Send the MSA", fromPlaybook: false, alternative: null });
    expect(nextStepPrefill("Call CFO", null)).toEqual({ value: "Call CFO", fromPlaybook: false, alternative: null });
  });

  it("uses the playbook when there is no current step, and empty when neither exists", () => {
    expect(nextStepPrefill(null, { title: "Kickoff", dueInDays: 1 })).toEqual({ value: "Kickoff", fromPlaybook: true, alternative: null });
    expect(nextStepPrefill("  ", null)).toEqual({ value: "", fromPlaybook: false, alternative: null });
  });
});

describe("collision kinds (QA MIN-16)", () => {
  it("notes never count as touching the publisher, but stay a timeline kind", () => {
    expect(COLLISION_KINDS).not.toContain("note");
    expect(TOUCH_KINDS).toContain("note");
    expect(COLLISION_KINDS).toEqual(expect.arrayContaining(["email", "call", "meeting", "linkedin"]));
  });
});
