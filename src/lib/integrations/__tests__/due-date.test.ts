import { describe, expect, it } from "vitest";
import { addBusinessDays, parseDue, parseIsoDue } from "../due-date";

// Wednesday 30 Sep 2026, 14:00 UTC
const REF = new Date("2026-09-30T14:00:00Z");
const day = (text: string) => parseDue(text, REF)?.date.toISOString().slice(0, 10) ?? null;

describe("parseDue", () => {
  it("resolves weekdays relative to the reference date", () => {
    expect(day("I'll send the contract Friday")).toBe("2026-10-02");
    expect(day("we'll get back to you by Fri.")).toBe("2026-10-02");
    expect(day("on Monday we can review")).toBe("2026-10-05");
    expect(day("next Friday works")).toBe("2026-10-09");
    expect(day("this Wednesday")).toBe("2026-09-30");
    expect(day("Wednesday")).toBe("2026-10-07");
  });
  it("does not treat common words as weekday abbreviations", () => {
    expect(parseDue("we sat down with the team", REF)).toBeNull();
  });
  it("handles relative expressions", () => {
    expect(day("I will do it today")).toBe("2026-09-30");
    expect(day("tomorrow")).toBe("2026-10-01");
    expect(day("by end of week")).toBe("2026-10-02");
    expect(day("by EOM")).toBe("2026-09-30");
    expect(day("next week")).toBe("2026-10-05");
    expect(day("in 3 days")).toBe("2026-10-03");
    expect(day("in two weeks")).toBe("2026-10-14");
    expect(day("in 2 business days")).toBe("2026-10-02");
    expect(day("in a couple of days")).toBe("2026-10-02");
  });
  it("handles explicit dates", () => {
    expect(day("by 2026-10-15")).toBe("2026-10-15");
    expect(day("on October 12th")).toBe("2026-10-12");
    expect(day("the 5th of Nov")).toBe("2026-11-05");
    expect(day("by 10/20")).toBe("2026-10-20");
    expect(day("Jan 3")).toBe("2027-01-03");
  });
  it("returns the earliest phrase and pins 17:00 UTC", () => {
    const r = parseDue("Friday or next week", REF)!;
    expect(r.phrase).toBe("Friday");
    expect(r.date.toISOString()).toBe("2026-10-02T17:00:00.000Z");
  });
  it("returns null for vague text", () => {
    expect(parseDue("after the board meeting", REF)).toBeNull();
    expect(parseDue("soon", REF)).toBeNull();
    expect(parseDue("", REF)).toBeNull();
  });
});

describe("parseIsoDue / addBusinessDays", () => {
  it("parses ISO, falls back to phrases, rejects absurd dates", () => {
    expect(parseIsoDue("2026-10-09", REF)?.toISOString().slice(0, 10)).toBe("2026-10-09");
    expect(parseIsoDue("next Friday", REF)?.toISOString().slice(0, 10)).toBe("2026-10-09");
    expect(parseIsoDue("1999-01-01", REF)).toBeNull();
    expect(parseIsoDue(null, REF)).toBeNull();
  });
  it("skips weekends", () => {
    expect(addBusinessDays(new Date("2026-10-02T12:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-10-05");
  });
});
