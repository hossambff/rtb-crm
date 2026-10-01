import { describe, expect, it } from "vitest";
import { NAV, NAV_GROUPS, filterNav } from "@/lib/nav";
import { DEFAULT_MATRIX } from "@/lib/rbac/defaults";
import { ROLES, type Role } from "@/lib/rbac/model";
import { alertBudgetChosen, shapeNav, slackIdChange } from "../core";

const permitted = (role: Role) => filterNav(NAV, DEFAULT_MATRIX[role]);
const hrefs = (role: Role) => permitted(role).map((i) => i.href);

describe("sidebar information architecture", () => {
  it("My Day then Copilot lead the sidebar for every role that can use AI", () => {
    for (const role of ROLES) {
      if (role === "pending") continue;
      const h = hrefs(role);
      expect(h[0], role).toBe("/home");
      if (h.includes("/copilot")) expect(h[1], role).toBe("/copilot");
    }
  });
  it("every item belongs to a known group, in group order", () => {
    const order = NAV.map((i) => NAV_GROUPS.indexOf(i.group));
    expect(order.every((g) => g >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("hides Pipeline review and Forecast from SDRs, interns and commission reps", () => {
    for (const role of ["sdr", "intern", "commission_rep"] as Role[]) {
      expect(hrefs(role), role).not.toContain("/review");
      expect(hrefs(role), role).not.toContain("/forecast");
    }
  });
  it("leaders and execs get Pipeline review and Forecast", () => {
    for (const role of ["sales_leader", "executive", "admin"] as Role[]) {
      expect(hrefs(role), role).toEqual(expect.arrayContaining(["/review", "/forecast"]));
    }
    expect(hrefs("ae")).toContain("/forecast");
    expect(hrefs("ae")).not.toContain("/review"); // own analytics only
  });
  it("finance doesn't get Inbox, Sequences or Calls", () => {
    expect(hrefs("finance")).not.toEqual(expect.arrayContaining(["/inbox"]));
    expect(hrefs("finance")).not.toContain("/sequences");
    expect(hrefs("finance")).not.toContain("/calls");
    expect(hrefs("finance")).toEqual(expect.arrayContaining(["/revenue", "/commissions"]));
  });
  it("sellers keep Inbox and Sequences", () => {
    for (const role of ["ae", "sdr", "sales_leader"] as Role[]) expect(hrefs(role), role).toEqual(expect.arrayContaining(["/inbox", "/sequences"]));
  });
  it("an admin override that grants the permission brings the item back", () => {
    const m = { ...DEFAULT_MATRIX.sdr, analytics: { view: "team" as const } };
    expect(filterNav(NAV, m).map((i) => i.href)).toContain("/review");
  });
  it("user hiding never removes My Day", () => {
    expect(shapeNav(permitted("ae"), ["/home"]).map((i) => i.href)).toContain("/home");
  });
});

describe("preferences save helpers", () => {
  it("only claims a Slack ID when it changes", () => {
    expect(slackIdChange(undefined, "U1")).toEqual({ action: "keep" });
    expect(slackIdChange(null, null)).toEqual({ action: "keep" });
    expect(slackIdChange(" u0123abcd ", "U0123ABCD")).toEqual({ action: "keep" });
    expect(slackIdChange("U0999XYZW", "U0123ABCD")).toEqual({ action: "claim", slackUserId: "U0999XYZW" });
    expect(slackIdChange("", "U0123ABCD")).toEqual({ action: "claim", slackUserId: null });
  });
  it("completes the alert-budget step only when the user chose a value", () => {
    expect(alertBudgetChosen(undefined, 3, 3)).toBe(false);
    expect(alertBudgetChosen(true, 3, 3)).toBe(true);
    expect(alertBudgetChosen(false, 5, 3)).toBe(true);
  });
});
