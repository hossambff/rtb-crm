import { describe, expect, it } from "vitest";
import { maySeeRestrictedSubject, restrictedFallbackTitle, routeRestrictedApprovers, type RestrictionFacts } from "../routing-core";

const facts = (p: Partial<RestrictionFacts> = {}): RestrictionFacts => ({
  dealRestricted: true,
  accountRestricted: false,
  dealList: new Set(["onlist"]),
  accountList: new Set(),
  superAdmins: new Set(["sa"]),
  ...p,
});

describe("restricted approval routing (QA MIN-36)", () => {
  it("only approvers on the deal's access list (or super_admin) may see a restricted deal", () => {
    expect(maySeeRestrictedSubject("onlist", facts())).toBe(true);
    expect(maySeeRestrictedSubject("sa", facts())).toBe(true);
    expect(maySeeRestrictedSubject("exec", facts())).toBe(false);
  });

  it("a restricted account needs its own list (or the deal's)", () => {
    const f = facts({ dealRestricted: false, accountRestricted: true, dealList: new Set(), accountList: new Set(["acc"]) });
    expect(maySeeRestrictedSubject("acc", f)).toBe(true);
    expect(maySeeRestrictedSubject("exec", f)).toBe(false);
    expect(maySeeRestrictedSubject("dl", facts({ accountRestricted: true, dealList: new Set(["dl"]) }))).toBe(true);
  });

  it("routes to the allowed approvers and drops the others and the requester", () => {
    expect(routeRestrictedApprovers(["exec", "onlist", "onlist"], facts(), "req")).toEqual({ recipients: ["onlist"], fallback: false });
    expect(routeRestrictedApprovers(["onlist"], facts(), "onlist")).toEqual({ recipients: ["sa"], fallback: true });
  });

  it("falls back to super_admins (minus the requester) when no approver is on the list", () => {
    expect(routeRestrictedApprovers(["exec1", "exec2"], facts({ superAdmins: new Set(["sa", "sa2"]) }), "sa2")).toEqual({ recipients: ["sa"], fallback: true });
    expect(routeRestrictedApprovers([], facts({ superAdmins: new Set() }))).toEqual({ recipients: [], fallback: true });
  });

  it("the fallback title is neutral", () => {
    const title = restrictedFallbackTitle("proposal");
    expect(title).toContain("restricted record");
    expect(title).toContain("proposal");
  });
});
