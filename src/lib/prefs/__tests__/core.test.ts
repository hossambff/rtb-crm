import { describe, expect, it } from "vitest";
import { NAV } from "@/lib/nav";
import { NAV_CUSTOMIZED, SLACK_MEMBER_ID, leadWithMotions, resolveMotions, shapeNav, toNavHidden } from "../core";
import { computeChecklist, type ChecklistFacts } from "../checklist-core";

const more = (items: ReturnType<typeof shapeNav>) => items.filter((i) => i.more).map((i) => i.href);

describe("role-shaped nav", () => {
  it("interns / SDRs / commission reps start short; the rest sits under More", () => {
    const shaped = shapeNav(NAV, "sdr", []);
    const main = shaped.filter((i) => !i.more).map((i) => i.href);
    expect(main).toEqual(["/home", "/pipelines", "/contacts", "/inbox", "/sequences", "/scout", "/copilot"]);
    expect(shaped).toHaveLength(NAV.length); // nothing removed
  });
  it("other roles get their role default; a saved list wins", () => {
    expect(more(shapeNav(NAV, "ae", []))).toContain("/r100");
    expect(more(shapeNav(NAV, "ae", ["/r100"]))).toEqual(["/r100"]);
    expect(more(shapeNav(NAV, "ae", [NAV_CUSTOMIZED]))).toEqual([]);
  });
  it("a customized short-nav user gets exactly their choice (even an empty More)", () => {
    expect(more(shapeNav(NAV, "intern", [NAV_CUSTOMIZED]))).toEqual([]);
    expect(more(shapeNav(NAV, "intern", [NAV_CUSTOMIZED, "/calls"]))).toEqual(["/calls"]);
  });
  it("My Day can never be hidden", () => {
    expect(more(shapeNav(NAV, "ae", ["/home"]))).toEqual([]);
    expect(toNavHidden(["/home", "/calls", "/nope", "/calls"], NAV.map((n) => n.href))).toEqual([NAV_CUSTOMIZED, "/calls"]);
  });
});

describe("motions I sell", () => {
  const permitted = ["NET", "ENT", "SPT", "R100"];
  it("explicit prefs win (only permitted ones, in admin order)", () => {
    expect(resolveMotions(["SPT", "ADS", "NET"], permitted, ["ENT"])).toEqual({ keys: ["NET", "SPT"], source: "prefs" });
  });
  it("then motions where the user owns deals", () => {
    expect(resolveMotions([], permitted, ["R100", "PAY"])).toEqual({ keys: ["R100"], source: "owned" });
  });
  it("else everything permitted", () => {
    expect(resolveMotions(["ADS"], permitted, [])).toEqual({ keys: permitted, source: "all" });
  });
  it("pickers lead with my motions, the rest keep their order", () => {
    const items = ["NET", "ENT", "SPT", "R100"].map((key) => ({ key }));
    expect(leadWithMotions(items, ["SPT", "NET"]).map((i) => i.key)).toEqual(["SPT", "NET", "ENT", "R100"]);
    expect(leadWithMotions(items, []).map((i) => i.key)).toEqual(["NET", "ENT", "SPT", "R100"]);
  });
});

describe("Slack member id", () => {
  it("validates", () => {
    expect(SLACK_MEMBER_ID.test("U0123ABCD")).toBe(true);
    expect(SLACK_MEMBER_ID.test("W01ABCDEFG")).toBe(true);
    expect(SLACK_MEMBER_ID.test("@will")).toBe(false);
    expect(SLACK_MEMBER_ID.test("u0123abcd")).toBe(false);
  });
});

describe("first-run checklist", () => {
  const facts: ChecklistFacts = {
    canEmail: true,
    canCalls: true,
    canDeals: true,
    canCopilot: true,
    canOwnDeals: true,
    slackConfigured: true,
    googleConnected: false,
    granolaConnected: false,
    hasMotions: false,
    slackDm: false,
    usedCopilot: false,
    ownsOpenDeals: false,
    manual: {},
  };
  it("is role-aware", () => {
    const r = computeChecklist({ ...facts, canEmail: false, canCalls: false, canCopilot: false });
    expect(r.steps.map((s) => s.id)).toEqual(["motions", "claimDeals", "slack", "alertBudget"]);
    expect(computeChecklist({ ...facts, canOwnDeals: false }).steps.map((s) => s.id)).not.toContain("claimDeals");
  });
  it("hides the Slack step when Slack isn't connected for the org (no dead end)", () => {
    expect(computeChecklist({ ...facts, slackConfigured: false }).steps.map((s) => s.id)).not.toContain("slack");
  });
  it("claiming imported deals completes once the user owns an open deal", () => {
    expect(computeChecklist(facts).steps.find((s) => s.id === "claimDeals")!.done).toBe(false);
    expect(computeChecklist({ ...facts, ownsOpenDeals: true }).steps.find((s) => s.id === "claimDeals")!.done).toBe(true);
  });
  it("detects completion from real state", () => {
    const r = computeChecklist({ ...facts, googleConnected: true, hasMotions: true, usedCopilot: true, manual: { alertBudget: "x" } });
    expect(r.done).toBe(4);
    expect(r.total).toBe(7);
    expect(r.complete).toBe(false);
    expect(
      computeChecklist({ ...facts, googleConnected: true, granolaConnected: true, hasMotions: true, ownsOpenDeals: true, slackDm: true, usedCopilot: true, manual: { alertBudget: "x" } }).complete,
    ).toBe(true);
  });
  it("never trusts a manual mark for connection steps", () => {
    const r = computeChecklist({ ...facts, manual: { google: "x", slack: "x" } as ChecklistFacts["manual"] });
    expect(r.steps.find((s) => s.id === "google")!.done).toBe(false);
    expect(r.steps.find((s) => s.id === "slack")!.done).toBe(false);
  });
});
