import { describe, expect, it } from "vitest";
import { assignableRoles, parseEmployment, parseInviteRows, parseRole, type InviteContext } from "../core";

const ctx: InviteContext = {
  teams: [
    { id: "t-ent", name: "ENT" },
    { id: "t-sports", name: "Sports" },
  ],
  people: [{ id: "u-sam", name: "Sam Lee", email: "sam@roundtable.io" }],
  allowed: assignableRoles("admin"),
  existingEmails: new Set(["taken@roundtable.io"]),
  domains: ["roundtable.io", "blockchainff.com"],
};

describe("role / employment parsing", () => {
  it("accepts keys, labels and common aliases", () => {
    expect(parseRole("AE")).toBe("ae");
    expect(parseRole("Account Executive")).toBe("ae");
    expect(parseRole("commission_rep")).toBe("commission_rep");
    expect(parseRole("SVP")).toBe("sales_leader");
    expect(parseRole("BDR")).toBe("sdr");
    expect(parseRole("wizard")).toBeNull();
  });
  it("employment defaults to staff", () => {
    expect(parseEmployment("")).toBe("staff");
    expect(parseEmployment("Commission-only")).toBe("commission");
    expect(parseEmployment("contract")).toBe("contractor");
    expect(parseEmployment("gig")).toBeNull();
  });
  it("leaders may only assign seller roles; admin-level roles need a super admin", () => {
    expect(assignableRoles("leader")).toEqual(["ae", "sdr", "intern", "commission_rep"]);
    expect(assignableRoles("admin")).not.toContain("admin");
    expect(assignableRoles("super_admin")).toContain("admin");
    expect(assignableRoles("super_admin")).not.toContain("pending");
  });
});

describe("bulk invite rows", () => {
  it("parses comma and tab rows, skips header and blanks, resolves team and manager", () => {
    const text = "email,name,role,team,manager,employment\nalex@roundtable.io, Alex Morgan, AE, ENT, sam@roundtable.io, staff\n\nbo@roundtable.io\tBo Chen\tsdr\tSports\tSam Lee\t";
    const { rows } = parseInviteRows(text, ctx);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ email: "alex@roundtable.io", name: "Alex Morgan", role: "ae", teamId: "t-ent", managerId: "u-sam", employmentType: "staff", errors: [] });
    expect(rows[1]).toMatchObject({ email: "bo@roundtable.io", role: "sdr", teamId: "t-sports", managerId: "u-sam", errors: [] });
  });
  it("flags bad rows with reasons", () => {
    const { rows } = parseInviteRows(
      ["nope, X, ae", "a@gmail.com, Ann, ae", "taken@roundtable.io, Tak, ae", "c@roundtable.io, Cee, wizard, Nowhere, Nobody, gig", "d@roundtable.io, Dee, admin", "d@roundtable.io, Dee, ae"].join("\n"),
      ctx,
    );
    expect(rows[0]!.errors).toEqual(["Email looks wrong", "Add a name"]);
    expect(rows[1]!.errors[0]).toMatch(/allowed sign-in domain/);
    expect(rows[2]!.errors).toContain("Already has an account");
    expect(rows[3]!.errors).toEqual(["Unknown role “wizard”", "Unknown team “Nowhere”", "Unknown manager “Nobody”", "Unknown employment type “gig”"]);
    expect(rows[4]!.errors).toEqual(["You can't assign Admin / RevOps"]);
    expect(rows[5]!.errors).toContain("Listed twice");
  });
  it("sales leaders: team is forced to theirs and they're the default manager", () => {
    const { rows } = parseInviteRows("e@roundtable.io, Eve, ae, Sports", { ...ctx, allowed: assignableRoles("leader"), forcedTeamId: "t-ent", defaultManagerId: "u-lead" });
    expect(rows[0]).toMatchObject({ teamId: "t-ent", managerId: "u-lead", errors: [] });
    const r2 = parseInviteRows("f@roundtable.io, Fay, executive", { ...ctx, allowed: assignableRoles("leader"), forcedTeamId: "t-ent" });
    expect(r2.rows[0]!.errors).toEqual(["You can't assign Executive"]);
  });
  it("caps the number of rows", () => {
    const text = Array.from({ length: 5 }, (_, i) => `p${i}@roundtable.io, Person ${i}, ae`).join("\n");
    const r = parseInviteRows(text, ctx, 3);
    expect(r.rows).toHaveLength(3);
    expect(r.tooMany).toBe(true);
  });
});
