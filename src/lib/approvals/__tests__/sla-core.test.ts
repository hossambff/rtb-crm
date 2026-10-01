import { describe, expect, it } from "vitest";
import { addSlaHours, computeDueAt, DEFAULT_SLA_SETTINGS, escalationRoles, fmtDuration, normalizeSlaSettings, slaStatus } from "../sla-core";

const NY = "America/New_York";
const H = 3_600_000;

describe("normalizeSlaSettings", () => {
  it("has the spec defaults", () => {
    const s = normalizeSlaSettings(null);
    expect(s.hours).toMatchObject({ probability_override: 24, proposal: 48, scout_budget: 24, stage_gate: 24, lead_registration: 72 });
    expect(s.pauseWeekends).toBe(false);
  });
  it("merges valid overrides and drops invalid ones", () => {
    const s = normalizeSlaSettings({ hours: { proposal: 12, stage_gate: -1, scout_budget: "x", "Bad Key": 5 }, defaultHours: 99999, pauseWeekends: true, timezone: "Not/AZone" });
    expect(s.hours.proposal).toBe(12);
    expect(s.hours.stage_gate).toBe(24);
    expect(s.hours.scout_budget).toBe(24);
    expect(s.hours["Bad Key"]).toBeUndefined();
    expect(s.defaultHours).toBe(24);
    expect(s.pauseWeekends).toBe(true);
    expect(s.timezone).toBe(NY);
  });
});

describe("addSlaHours", () => {
  it("calendar mode is plain addition", () => {
    const from = new Date("2026-10-02T19:00:00Z");
    expect(addSlaHours(from, 24, { pauseWeekends: false, tz: NY }).toISOString()).toBe("2026-10-03T19:00:00.000Z");
  });
  it("pausing weekends: Friday 3 pm + 24 h = Monday 3 pm (local)", () => {
    const fri = new Date("2026-10-02T19:00:00Z"); // Fri 15:00 EDT
    expect(addSlaHours(fri, 24, { pauseWeekends: true, tz: NY }).toISOString()).toBe("2026-10-05T19:00:00.000Z");
  });
  it("a request raised on Saturday starts its clock Monday 00:00", () => {
    const sat = new Date("2026-10-03T16:00:00Z"); // Sat 12:00 EDT
    expect(addSlaHours(sat, 24, { pauseWeekends: true, tz: NY }).toISOString()).toBe("2026-10-06T04:00:00.000Z"); // Tue 00:00 EDT
  });
  it("weekday-only spans stay plain", () => {
    const mon = new Date("2026-10-05T13:00:00Z");
    expect(addSlaHours(mon, 48, { pauseWeekends: true, tz: NY }).toISOString()).toBe("2026-10-07T13:00:00.000Z");
  });
  it("72 h from Thursday skips one weekend", () => {
    const thu = new Date("2026-10-01T14:00:00Z"); // Thu 10:00 EDT
    expect(addSlaHours(thu, 72, { pauseWeekends: true, tz: NY }).toISOString()).toBe("2026-10-06T14:00:00.000Z"); // Tue 10:00
  });
  it("computeDueAt uses the kind's hours", () => {
    const t = new Date("2026-10-05T13:00:00Z");
    expect(computeDueAt("proposal", t, DEFAULT_SLA_SETTINGS).getTime() - t.getTime()).toBe(48 * H);
    expect(computeDueAt("brand_new_kind", t, DEFAULT_SLA_SETTINGS).getTime() - t.getTime()).toBe(24 * H);
  });
});

describe("slaStatus", () => {
  const created = new Date("2026-10-01T00:00:00Z");
  const due = new Date(created.getTime() + 24 * H);
  it("ok / due soon / overdue", () => {
    expect(slaStatus({ createdAt: created, dueAt: due }, new Date(created.getTime() + 2 * H))).toMatchObject({ state: "ok", waiting: "2h", dueLabel: "due in 22h" });
    expect(slaStatus({ createdAt: created, dueAt: due }, new Date(created.getTime() + 20 * H)).state).toBe("due_soon");
    expect(slaStatus({ createdAt: created, dueAt: due }, new Date(created.getTime() + 27 * H))).toMatchObject({ state: "overdue", dueLabel: "overdue by 3h" });
  });
  it("no due date", () => {
    expect(slaStatus({ createdAt: created, dueAt: null }, due).state).toBe("none");
  });
});

describe("helpers", () => {
  it("fmtDuration", () => {
    expect(fmtDuration(0)).toBe("1m");
    expect(fmtDuration(45 * 60_000)).toBe("45m");
    expect(fmtDuration(3 * H)).toBe("3h");
    expect(fmtDuration(52 * H)).toBe("2d 4h");
    expect(fmtDuration(48 * H)).toBe("2d");
  });
  it("escalation goes one role up", () => {
    expect(escalationRoles("sales_leader")).toEqual(["executive"]);
    expect(escalationRoles("finance")).toEqual(["executive"]);
    expect(escalationRoles("executive")).toEqual(["super_admin"]);
  });
});
