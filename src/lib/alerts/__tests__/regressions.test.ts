import { describe, expect, it } from "vitest";
import { escalationChain, escalationDue, nextStepOverdue, r100ParticipationLapsing } from "../rules";
import { indexSuppressions, isSuppressing, suppressionDecision, type SuppressionRow } from "../suppression";
import { businessDaysPassed } from "../time";
import { participationNow } from "../../r100/calc";
import { dateOnlyToInstant, parseUserDate, toDateInput, toDateTimeInput } from "../../time";

/** Regression tests for CODE_REVIEW H-05, H-06, M-06, M-09 and QA-04 / QA-12 (Appendix A + the fix spec). */

const NY = "America/New_York";
const D = (s: string) => new Date(s);

describe("M-06 date-only due dates are end-of-business in the user's zone", () => {
  it("due 2026-10-01 is not overdue at 20:30 ET on Sep 30 (Appendix A)", () => {
    const due = parseUserDate("2026-10-01", NY)!;
    expect(nextStepOverdue({ nextStepDueAt: due }, D("2026-10-01T00:30:00Z"))).toBe(false);
  });
  it("…and becomes overdue after 17:00 ET on the due date", () => {
    const due = parseUserDate("2026-10-01", NY)!;
    expect(due.toISOString()).toBe("2026-10-01T21:00:00.000Z");
    expect(nextStepOverdue({ nextStepDueAt: due }, D("2026-10-01T20:59:00Z"))).toBe(false);
    expect(nextStepOverdue({ nextStepDueAt: due }, D("2026-10-01T21:01:00Z"))).toBe(true);
  });
  it("reads back as the same calendar day in the user's zone and in UTC (incl. Los Angeles)", () => {
    for (const tz of [NY, "America/Los_Angeles", "Europe/Athens", "Asia/Tokyo", "Pacific/Honolulu"]) {
      const at = dateOnlyToInstant("2026-10-01", tz);
      expect(toDateInput(at, tz)).toBe("2026-10-01");
      expect(at.toISOString().slice(0, 10)).toBe("2026-10-01");
    }
  });
});

describe("QA-12 snooze/due times are wall time in the PROFILE zone", () => {
  it("'Tomorrow 9:00' for an ET profile is 13:00Z in summer, whatever the browser zone", () => {
    const at = parseUserDate("2026-10-01T09:00", NY)!;
    expect(at.toISOString()).toBe("2026-10-01T13:00:00.000Z");
    expect(toDateTimeInput(at, NY)).toBe("2026-10-01T09:00");
  });
  it("explicit ISO instants are kept as given", () => {
    expect(parseUserDate("2026-10-01T06:00:00.000Z", NY)!.toISOString()).toBe("2026-10-01T06:00:00.000Z");
    expect(parseUserDate("nope", NY)).toBeUndefined();
    expect(parseUserDate("", NY)).toBeNull();
  });
});

describe("M-09 N business days keep the wall-clock time", () => {
  it("created Mon 23:30 ET does not pass 1 business day at Tue 00:30 ET", () => {
    const created = D("2026-09-29T03:30:00Z"); // Mon 28 Sep 23:30 EDT
    expect(businessDaysPassed(created, D("2026-09-29T04:30:00Z"), 1, NY)).toBe(false);
    expect(businessDaysPassed(created, D("2026-09-30T03:31:00Z"), 1, NY)).toBe(true);
  });
  it("escalation with a 24h rule waits a full business day", () => {
    const created = D("2026-09-29T03:30:00Z");
    expect(escalationDue({ createdAt: created, state: "open" }, 24, D("2026-09-29T13:30:00Z"), { tz: NY })).toBe(false);
    expect(escalationDue({ createdAt: created, state: "open" }, 24, D("2026-09-30T13:30:00Z"), { tz: NY })).toBe(true);
  });
});

describe("H-06 R100 participation lapsing", () => {
  it("never fires beyond the participation months (UI says 'beyond')", () => {
    const r100 = { firstPostDate: "2026-01-10", participation: [true, true, true] };
    const now = D("2026-06-26T15:00:00Z");
    expect(participationNow(r100, now)).toBe("beyond");
    expect(r100ParticipationLapsing(r100, now, { tz: NY })).toBe(false);
  });
  it("uses the same calendar-month index as the R100 page", () => {
    // first post Jan 31; Mar 25 is calendar month 3 (index 2) on the page — the rule must agree
    const r100 = { firstPostDate: "2026-01-31", participation: [true, true, false] };
    expect(r100ParticipationLapsing(r100, D("2026-03-25T15:00:00Z"), { tz: NY })).toBe(true);
    expect(r100ParticipationLapsing({ ...r100, participation: [true, true, true] }, D("2026-03-25T15:00:00Z"), { tz: NY })).toBe(false);
  });
});

describe("QA-04 escalation recipients", () => {
  it("manager, else sales leaders, else executives — never self", () => {
    expect(escalationChain({ self: "rep", manager: "mgr", salesLeaders: ["sl"], executives: ["ex"] })).toEqual(["mgr"]);
    expect(escalationChain({ self: "rep", manager: null, salesLeaders: ["sl1", "sl2"], executives: ["ex"] })).toEqual(["sl1", "sl2"]);
    expect(escalationChain({ self: "rep", manager: null, salesLeaders: [], executives: ["ex"] })).toEqual(["ex"]);
    expect(escalationChain({ self: "sl", manager: null, salesLeaders: ["sl"], executives: ["ex"] })).toEqual(["ex"]);
    expect(escalationChain({ self: "ex", manager: null, salesLeaders: [], executives: ["ex"] })).toEqual([]);
  });
});

describe("H-05 dismissed / resolved alerts stay suppressed", () => {
  const row = (over: Partial<SuppressionRow>): SuppressionRow => ({
    id: "a1",
    ruleCode: "NS-02",
    entity: "deal",
    entityId: "d1",
    recipientId: "u1",
    state: "dismissed",
    resolution: "Dismissed: waiting on legal",
    resolvedAt: D("2026-09-30T10:00:00Z"),
    ...over,
  });
  const now = D("2026-10-05T10:00:00Z");

  it("a dismissal suppresses while the condition holds (no expiry)", () => {
    expect(suppressionDecision(row({}), now, 24 * 3_600_000)).toBe("suppress");
  });
  it("a user resolve suppresses for the cool-down, then re-raises (quietly)", () => {
    const r = row({ state: "resolved", resolution: "Done by Ana", resolvedAt: D("2026-10-05T00:00:00Z") });
    expect(suppressionDecision(r, now, 24 * 3_600_000)).toBe("suppress");
    expect(suppressionDecision(r, D("2026-10-06T01:00:00Z"), 24 * 3_600_000)).toBe("expired");
  });
  it("auto-resolved / merged rows never suppress", () => {
    expect(isSuppressing(row({ state: "resolved", resolution: "Auto-resolved: condition cleared" }))).toBe(false);
    expect(isSuppressing(row({ state: "resolved", resolution: "Merged into another record" }))).toBe(false);
    expect(isSuppressing(row({ state: "resolved", resolution: "Approval approved by Exec" }))).toBe(true);
  });
  it("entity-deduped rules match the record regardless of recipient; fan-out rules need the recipient", () => {
    const idx = indexSuppressions([row({})]);
    const c = { ruleCode: "NS-02", entity: "deal", entityId: "d1", recipientId: "someone-else" };
    expect(idx.find(c, "entity")?.id).toBe("a1");
    expect(idx.find(c, "recipient")).toBeUndefined();
    expect(idx.find({ ...c, recipientId: "u1" }, "recipient")?.id).toBe("a1");
  });
});
