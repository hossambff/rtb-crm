import { describe, expect, it } from "vitest";
import { calendarWindow, isSyncableEvent, parseCalendarEvent, type CalendarEvent } from "../parse";

const evt: CalendarEvent = {
  id: "e1",
  status: "confirmed",
  summary: " Reach x RTB ",
  start: { dateTime: "2026-10-01T15:00:00-04:00" },
  end: { dateTime: "2026-10-01T15:30:00-04:00" },
  attendees: [
    { email: "me@roundtable.io", self: true },
    { email: "Jane@Reach.co.uk" },
    { email: "declined@reach.co.uk", responseStatus: "declined" },
    { email: "room-1@resource.calendar.google.com", resource: true },
  ],
  organizer: { email: "me@roundtable.io" },
  location: "https://us02web.zoom.us/j/123",
};

describe("parseCalendarEvent", () => {
  it("parses attendees (dropping declined/resources) and times", () => {
    const p = parseCalendarEvent(evt);
    expect(p.title).toBe("Reach x RTB");
    expect(p.attendees).toEqual(["me@roundtable.io", "jane@reach.co.uk"]);
    expect(p.startsAt?.toISOString()).toBe("2026-10-01T19:00:00.000Z");
    expect(p.conferencing).toBe("zoom");
    expect(isSyncableEvent(p, evt, "me@roundtable.io")).toBe(true);
  });
  it("skips all-day, cancelled, solo and non-default events", () => {
    const allDay = { ...evt, start: { date: "2026-10-01" }, end: { date: "2026-10-02" } };
    expect(isSyncableEvent(parseCalendarEvent(allDay), allDay, "me@roundtable.io")).toBe(false);
    const cancelled = { ...evt, status: "cancelled" };
    expect(isSyncableEvent(parseCalendarEvent(cancelled), cancelled, "me@roundtable.io")).toBe(false);
    const solo = { ...evt, attendees: [], organizer: { email: "me@roundtable.io" } };
    expect(isSyncableEvent(parseCalendarEvent(solo), solo, "me@roundtable.io")).toBe(false);
    const focus = { ...evt, eventType: "focusTime" };
    expect(isSyncableEvent(parseCalendarEvent(focus), focus, "me@roundtable.io")).toBe(false);
  });
  it("computes the sync window", () => {
    const w = calendarWindow(new Date("2026-09-30T00:00:00Z"));
    expect(w).toEqual({ timeMin: "2026-09-28T00:00:00.000Z", timeMax: "2026-10-14T00:00:00.000Z" });
  });
});
