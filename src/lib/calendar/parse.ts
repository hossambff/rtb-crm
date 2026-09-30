/**
 * Pure Google Calendar event parsing (ACT-6) — unit-tested.
 * https://developers.google.com/calendar/api/v3/reference/events
 */
import { normalizeEmail } from "@/lib/integrations/matching-core";

export type CalendarEvent = {
  id: string;
  status?: string; // confirmed | tentative | cancelled
  summary?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; responseStatus?: string; resource?: boolean; self?: boolean; organizer?: boolean }[];
  organizer?: { email?: string; self?: boolean };
  hangoutLink?: string;
  location?: string;
  eventType?: string; // default | outOfOffice | focusTime | workingLocation
};

export type ParsedEvent = {
  id: string;
  cancelled: boolean;
  title: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  allDay: boolean;
  attendees: string[];
  conferencing: "zoom" | "meet" | "other" | null;
};

function toDate(v?: { dateTime?: string; date?: string }): Date | null {
  const s = v?.dateTime ?? (v?.date ? `${v.date}T00:00:00Z` : null);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseCalendarEvent(e: CalendarEvent): ParsedEvent {
  const emails = [
    ...(e.attendees ?? []).filter((a) => !a.resource && a.responseStatus !== "declined").map((a) => a.email),
    e.organizer?.email,
  ];
  const attendees = [...new Set(emails.map((x) => normalizeEmail(x)).filter((x): x is string => Boolean(x)))].filter(
    (x) => !x.endsWith("resource.calendar.google.com") && !x.endsWith("group.calendar.google.com"),
  );
  const loc = `${e.location ?? ""} ${e.hangoutLink ?? ""}`.toLowerCase();
  return {
    id: e.id,
    cancelled: e.status === "cancelled",
    title: e.summary?.trim() || null,
    startsAt: toDate(e.start),
    endsAt: toDate(e.end),
    allDay: Boolean(e.start?.date && !e.start?.dateTime),
    attendees,
    conferencing: loc.includes("zoom.us") ? "zoom" : e.hangoutLink || loc.includes("meet.google.com") ? "meet" : loc.trim() ? "other" : null,
  };
}

/** Only real meetings with other people are synced (skip all-day blocks, focus time, OOO, solo events). */
export function isSyncableEvent(p: ParsedEvent, raw: CalendarEvent, ownerEmail: string): boolean {
  if (p.cancelled || p.allDay || !p.startsAt) return false;
  if (raw.eventType && raw.eventType !== "default") return false;
  return p.attendees.some((a) => a !== ownerEmail.toLowerCase());
}

export function calendarWindow(now: Date, pastDays = 2, futureDays = 14): { timeMin: string; timeMax: string } {
  return {
    timeMin: new Date(now.getTime() - pastDays * 86_400_000).toISOString(),
    timeMax: new Date(now.getTime() + futureDays * 86_400_000).toISOString(),
  };
}
