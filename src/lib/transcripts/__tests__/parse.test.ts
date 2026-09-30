import { describe, expect, it } from "vitest";
import { detectFormat, normalizeTranscript, parsePlainText, timeToSeconds, validateTranscriptFile } from "../parse";

const VTT = `WEBVTT

NOTE Zoom export

1
00:00:01.000 --> 00:00:04.000
Alex Rep: Thanks for joining today.

2
00:00:04.500 --> 00:00:07.000
Alex Rep: Let's start with your traffic.

3
00:01:02.000 --> 00:01:09.000
<v Jane Doe>We have about 2.5 million monthly uniques.</v>

4
00:01:10.000 --> 00:01:12.000
<v.loud Jane Doe><i>It's</i> mostly finance.</v>
`;

const SRT = `1
00:00:01,000 --> 00:00:03,000
Jane: Hello there

2
00:00:03,500 --> 00:00:05,000
Bob: Hi Jane
second line
`;

describe("VTT / SRT", () => {
  it("parses VTT with prefixes and voice tags, merging consecutive speakers", () => {
    const r = normalizeTranscript("call.vtt", VTT);
    expect(r.format).toBe("vtt");
    expect(r.text.split("\n")).toEqual([
      "[00:00:01] Alex Rep: Thanks for joining today. Let's start with your traffic.",
      "[00:01:02] Jane Doe: We have about 2.5 million monthly uniques. It's mostly finance.",
    ]);
    expect(r.speakers).toEqual(["Alex Rep", "Jane Doe"]);
    expect(r.durationMin).toBe(1);
  });
  it("parses SRT with multi-line cues", () => {
    const r = normalizeTranscript("x.srt", SRT);
    expect(r.format).toBe("srt");
    expect(r.text).toBe("[00:00:01] Jane: Hello there\n[00:00:03] Bob: Hi Jane second line");
  });
  it("detects formats by content", () => {
    expect(detectFormat(null, "WEBVTT\n\n")).toBe("vtt");
    expect(detectFormat(null, "1\n00:00:01,000 --> 00:00:02,000\nx")).toBe("srt");
    expect(detectFormat("notes.md", "# Notes")).toBe("text");
  });
});

describe("plain text", () => {
  it("parses speaker labels, timestamps and continuation lines", () => {
    const us = parsePlainText("[00:00:05] Jane: Hello\nwrapped line\nBob (00:01:10): Hi\n00:02 Alex: ok\nmore from Alex");
    expect(us).toHaveLength(3);
    expect(us[0]).toMatchObject({ ts: "00:00:05", speaker: "Jane", text: "Hello wrapped line" });
    expect(us[1]).toMatchObject({ ts: "00:01:10", speaker: "Bob", text: "Hi" });
    expect(us[2]).toMatchObject({ ts: "00:00:02", speaker: "Alex", text: "ok more from Alex" });
    // lines without any speaker (e.g. markdown notes) stay separate
    expect(parsePlainText("# Notes\n- point one\n- point two")).toHaveLength(3);
  });
  it("time conversion", () => {
    expect(timeToSeconds("01:02:03.500")).toBe(3723);
    expect(timeToSeconds("02:03")).toBe(123);
    expect(timeToSeconds("bad")).toBeNull();
  });
});

describe("validateTranscriptFile", () => {
  it("accepts supported types and rejects others with clear messages", () => {
    expect(validateTranscriptFile("a.vtt", 100)).toBeNull();
    expect(validateTranscriptFile("a.MD", 100)).toBeNull();
    expect(validateTranscriptFile("a.mp3", 100)).toMatch(/Audio\/video/);
    expect(validateTranscriptFile("a.docx", 100)).toMatch(/\.docx/);
    expect(validateTranscriptFile("a.exe", 100)).toMatch(/Unsupported/);
    expect(validateTranscriptFile("a.txt", 3 * 1024 * 1024)).toMatch(/2 MB/);
    expect(validateTranscriptFile("a.txt", 0)).toMatch(/empty/);
  });
});
