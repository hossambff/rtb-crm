import { describe, expect, it } from "vitest";
import { buildHelpContext, canTransition, helpAskSchema, helpHref, isOverdue } from "../core";

describe("help requests", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  it("transitions", () => {
    expect(canTransition("open", "accepted")).toBe(true);
    expect(canTransition("open", "done")).toBe(true);
    expect(canTransition("accepted", "done")).toBe(true);
    expect(canTransition("accepted", "accepted")).toBe(false);
    expect(canTransition("done", "declined")).toBe(false);
    expect(canTransition("cancelled", "accepted")).toBe(false);
  });
  it("overdue only while active and past needed-by", () => {
    expect(isOverdue({ status: "open", neededBy: "2026-09-30T12:00:00Z" }, now)).toBe(true);
    expect(isOverdue({ status: "accepted", neededBy: "2026-10-02T12:00:00Z" }, now)).toBe(false);
    expect(isOverdue({ status: "done", neededBy: "2026-09-30T12:00:00Z" }, now)).toBe(false);
    expect(isOverdue({ status: "open", neededBy: null }, now)).toBe(false);
  });
  it("context and ask validation", () => {
    const ctx = buildHelpContext({ dealName: "TheStreet", stageName: "Negotiation", valueLabel: "$120K", summary: "Pricing agreed.", nextStep: "Send IO", nextStepDueAt: "2026-10-03", meeting: { title: "CRO call", startsAt: "2026-10-02T15:00:00.000Z" } });
    expect(ctx.split("\n")).toEqual(["Deal: TheStreet — Negotiation, $120K", "Where it stands: Pricing agreed.", "Next step: Send IO (due 2026-10-03)", "Next meeting: CRO call on 2026-10-02 15:00 UTC"]);
    expect(helpAskSchema.safeParse("help").success).toBe(false);
    expect(helpAskSchema.safeParse("Join the CRO call Thursday").success).toBe(true);
  });
});

describe("helpHref (QA MAJ-08)", () => {
  it("deal requests open on the deal; meeting-only requests on their own page, never /home", () => {
    expect(helpHref({ id: "h1", dealId: "d1" })).toBe("/deals/d1?help=h1");
    expect(helpHref({ id: "h1", dealId: null })).toBe("/help/h1");
  });
});
