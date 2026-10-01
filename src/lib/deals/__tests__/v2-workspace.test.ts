import { describe, expect, it } from "vitest";
import { accountNoun, collisionHeadline, dayPhrase, describeTouch, latestPerPerson, mergeTouches } from "../collisions-core";
import { buildDirectory, isHelpTarget } from "../audience-core";
import { mnpiSafe } from "../notice";
import {
  AUTOFILL_KEY,
  contactScore,
  defaultNextStepDue,
  expectedCloseFromSla,
  pickPrimaryContact,
  readAutofill,
  suggestPriority,
  suggestSource,
  withoutAutofill,
} from "../create-core";

const now = new Date("2026-10-01T15:00:00Z"); // Thursday
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

describe("collisions", () => {
  it("merges sources per user × kind, keeps the latest instant, drops self and junk", () => {
    const out = mergeTouches(
      [
        { userId: "u1", userName: "Chris Smith", kind: "email", at: daysAgo(5), count: 2 },
        { userId: "u1", userName: "Chris Smith", kind: "email", at: daysAgo(2), count: 1 },
        { userId: "u2", userName: "Will H", kind: "call", at: daysAgo(1) },
        { userId: "me", userName: "Me", kind: "email", at: daysAgo(0) },
        { userId: null, userName: "x", kind: "email", at: daysAgo(1) },
        { userId: "u3", userName: "Z", kind: "stage_change", at: daysAgo(1) },
        { userId: "u4", userName: "Bad", kind: "email", at: "not a date" },
      ],
      { excludeUserId: "me" },
    );
    expect(out.map((t) => [t.userId, t.kind, t.count])).toEqual([
      ["u2", "call", 1],
      ["u1", "email", 3],
    ]);
    expect(out[1]!.at).toBe(daysAgo(2).toISOString());
  });

  it("collapses to one line per person and phrases it", () => {
    const touches = mergeTouches([
      { userId: "u1", userName: "Chris Smith", kind: "email", at: daysAgo(2) },
      { userId: "u1", userName: "Chris Smith", kind: "call", at: daysAgo(6) },
      { userId: "u2", userName: "Will Heckman", kind: "meeting", at: new Date(now.getTime() + 2 * 86_400_000) },
    ]);
    const people = latestPerPerson(touches);
    expect(people.map((p) => p.userId)).toEqual(["u2", "u1"]);
    expect(people[1]!.kinds.sort()).toEqual(["call", "email"]);
    expect(describeTouch(people[1]!, now, accountNoun("publisher"))).toBe("Chris emailed this publisher 2 days ago");
    expect(describeTouch(people[0]!, now, accountNoun("advertiser"))).toBe("Will meets this advertiser in 2 days");
    expect(collisionHeadline(touches, now, "this account")).toBe("Will meets this account in 2 days · 1 other in touch too");
    expect(collisionHeadline([], now)).toBeNull();
  });

  it("day phrases", () => {
    expect(dayPhrase(new Date("2026-10-01T09:00:00Z"), now)).toBe("today");
    expect(dayPhrase(new Date("2026-09-30T09:00:00Z"), now)).toBe("yesterday");
    expect(dayPhrase(new Date("2026-10-02T09:00:00Z"), now)).toBe("tomorrow");
    expect(accountNoun(null)).toBe("this account");
  });
});

describe("audience directory", () => {
  const users = [
    { id: "a", name: "A", email: "a@x", image: null, role: "ae", teamId: "t1", managerId: "m", employmentType: null, timezone: null, banned: false },
    { id: "b", name: "B", email: "b@x", image: null, role: "sdr", teamId: "t1", managerId: "a", employmentType: null, timezone: "Europe/London", banned: false },
    { id: "m", name: "M", email: "m@x", image: null, role: "sales_leader", teamId: null, managerId: null, employmentType: null, timezone: null, banned: false },
    { id: "x", name: "X", email: "x@x", image: null, role: "pending", teamId: null, managerId: null, employmentType: null, timezone: null, banned: false },
    { id: "y", name: "Y", email: "y@x", image: null, role: "ae", teamId: null, managerId: null, employmentType: null, timezone: null, banned: true },
  ];
  const dir = buildDirectory(users, [{ id: "t1", pipelineTypes: ["NET"] }]);
  it("mirrors getCurrentUser's team view and drops pending / banned", () => {
    expect(dir.map((u) => u.id)).toEqual(["a", "b", "m"]);
    expect(dir.find((u) => u.id === "a")!.teamMemberIds.sort()).toEqual(["a", "b"]);
    expect(dir.find((u) => u.id === "m")!.teamMemberIds.sort()).toEqual(["a", "m"]);
    expect(dir.find((u) => u.id === "b")!.teamPipelineKeys).toEqual(["NET"]);
    expect(dir.find((u) => u.id === "a")!.timezone).toBe("America/New_York");
  });
  it("help targets: leaders + own manager, never yourself", () => {
    expect(isHelpTarget({ id: "m", role: "sales_leader" }, { id: "a", managerId: null })).toBe(true);
    expect(isHelpTarget({ id: "a", role: "ae" }, { id: "b", managerId: "a" })).toBe(true);
    expect(isHelpTarget({ id: "c", role: "ae" }, { id: "b", managerId: "a" })).toBe(false);
    expect(isHelpTarget({ id: "b", role: "executive" }, { id: "b", managerId: null })).toBe(false);
  });
});

