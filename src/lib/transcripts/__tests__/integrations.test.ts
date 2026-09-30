import { describe, expect, it } from "vitest";
import { parseNote, parseNoteList, transcriptToText, validateGranolaKeyFormat } from "../granola-core";
import { expectedSignature, hmacHex, isZoomDownloadUrl, parseTranscriptEvent, urlValidationResponse, verifyZoomSignature } from "../zoom-core";

describe("granola", () => {
  it("validates key format", () => {
    expect(validateGranolaKeyFormat("")).toMatch(/Enter/);
    expect(validateGranolaKeyFormat("short")).toMatch(/length/);
    expect(validateGranolaKeyFormat("grn_abc def ghi jkl mno pqr")).toMatch(/spaces/);
    expect(validateGranolaKeyFormat("grn_" + "a".repeat(40))).toBeNull();
  });
  it("parses list responses of several shapes", () => {
    const a = parseNoteList({ notes: [{ id: "not_1", title: "Intro", created_at: "2026-09-29T10:00:00Z" }], hasMore: true, cursor: "c2" });
    expect(a).toMatchObject({ cursor: "c2", hasMore: true });
    expect(a.notes[0]).toMatchObject({ id: "not_1", title: "Intro" });
    expect(parseNoteList({ data: [{ id: "x" }] }).notes).toHaveLength(1);
    expect(parseNoteList([{ id: "y" }]).hasMore).toBe(false);
    expect(() => parseNoteList({ foo: 1 })).toThrow(/no notes array/);
  });
  it("parses a note with calendar event, attendees and transcript segments", () => {
    const n = parseNote(
      {
        id: "not_1",
        title: "Reach intro",
        created_at: "2026-09-29T10:00:00Z",
        calendar_event: {
          event_title: "Reach x RTB",
          scheduled_start_time: "2026-09-29T10:00:00Z",
          scheduled_end_time: "2026-09-29T10:30:00Z",
          calendar_event_id: "evt-9",
          invitees: [{ email: "Jane@Reach.co.uk" }],
        },
        attendees: [{ name: "Jane Doe", email: "jane@reach.co.uk" }, { name: "Alex", email: "alex@roundtable.io" }],
        summary_markdown: "## Notes",
        transcript: [
          { speaker: { source: "microphone" }, text: "Hi Jane.", start_time: "2026-09-29T10:00:05Z" },
          { speaker: { source: "microphone" }, text: "Thanks for joining.", start_time: "2026-09-29T10:00:08Z" },
          { speaker: { source: "speaker" }, text: "Happy to be here.", start_time: "2026-09-29T10:01:00Z" },
        ],
      },
      "Alex Rep",
    );
    expect(n.calendarEventId).toBe("evt-9");
    expect(n.attendees.map((a) => a.email)).toEqual(["jane@reach.co.uk", "alex@roundtable.io"]);
    expect(n.notesMarkdown).toBe("## Notes");
    expect(n.transcriptText).toBe("[00:00:05] Alex Rep: Hi Jane. Thanks for joining.\n[00:01:00] Other participant: Happy to be here.");
  });
  it("transcriptToText accepts strings and numeric offsets", () => {
    expect(transcriptToText("plain text", "A", null)).toBe("plain text");
    expect(transcriptToText([{ speaker: "Bob", text: "yo", start: 61 }], "A", null)).toBe("[00:01:01] Bob: yo");
    expect(transcriptToText({ nope: 1 }, "A", null)).toBeNull();
  });
});

describe("zoom", () => {
  const secret = "whsec_test";
  it("answers URL validation with HMAC of plainToken", () => {
    expect(urlValidationResponse("abc", secret)).toEqual({ plainToken: "abc", encryptedToken: hmacHex(secret, "abc") });
  });
  it("verifies signatures with timestamp skew", () => {
    const body = JSON.stringify({ event: "recording.transcript_completed" });
    const now = new Date("2026-09-30T12:00:00Z");
    const ts = String(Math.floor(now.getTime() / 1000));
    const sig = expectedSignature(secret, ts, body);
    expect(verifyZoomSignature({ secret, signature: sig, timestamp: ts, rawBody: body, now })).toEqual({ ok: true });
    expect(verifyZoomSignature({ secret, signature: sig, timestamp: ts, rawBody: body + " ", now }).ok).toBe(false);
    expect(verifyZoomSignature({ secret: "other", signature: sig, timestamp: ts, rawBody: body, now }).ok).toBe(false);
    const stale = String(Math.floor(now.getTime() / 1000) - 3600);
    expect(verifyZoomSignature({ secret, signature: expectedSignature(secret, stale, body), timestamp: stale, rawBody: body, now })).toMatchObject({
      ok: false,
      reason: "stale timestamp",
    });
    expect(verifyZoomSignature({ secret, signature: null, timestamp: ts, rawBody: body, now }).ok).toBe(false);
  });
  it("parses transcript_completed payloads", () => {
    const e = parseTranscriptEvent({
      event: "recording.transcript_completed",
      download_token: "dl-token",
      payload: {
        object: {
          uuid: "uuid==",
          id: 123,
          topic: "Reach x RTB",
          start_time: "2026-09-30T15:00:00Z",
          duration: 30,
          host_email: "Alex@Roundtable.io",
          recording_files: [
            { id: "f1", file_type: "MP4", download_url: "https://zoom.us/rec/download/a" },
            { id: "f2", file_type: "TRANSCRIPT", file_extension: "VTT", download_url: "https://zoom.us/rec/download/b" },
          ],
        },
      },
    })!;
    expect(e).toMatchObject({ meetingUuid: "uuid==", meetingId: "123", hostEmail: "alex@roundtable.io", downloadToken: "dl-token", durationMin: 30 });
    expect(e.transcriptFile).toEqual({ id: "f2", downloadUrl: "https://zoom.us/rec/download/b" });
    expect(parseTranscriptEvent({})).toBeNull();
  });
  it("only downloads from Zoom hosts", () => {
    expect(isZoomDownloadUrl("https://us02web.zoom.us/rec/download/x")).toBe(true);
    expect(isZoomDownloadUrl("https://evil.com/zoom.us")).toBe(false);
    expect(isZoomDownloadUrl("http://zoom.us/x")).toBe(false);
  });
});
