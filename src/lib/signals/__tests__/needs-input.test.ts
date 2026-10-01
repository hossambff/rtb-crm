import { describe, expect, it } from "vitest";
import { moveDialogHref, needsInputMessage } from "../core";
import { filledKeys, missingFields } from "@/lib/deals/gates";

describe("stage signal needs input (CR M9)", () => {
  it("an open stage without a next step is reported as missing input, not a dead end", () => {
    const stage = { requiredFields: [], category: "open" as const };
    const missing = missingFields(stage, filledKeys({ nextStep: null, nextStepDueAt: null }));
    expect(missing).toEqual(["nextStep", "nextStepDueAt"]);
    expect(missingFields(stage, filledKeys({ nextStep: "Send MSA", nextStepDueAt: new Date() }))).toEqual([]);
  });
  it("points to the deal's prefilled move dialog", () => {
    expect(moveDialogHref("d-1", "st 2", "sig-3")).toBe("/deals/d-1?move=st%202&signal=sig-3");
    expect(needsInputMessage("Acme", "Proposal", ["Next step", "Next step due"])).toBe("Moving Acme to Proposal needs Next step, Next step due — finish it in the move dialog.");
  });
});
