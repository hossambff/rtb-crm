import { describe, expect, it } from "vitest";
import { authRoles } from "../access";
import { adminEndpointDecision, isDevAccountEmail, requestedRoles, sessionDenialReason } from "../policy";

const PERMS = ["set-role", "update", "set-email", "delete", "ban", "create", "set-password", "impersonate"] as const;

describe("SEC H-1: Better Auth admin statements", () => {
  it("the app `admin` role holds no Better Auth admin permission", () => {
    for (const p of PERMS) expect(authRoles.admin.authorize({ user: [p] }).success).toBe(false);
  });
  it("super_admin keeps them", () => {
    expect(authRoles.super_admin.authorize({ user: ["set-role"] }).success).toBe(true);
  });
});

describe("SEC H-1: adminEndpointDecision", () => {
  it("blocks every admin mutation over HTTP, even for super_admin", () => {
    for (const path of ["/admin/set-role", "/admin/update-user", "/admin/remove-user", "/admin/create-user", "/admin/ban-user", "/admin/set-user-password"]) {
      expect(adminEndpointDecision({ path, isHttp: true, callerRole: "super_admin", body: {} }).ok).toBe(false);
      expect(adminEndpointDecision({ path, isHttp: true, callerRole: "admin", body: {} }).ok).toBe(false);
    }
  });
  it("allows read endpoints over HTTP only to super_admin", () => {
    expect(adminEndpointDecision({ path: "/admin/list-users", isHttp: true, callerRole: "super_admin", body: {} }).ok).toBe(true);
    expect(adminEndpointDecision({ path: "/admin/list-users", isHttp: true, callerRole: "admin", body: {} }).ok).toBe(false);
  });
  it("always allows stop-impersonating", () => {
    expect(adminEndpointDecision({ path: "/admin/stop-impersonating", isHttp: true, callerRole: "intern", body: {} }).ok).toBe(true);
  });
  it("server-side role grants of privileged roles need a super_admin caller", () => {
    expect(adminEndpointDecision({ path: "/admin/set-role", isHttp: false, callerRole: "admin", body: { userId: "x", role: "super_admin" } }).ok).toBe(false);
    expect(adminEndpointDecision({ path: "/admin/create-user", isHttp: false, callerRole: null, body: { email: "a@b", name: "a", data: { role: "admin" } } }).ok).toBe(false);
    expect(adminEndpointDecision({ path: "/admin/set-role", isHttp: false, callerRole: "super_admin", body: { userId: "x", role: ["ae", "super_admin"] } }).ok).toBe(true);
    expect(adminEndpointDecision({ path: "/admin/set-role", isHttp: false, callerRole: "admin", body: { userId: "x", role: "ae" } }).ok).toBe(true);
  });
  it("ignores non-admin paths", () => {
    expect(adminEndpointDecision({ path: "/sign-in/email", isHttp: true, callerRole: null, body: {} }).ok).toBe(true);
  });
  it("parses role arrays and comma lists", () => {
    expect(requestedRoles({ role: "ae,super_admin" })).toEqual(["ae", "super_admin"]);
    expect(requestedRoles({ data: { role: ["admin"] } })).toEqual(["admin"]);
  });
});

describe("SEC M-2 / M-15: sessionDenialReason", () => {
  const opts = { allowedDomains: ["roundtable.io", "blockchainff.com"], isProd: false, now: Date.parse("2026-09-30T12:00:00Z") };
  const base = { email: "jane@roundtable.io", banned: false, accessExpiresAt: null };
  it("allows an active user", () => expect(sessionDenialReason(base, opts)).toBeNull());
  it("denies banned users (unless the ban expired)", () => {
    expect(sessionDenialReason({ ...base, banned: true }, opts)).toBe("banned");
    expect(sessionDenialReason({ ...base, banned: true, banExpires: new Date("2026-09-01") }, opts)).toBeNull();
  });
  it("denies expired access", () => expect(sessionDenialReason({ ...base, accessExpiresAt: new Date("2026-09-29") }, opts)).toBe("access_expired"));
  it("denies a removed domain", () => expect(sessionDenialReason({ ...base, email: "x@contractor.com" }, opts)).toBe("domain_not_allowed"));
  it("denies dev.* accounts only in production", () => {
    expect(sessionDenialReason({ ...base, email: "dev.superadmin@roundtable.io" }, opts)).toBeNull();
    expect(sessionDenialReason({ ...base, email: "dev.superadmin@roundtable.io" }, { ...opts, isProd: true })).toBe("dev_account_in_production");
    expect(isDevAccountEmail("developer@roundtable.io")).toBe(false);
  });
});
