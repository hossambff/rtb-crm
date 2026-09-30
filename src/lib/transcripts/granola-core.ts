/**
 * Granola public API — pure parsing (CALL-2, D3/D6: one API key per user). Unit-tested with fixtures.
 * The exact response shape may evolve; parsing is defensive and all endpoint paths live in GRANOLA_API.
 */
import { secondsToTs, timeToSeconds } from "./parse";
import { normalizeEmail } from "@/lib/integrations/matching-core";

/** Adjust here if Granola changes its public API. */
export const GRANOLA_API = {
  base: "https://public-api.granola.ai",
  listNotes: "/v1/notes", // GET ?created_after=ISO&page_size=N&cursor=…
  getNote: (id: string) => `/v1/notes/${encodeURIComponent(id)}`, // GET ?include=transcript
  transcriptQuery: "include=transcript",
  pageSize: 25,
  maxPages: 4,
} as const;

/** Format check only (the real check is a live API call on save). */
export function validateGranolaKeyFormat(key: string): string | null {
  const k = key.trim();
  if (!k) return "Enter your Granola API key.";
  if (/\s/.test(k)) return "The key must not contain spaces.";
  if (k.length < 20 || k.length > 256) return "That doesn't look like a Granola API key (unexpected length).";
  if (!/^[A-Za-z0-9_\-.:]+$/.test(k)) return "The key contains unexpected characters.";
  return null;
}

export type GranolaNoteSummary = { id: string; title: string | null; createdAt: Date | null; updatedAt: Date | null };
export type GranolaNote = GranolaNoteSummary & {
  startsAt: Date | null;
  endsAt: Date | null;
  attendees: { name: string | null; email: string | null }[];
  calendarEventId: string | null;
  notesMarkdown: string | null;
  transcriptText: string | null; // canonical "[hh:mm:ss] Speaker: text"
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const date = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function parseNoteList(json: unknown): { notes: GranolaNoteSummary[]; cursor: string | null; hasMore: boolean } {
  if (!isObj(json) && !Array.isArray(json)) throw new Error("Granola: unexpected list response");
  const arr = Array.isArray(json) ? json : ((json.notes ?? json.data ?? json.items ?? json.results) as unknown);
  if (!Array.isArray(arr)) throw new Error("Granola: list response has no notes array");
  const notes = arr.filter(isObj).map((n) => ({
    id: String(n.id ?? n.note_id ?? ""),
    title: str(n.title) ?? str(n.name),
    createdAt: date(n.created_at ?? n.createdAt),
    updatedAt: date(n.updated_at ?? n.updatedAt),
  }));
  const meta = isObj(json) ? json : {};
  const cursor = str(meta.cursor) ?? str(meta.next_cursor) ?? str(meta.nextCursor) ?? null;
  const hasMore = Boolean(meta.hasMore ?? meta.has_more ?? cursor);
  return { notes: notes.filter((n) => n.id), cursor, hasMore };
}

function segmentSpeaker(seg: Obj, ownerName: string): string {
  const sp = seg.speaker;
  if (typeof sp === "string" && sp.trim()) return sp.trim();
  if (isObj(sp)) {
    const name = str(sp.name) ?? str(sp.diarization_label) ?? str(sp.label);
    if (name) return name;
    if (sp.source === "microphone") return ownerName;
    if (sp.source === "speaker" || sp.source === "system") return "Other participant";
  }
  if (seg.source === "microphone") return ownerName;
  if (seg.source === "system" || seg.source === "speaker") return "Other participant";
  return str(seg.speaker_name) ?? "Speaker";
}

function segmentSeconds(v: unknown, base: Date | null): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v < 1e9) return v; // offset in seconds
    const ms = v > 1e12 ? v : v * 1000; // epoch seconds or milliseconds
    return base ? Math.max(0, (ms - base.getTime()) / 1000) : null;
  }
  const s = str(v);
  if (!s) return null;
  if (/^\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?$/.test(s)) return timeToSeconds(s);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime()) && base) return Math.max(0, (d.getTime() - base.getTime()) / 1000);
  return null;
}

/** Transcript can be an array of segments, an object with `segments`, or a plain string. */
export function transcriptToText(t: unknown, ownerName: string, base: Date | null): string | null {
  if (typeof t === "string") return t.trim() || null;
  const arr = Array.isArray(t) ? t : isObj(t) ? (t.segments ?? t.entries ?? t.utterances) : null;
  if (!Array.isArray(arr)) return null;
  const lines: string[] = [];
  let prevSpeaker: string | null = null;
  for (const seg of arr) {
    if (!isObj(seg)) continue;
    const text = str(seg.text) ?? str(seg.content);
    if (!text) continue;
    const speaker = segmentSpeaker(seg, ownerName);
    const secs = segmentSeconds(seg.start_time ?? seg.start ?? seg.startTime ?? seg.timestamp, base);
    if (speaker === prevSpeaker && lines.length && lines[lines.length - 1]!.length < 1200) {
      lines[lines.length - 1] += ` ${text.trim()}`;
      continue;
    }
    lines.push(`${secs != null ? `[${secondsToTs(secs)}] ` : ""}${speaker}: ${text.trim()}`);
    prevSpeaker = speaker;
  }
  return lines.length ? lines.join("\n") : null;
}

export function parseNote(json: unknown, ownerName: string): GranolaNote {
  const n = isObj(json) && isObj(json.note) ? json.note : json;
  if (!isObj(n)) throw new Error("Granola: unexpected note response");
  const cal = isObj(n.calendar_event) ? n.calendar_event : isObj(n.calendarEvent) ? n.calendarEvent : {};
  const startsAt = date(cal.scheduled_start_time ?? cal.start_time ?? cal.start ?? n.start_time) ?? null;
  const people = [
    ...(Array.isArray(n.attendees) ? n.attendees : []),
    ...(Array.isArray(cal.invitees) ? cal.invitees : []),
    ...(Array.isArray(cal.attendees) ? cal.attendees : []),
  ].filter(isObj);
  const seen = new Set<string>();
  const attendees: GranolaNote["attendees"] = [];
  for (const p of people) {
    const email = normalizeEmail(str(p.email));
    const name = str(p.name) ?? str(p.display_name);
    const key = email ?? name ?? "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    attendees.push({ name, email });
  }
  const createdAt = date(n.created_at ?? n.createdAt);
  return {
    id: String(n.id ?? n.note_id ?? ""),
    title: str(n.title) ?? str(cal.event_title) ?? str(cal.title),
    createdAt,
    updatedAt: date(n.updated_at ?? n.updatedAt),
    startsAt,
    endsAt: date(cal.scheduled_end_time ?? cal.end_time ?? cal.end),
    attendees,
    calendarEventId: str(cal.calendar_event_id) ?? str(cal.id),
    notesMarkdown: str(n.summary_markdown) ?? str(n.summary_text) ?? str(n.notes_markdown) ?? str(n.enhanced_notes) ?? null,
    transcriptText: transcriptToText(n.transcript, ownerName, startsAt ?? createdAt),
  };
}
