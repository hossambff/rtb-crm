import { describe, expect, it } from "vitest";
import { approvalDecidedMessage, decidedCardStatus } from "../blocks";

describe("stale Slack approval cards", () => {
  it("maps withdrawn / superseded rows (stored as rejected) to their own word", () => {
    expect(decidedCardStatus("rejected", "Withdrawn: no longer requires approval")).toBe("withdrawn");
    expect(decidedCardStatus("rejected", "Override withdrawn")).toBe("withdrawn");
    expect(decidedCardStatus("rejected", "Superseded by a newer request")).toBe("superseded");
    expect(decidedCardStatus("rejected", "Old note\nWithdrawn: no longer requires approval")).toBe("withdrawn");
    expect(decidedCardStatus("rejected", "Decision: too expensive")).toBe("rejected");
    expect(decidedCardStatus("rejected", null)).toBe("rejected");
    expect(decidedCardStatus("approved", "Withdrawn")).toBe("approved");
  });

  it("the decided card has no action buttons and stays neutral when restricted", () => {
    const m = approvalDecidedMessage({ kindLabel: "Proposal", label: "Acme v2", status: "withdrawn", deciderName: null, restricted: true, href: "/tasks?tab=approvals&approval=x" }, "https://app.example");
    const json = JSON.stringify(m);
    expect(m.text).toContain("Withdrawn");
    expect(json).not.toContain("Acme");
    expect(json).not.toContain('"actions"');
  });
});
