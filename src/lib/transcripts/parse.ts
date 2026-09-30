/**
 * Pure transcript parsing (CALL-4) — unit-tested.
 * Canonical stored format (transcripts.raw_text): one utterance per line, `[hh:mm:ss] Speaker: text`
 * (timestamp and speaker are optional). VTT/SRT cues are merged per consecutive speaker.
 */

export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = [".txt", ".vtt", ".srt", ".md"] as const;
export type TranscriptFormat = "vtt" | "srt" | "text";

export type Utterance = { ts: string | null; seconds: number | null; speaker: string | null; text: string };

export function fileExtension(name: string): string {
  const m = name.toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : "";
}

/** Validate an uploaded file name + size. Returns an error message or null. */
export function validateTranscriptFile(name: string, sizeBytes: number): string | null {
  const ext = fileExtension(name);
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) {
    const media = [".mp3", ".m4a", ".wav", ".mp4", ".mov"].includes(ext);
    const doc = [".docx", ".pdf", ".doc"].includes(ext);
    return media
      ? "Audio/video transcription isn't available yet. Upload the transcript text (.txt, .vtt, .srt or .md) instead."
      : doc
        ? `${ext} files aren't supported yet. Export the transcript as .txt, .vtt, .srt or .md, or paste the text.`
        : `Unsupported file type${ext ? ` (${ext})` : ""}. Use .txt, .vtt, .srt or .md.`;
  }
  if (sizeBytes <= 0) return "The file is empty.";
  if (sizeBytes > MAX_TRANSCRIPT_BYTES) return "The transcript is larger than 2 MB. Split it or paste the relevant part.";
  return null;
}

export function detectFormat(name: string | null, text: string): TranscriptFormat {
  const ext = name ? fileExtension(name) : "";
  if (ext === ".vtt" || /^﻿?WEBVTT/.test(text)) return "vtt";
  if (ext === ".srt" || /^﻿?\s*\d+\s*\r?\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(text)) return "srt";
  return "text";
}

/** "00:01:02.500" | "01:02.5" | "00:01:02,500" → seconds */
export function timeToSeconds(t: string): number | null {
  const m = t.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
export function secondsToTs(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function cleanCueText(t: string): string {
  return t
    .replace(/<\/?(c|i|b|u|ruby|rt|lang)[^>]*>/gi, "")
    .replace(/<\d{2}:\d{2}[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Speaker from `<v Name>` voice tag or a leading "Name: " prefix (≤ 5 words, no sentence punctuation). */
function splitSpeaker(text: string): { speaker: string | null; text: string } {
  const v = text.match(/^<v(?:\.[^\s>]+)?\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/i);
  if (v) return { speaker: v[1]!.trim(), text: cleanCueText(v[2]!) };
  const cleaned = cleanCueText(text);
  const p = cleaned.match(/^([A-Z][\w.'’-]*(?:\s[\w.'’()-]+){0,4}):\s+(.+)$/);
  if (p && !/[.!?]/.test(p[1]!)) return { speaker: p[1]!.trim(), text: p[2]!.trim() };
  return { speaker: null, text: cleaned };
}

type Cue = { start: number | null; text: string };

function parseCues(text: string, format: "vtt" | "srt"): Cue[] {
  const blocks = text.replace(/\r\n?/g, "\n").replace(/^﻿/, "").split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    if (format === "vtt" && /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0]!)) continue;
    const tIdx = lines.findIndex((l) => l.includes("-->"));
    if (tIdx < 0) continue;
    const start = timeToSeconds(lines[tIdx]!.split("-->")[0]!.trim());
    const body = lines.slice(tIdx + 1).join(" ").trim();
    if (!body) continue;
    cues.push({ start, text: body });
  }
  return cues;
}

/** Merge cues into utterances; consecutive cues from the same speaker are joined. */
export function cuesToUtterances(cues: Cue[]): Utterance[] {
  const out: Utterance[] = [];
  for (const c of cues) {
    const { speaker, text } = splitSpeaker(c.text);
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && prev.speaker === speaker && speaker !== null && prev.text.length < 1200) {
      prev.text = `${prev.text} ${text}`;
      continue;
    }
    out.push({ ts: c.start != null ? secondsToTs(c.start) : null, seconds: c.start, speaker, text });
  }
  return out;
}

/** Parse free text in the canonical format or common "Speaker (00:01:02): text" / "00:01:02 Speaker: text" shapes. */
export function parsePlainText(text: string): Utterance[] {
  const out: Utterance[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let ts: string | null = null;
    let rest = line;
    const lead = rest.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*/);
    if (lead) {
      const s = timeToSeconds(lead[1]!);
      ts = s != null ? secondsToTs(s) : null;
      rest = rest.slice(lead[0].length);
    }
    const inline = rest.match(/^([A-Z][\w.'’-]*(?:\s[\w.'’-]+){0,4})\s*\((\d{1,2}:\d{2}(?::\d{2})?)\)\s*:?\s*(.*)$/);
    if (inline) {
      const s = timeToSeconds(inline[2]!);
      out.push({ ts: s != null ? secondsToTs(s) : ts, seconds: s, speaker: inline[1]!, text: inline[3]!.trim() });
      continue;
    }
    const sp = splitSpeaker(rest);
    const seconds = ts ? timeToSeconds(ts) : null;
    const prev = out[out.length - 1];
    if (!sp.speaker && !ts && prev?.speaker) {
      prev.text = `${prev.text} ${sp.text}`.trim(); // continuation line
      continue;
    }
    out.push({ ts, seconds, speaker: sp.speaker, text: sp.text });
  }
  return out.filter((u) => u.text);
}

export function parseTranscript(name: string | null, text: string): { format: TranscriptFormat; utterances: Utterance[] } {
  const format = detectFormat(name, text);
  const utterances = format === "text" ? parsePlainText(text) : cuesToUtterances(parseCues(text, format));
  return { format, utterances };
}

export function formatUtterances(us: Utterance[]): string {
  return us.map((u) => `${u.ts ? `[${u.ts}] ` : ""}${u.speaker ? `${u.speaker}: ` : ""}${u.text}`).join("\n");
}

/** Parse → canonical text. Markdown/plain text passes through the plain parser (keeps speaker labels). */
export function normalizeTranscript(name: string | null, text: string): { text: string; format: TranscriptFormat; speakers: string[]; durationMin: number | null } {
  const { format, utterances } = parseTranscript(name, text);
  const speakers = [...new Set(utterances.map((u) => u.speaker).filter((s): s is string => Boolean(s)))];
  const secs = utterances.map((u) => u.seconds).filter((s): s is number => s != null);
  const durationMin = secs.length ? Math.max(1, Math.round(Math.max(...secs) / 60)) : null;
  return { text: formatUtterances(utterances), format, speakers, durationMin };
}
