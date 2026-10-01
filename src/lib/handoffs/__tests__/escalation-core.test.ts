import { describe, expect, it } from "vitest";
import { handoffEscalatedKey, handoffEscalationNotice } from "../core";

describe("handoff escalation (QA MIN-17)", () => {
  const h = { dealName: "Acme Daily", toName: "Jordan", fromName: "Sam", createdAt: new Date("2026-09-24T10:00:00Z") };

  it("stamps once per handoff under a stable app_settings key", () => {
    expect(handoffEscalatedKey("abc")).toBe("handoff.escalated:abc");
  });

  it("names the deal and sender for normal deals", () => {
    const n = handoffEscalationNotice(h, false);
    expect(n.title).toBe("Jordan hasn't picked up Acme Daily");
    expect(n.body).toContain("Sam");
    expect(n.body).toContain("2026-09-24");
    expect(n.sensitive).toBe(false);
  });

  it("is MNPI-safe for restricted deals: no deal name, no body, sensitive", () => {
    const n = handoffEscalationNotice(h, true);
    expect(n.title).not.toContain("Acme");
    expect(n.body).toBeNull();
    expect(n.sensitive).toBe(true);
  });

  it("copes with a missing receiver name", () => {
    expect(handoffEscalationNotice({ ...h, toName: null }, false).title).toBe("Your report hasn't picked up Acme Daily");
  });
});