describe("four-field create: auto-fill", () => {
  it("defaults the next step to +3 business days", () => {
    expect(defaultNextStepDue(now, "America/New_York")).toBe("2026-10-06"); // Thu → Tue
  });

  it("priority: account first, then size bands", () => {
    const base = { accountPriority: null, unit: "muu" as const, muu: null, contractValueCents: null, marketCapUsd: null };
    expect(suggestPriority({ ...base, accountPriority: "top10" })?.value).toBe("top10");
    expect(suggestPriority({ ...base, muu: 12_000_000 })?.value).toBe("top10");
    expect(suggestPriority({ ...base, muu: 3_000_000 })?.value).toBe("high");
    expect(suggestPriority({ ...base, muu: 300_000 })?.value).toBe("medium");
    expect(suggestPriority({ ...base, muu: 10_000 })?.value).toBe("low");
    expect(suggestPriority({ ...base, unit: "usd", contractValueCents: 12_000_000 })?.value).toBe("high");
    expect(suggestPriority({ ...base, unit: "activation", marketCapUsd: 2e9 })?.value).toBe("medium");
    expect(suggestPriority(base)).toBeNull();
  });

  it("expected close sums SLAs from the current stage to the first won stage, skipping parking lots", () => {
    const stages = [
      { id: "s1", key: "target", sortOrder: 1, category: "open" as const, slaDays: 30 },
      { id: "s2", key: "outreach", sortOrder: 2, category: "open" as const, slaDays: 14 },
      { id: "s3", key: "contract", sortOrder: 3, category: "open" as const, slaDays: 5 },
      { id: "w", key: "live", sortOrder: 4, category: "won" as const, slaDays: null },
      { id: "c", key: "cold", sortOrder: 5, category: "open" as const, slaDays: 60 },
    ];
    const r = expectedCloseFromSla(stages, "s2", now)!;
    expect(r.label).toBe("20 Oct 2026"); // 19 days
    expect(r.value.toISOString().slice(0, 10)).toBe("2026-10-20");
    expect(expectedCloseFromSla(stages, "w", now)).toBeNull();
    expect(expectedCloseFromSla(stages, "nope", now)).toBeNull();
  });

  it("primary contact: senior + recent wins; left-company / DNC never", () => {
    const c = [
      { id: "1", name: "Ann", title: "Editor", lastContactedAt: daysAgo(3) },
      { id: "2", name: "Bob", title: "CEO & Founder", lastContactedAt: daysAgo(400) },
      { id: "3", name: "Cy", title: "Publisher", lastContactedAt: null, lastEmailAt: daysAgo(2) },
      { id: "4", name: "Dee", title: "CEO", lastContactedAt: daysAgo(1), status: "left_company" },
    ];
    expect(pickPrimaryContact(c, now)?.value).toBe("3");
    expect(contactScore(c[3]!, now)).toBe(-1);
    expect(pickPrimaryContact([c[3]!], now)).toBeNull();
    expect(pickPrimaryContact([c[0]!], now)?.reason).toBe("Only contact on the account");
  });

  it("source only suggests picklist values", () => {
    const picklist = ["Inbound", "Outbound", "Lead Scout", "Import"];
    expect(suggestSource({ accountSource: "lead_scout", inboundEmail: true, role: "ae", picklist })?.value).toBe("Lead Scout");
    expect(suggestSource({ accountSource: null, inboundEmail: true, role: "ae", picklist })?.value).toBe("Inbound");
    expect(suggestSource({ accountSource: "deal_create", inboundEmail: false, role: "commission_rep", picklist })).toBeNull();
    expect(suggestSource({ accountSource: null, inboundEmail: false, role: "sdr", picklist })?.value).toBe("Outbound");
  });

  it("auto-fill markers round-trip and are removed per field", () => {
    const entry = { value: "high", label: "High", reason: "3M MUU", engine: "heuristic", at: now.toISOString() };
    const cf = { interviews: [1], [AUTOFILL_KEY]: { priority: entry, source: { ...entry, value: "Inbound" }, bogus: 1 } };
    expect(Object.keys(readAutofill(cf)).sort()).toEqual(["priority", "source"]);
    const one = withoutAutofill(cf, ["priority"]);
    expect(Object.keys(readAutofill(one))).toEqual(["source"]);
    expect(one.interviews).toEqual([1]);
    const none = withoutAutofill(one, ["source"]);
    expect(AUTOFILL_KEY in none).toBe(false);
    expect(readAutofill(null)).toEqual({});
  });
});

describe("MNPI-safe notices", () => {
  it("drops deal names and bodies for restricted deals only", () => {
    expect(mnpiSafe(true, { title: "Ann mentioned you on Acme", body: "secret" }, "Ann mentioned you on a restricted deal")).toEqual({ title: "Ann mentioned you on a restricted deal", body: null, sensitive: true });
    expect(mnpiSafe(false, { title: "t", body: "b" }, "g")).toEqual({ title: "t", body: "b" });
  });
});
