import { describe, expect, it } from "vitest";
import { handoffBriefSchema, heuristicBrief, isPendingHandoffConflict, ownerChangedSince, roleFitsKind, shouldEscalate } from "../core";

describe("handoffs", () => {
  const src = {
    dealName: "Acme Daily",
    stageName: "In Comms",
    daysInStage: 4,
    valueLabel: "2.5M MUU · $250K gross/yr",
    accountName: "Acme Media",
    summary: null,
    nextStep: "Discovery call",
    nextStepDueAt: "2026-10-06",
    lastTouch: "call on 2026-09-30: intro",
    stakeholders: [{ name: "Ann Lee", title: "Publisher", role: "decision_maker", primary: true }],
    openTasks: [
      { title: "Send deck", owedBy: "us", dueAt: "2026-10-03" },
      { title: "Traffic numbers", owedBy: "them", dueAt: null },
    ],
    healthExplanation: "No champion; stage over SLA.",
    coverageGaps: ["No champion"],
  };

  it("builds a brief that passes the 40-char context rule", () => {
    const b = heuristicBrief(src);
    expect(handoffBriefSchema.safeParse(b).success).toBe(true);
    expect(b.context).toContain("Acme Daily (Acme Media) is in In Comms for 4 days");
    expect(b.stakeholders).toBe("Ann Lee, Publisher — decision maker (primary)");
    expect(b.commitments).toBe("We owe: Send deck (due 2026-10-03)\nThey owe: Traffic numbers");
    expect(b.risks).toBe("No champion\nstage over SLA");
    expect(b.nextStep).toBe("Discovery call (due 2026-10-06)");
  });

  it("rejects thin context", () => {
    expect(handoffBriefSchema.safeParse({ context: "call him" }).success).toBe(false);
  });

  it("escalates after 2 business days in the receiver's zone", () => {
    const fri = new Date("2026-10-02T15:00:00Z");
    expect(shouldEscalate(fri, new Date("2026-10-05T15:00:00Z"), "America/New_York")).toBe(false); // Mon
    expect(shouldEscalate(fri, new Date("2026-10-06T15:00:00Z"), "America/New_York")).toBe(true); // Tue
  });

  it("receiver roles per kind", () => {
    expect(roleFitsKind("ae_to_onboarding", "onboarding")).toBe(true);
    expect(roleFitsKind("ae_to_onboarding", "ae")).toBe(false);
    expect(roleFitsKind("sdr_to_ae", "ae")).toBe(true);
    expect(roleFitsKind("reassign", "viewer")).toBe(false);
  });

  it("SDR → AE receivers are AEs and above — never another SDR, an intern or a commission rep (QA MAJ-09)", () => {
    for (const r of ["ae", "sales_leader", "executive", "super_admin"]) expect(roleFitsKind("sdr_to_ae", r)).toBe(true);
    for (const r of ["sdr", "intern", "commission_rep", "onboarding", "finance", "viewer"]) expect(roleFitsKind("sdr_to_ae", r)).toBe(false);
  });

  it("AE → Onboarding receivers are onboarding or admins", () => {
    expect(roleFitsKind("ae_to_onboarding", "admin")).toBe(true);
    expect(roleFitsKind("ae_to_onboarding", "super_admin")).toBe(true);
    expect(roleFitsKind("ae_to_onboarding", "sales_leader")).toBe(false);
  });

  it("accept fails when the owner changed since the handoff was sent (CR M1)", () => {
    expect(ownerChangedSince("sdr_to_ae", "alice", "alice")).toBe(false);
    expect(ownerChangedSince("sdr_to_ae", "alice", "carol")).toBe(true);
    expect(ownerChangedSince("reassign", null, "carol")).toBe(true);
    expect(ownerChangedSince("reassign", null, null)).toBe(false);
    expect(ownerChangedSince("ae_to_onboarding", "alice", "carol")).toBe(false); // ownership doesn't move
    expect(ownerChangedSince("sdr_to_ae", undefined, "carol")).toBe(false); // nothing recorded → no check
  });

  it("maps the one-pending-handoff unique violation (CR L6)", () => {
    expect(isPendingHandoffConflict({ code: "23505", constraint_name: "handoffs_one_pending_uq" })).toBe(true);
    expect(isPendingHandoffConflict({ cause: { code: "23505", constraint_name: "handoffs_one_pending_uq" } })).toBe(true);
    expect(isPendingHandoffConflict({ code: "23505", constraint_name: "other_uq" })).toBe(false);
    expect(isPendingHandoffConflict(new Error("boom"))).toBe(false);
  });
});
