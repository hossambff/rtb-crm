import { describe, expect, it } from "vitest";
import { NAV, filterNav } from "@/lib/nav";
import { DEFAULT_MATRIX } from "@/lib/rbac/defaults";
import { ROLES, type Role } from "@/lib/rbac/model";
import { NAV_DEFAULT_MAX, alertBudgetChosen, shapeNav, slackIdChange } from "../core";

const permitted = (role: Role) => filterNav(NAV, DEFAULT_MATRIX[role]);
const main = (role: Role) => shapeNav(permitted(role), role, []).filter((i) => !i.more).map((i) => i.href);
const hrefs = (role: Role) => permitted(role).map((i) => i.href);

describe("role-shaped nav defaults (QA MAJ-22)", () => {
  it(`no role shows more than ${NAV_DEFAULT_MAX} items by default, and My Day is always first`, () => {
    for (const role of ROLES) {
      if (role === "pending") continue;
      const m = main(role);
      expect(m.length, role).toBeLessThanOrEqual(NAV_DEFAULT_MAX);
      expect(m[0], role).toBe("/home");
    }
  });
  it("AE, leader and exec keep everything reachable under More", () => {
    for (const role of ["ae", "sales_leader", "executive", "super_admin"] as Role[]) {
      const shaped = shapeNav(permitted(role), role, []);
      expect(shaped).toHaveLength(permitted(role).length);
      expect(shaped.filter((i) => i.more).length, role).toBeGreaterThan(0);
    }
  });
  it("hides Pipeline review and Forecast from SDRs, interns and commission reps", () => {
    for (const role of ["sdr", "intern", "commission_rep"] as Role[]) {
      expect(hrefs(role), role).not.toContain("/review");
      expect(hrefs(role), role).not.toContain("/forecast");
    }
  });
  it("leaders and execs keep Pipeline review and Forecast on the sidebar", () => {
    for (const role of ["sales_leader", "executive", "admin"] as Role[]) {
      expect(main(role), role).toEqual(expect.arrayContaining(["/review", "/forecast"]));
    }
    expect(main("ae")).toContain("/forecast");
    expect(hrefs("ae")).not.toContain("/review"); // own analytics only
  });
  it("finance doesn't get Inbox, Sequences or Calls", () => {
    expect(hrefs("finance")).not.toEqual(expect.arrayContaining(["/inbox"]));
    expect(hrefs("finance")).not.toContain("/sequences");
    expect(hrefs("finance")).not.toContain("/calls");
    expect(main("finance")).toEqual(expect.arrayContaining(["/revenue", "/commissions"]));
  });
  it("sellers keep Inbox and Sequences", () => {
    for (const role of ["ae", "sdr", "sales_leader"] as Role[]) expect(hrefs(role), role).toEqual(expect.arrayContaining(["/inbox", "/sequences"]));
  });
  it("an admin override that grants the permission brings the item back", () => {
    const m = { ...DEFAULT_MATRIX.sdr, analytics: { view: "team" as const } };
    expect(filterNav(NAV, m).map((i) => i.href)).toContain("/review");
  });
  it("SDR / intern / commission rep keep the 7-item short sidebar", () => {
    expect(main("sdr")).toEqual(["/home", "/pipelines", "/contacts", "/inbox", "/sequences", "/scout", "/copilot"]);
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
