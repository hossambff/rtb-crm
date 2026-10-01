import { describe, expect, it } from "vitest";
import { NAV } from "@/lib/nav";
import { NAV_CUSTOMIZED, SLACK_MEMBER_ID, leadWithMotions, resolveMotions, shapeNav, toNavHidden } from "../core";
import { computeChecklist, type ChecklistFacts } from "../checklist-core";

const shown = (items: ReturnType<typeof shapeNav>) => items.map((i) => i.href);

describe("sidebar personalization", () => {
  it("shows every permitted item by default — no More menu", () => {
    expect(shapeNav(NAV, [])).toHaveLength(NAV.length);
    expect(shapeNav(NAV, [NAV_CUSTOMIZED])).toHaveLength(NAV.length);
  });
  it("hides exactly what the user switched off", () => {
    expect(shown(shapeNav(NAV, [NAV_CUSTOMIZED, "/calls", "/r100"]))).not.toEqual(expect.arrayContaining(["/calls"]));
    expect(shapeNav(NAV, [NAV_CUSTOMIZED, "/calls", "/r100"])).toHaveLength(NAV.length - 2);
  });
  it("My Day can never be hidden", () => {
    expect(shown(shapeNav(NAV, ["/home"]))).toContain("/home");
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

describe("checklist ↔ /welcome wizard", () => {
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
    wizardSteps: ["welcome", "profile", "sell", "book", "targets", "tools", "work", "done"],
    wizardStatus: {},
    hasQuota: false,
  };
  it("adds profile and targets items and deep-links open items into their wizard step", () => {
    const r = computeChecklist(facts);
    expect(r.steps.map((s) => s.id)).toEqual(["profile", "google", "granola", "motions", "claimDeals", "targets", "slack", "copilot", "alertBudget"]);
    expect(r.steps.find((s) => s.id === "google")!.href).toBe("/welcome?step=tools");
    expect(r.steps.find((s) => s.id === "motions")!.href).toBe("/welcome?step=sell");
    expect(r.steps.find((s) => s.id === "copilot")!.href).toBe("/copilot");
    expect(r.resumeHref).toBe("/welcome?step=profile");
  });
  it("a step finished in the wizard completes its items; skipped ones stay open and are marked", () => {
    const r = computeChecklist({ ...facts, wizardStatus: { profile: "done", sell: "done", book: "done", work: "done", tools: "skipped" } });
    const by = (id: string) => r.steps.find((s) => s.id === id)!;
    expect(by("profile").done).toBe(true);
    expect(by("motions").done).toBe(true);
    expect(by("claimDeals").done).toBe(true); // "none of these are mine"
    expect(by("alertBudget").done).toBe(true);
    expect(by("google").done).toBe(false);
    expect(by("google").skipped).toBe(true);
    expect(r.resumeHref).toBe("/welcome?step=tools");
  });
  it("a tools step marked done never fakes a connection", () => {
    const r = computeChecklist({ ...facts, wizardStatus: { tools: "done" } });
    expect(r.steps.find((s) => s.id === "google")!.done).toBe(false);
    expect(r.steps.find((s) => s.id === "slack")!.done).toBe(false);
  });
  it("targets complete with a quota; items outside the wizard keep their old links", () => {
    expect(computeChecklist({ ...facts, hasQuota: true }).steps.find((s) => s.id === "targets")!.done).toBe(true);
    const r = computeChecklist({ ...facts, wizardSteps: ["welcome", "profile", "work", "done"] });
    expect(r.steps.find((s) => s.id === "claimDeals")!.href).toBe("/deals?owner=none");
    expect(r.steps.map((s) => s.id)).not.toContain("targets");
  });
});
