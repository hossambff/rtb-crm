/**
 * Quick capture (V2 A10) — pure parsing, unit-tested. A dictated or typed note becomes:
 *   note (always) + tasks ("todo: …", "remind me to …") + next step ("next step: …") + field updates (MUU, close date).
 * Works without AI; the AI path (aiCaptureSchema) is normalized through the same shape and grounded checks.
 */
import { z } from "zod";
import { parseAudience } from "@/lib/domain";
import { parseDue } from "@/lib/integrations/due-date";
import { resolveCloseDate } from "@/lib/signals/core";

export type CaptureTask = { title: string; due: string | null };
export type CaptureField = { field: "muu" | "expected_close_date"; value: string; label: string };
export type CaptureParse = {
  note: string;
  tasks: CaptureTask[];
  nextStep: { text: string; due: string | null } | null;
  fieldUpdates: CaptureField[];
  engine: string;
};

export const MAX_CAPTURE_CHARS = 5_000;

const MARKER = /(?:^|(?<=[\s.;,!?\n]))(todo|to-do|to do|task|action item|reminder|remind me to|next step|next steps|follow up (?:with|on)|follow-up (?:with|on))\b\s*[:\-–—,]?\s*/gi;

type Segment = { marker: string | null; text: string };

/** Split into marker-led segments; a segment ends at the next marker, a newline, or a sentence end. */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  const src = text.replace(/\r/g, "");
  const marks = [...src.matchAll(MARKER)];
  let cursor = 0;
  const pushFree = (chunk: string) => {
    const t = chunk.trim();
    if (t) out.push({ marker: null, text: t });
  };
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    const start = m.index!;
    pushFree(src.slice(cursor, start));
    const bodyStart = start + m[0].length;
    const nextMark = i + 1 < marks.length ? marks[i + 1]!.index! : src.length;
    let body = src.slice(bodyStart, nextMark);
    // A marker's body runs to the end of its line / sentence; the remainder is free text again.
    const stop = body.search(/\n|(?<=[.!?])\s+(?=[A-Z])/);
    let rest = "";
    if (stop >= 0) {
      rest = body.slice(stop);
      body = body.slice(0, stop);
    }
    const marker = m[1]!.toLowerCase();
    const prefix = marker.startsWith("follow") ? "Follow up " + marker.replace(/^follow[- ]up\s*/, "") + " " : "";
    out.push({ marker, text: (prefix + body).trim().replace(/[.;,]+$/, "") });
    pushFree(rest);
    cursor = nextMark;
  }
  pushFree(src.slice(cursor));
  // Checkbox bullets ("- [ ] send deck") are tasks too.
  return out.flatMap((seg) => {
    if (seg.marker) return [seg];
    return seg.text.split("\n").map((line) => {
      const box = line.match(/^\s*[-*•]?\s*\[\s?\]\s*(.+)$/);
      return box ? { marker: "todo", text: box[1]!.trim() } : { marker: null, text: line.trim() };
    });
  }).filter((x) => x.text.length > 0);
}

const MUU_RE = /(\d+(?:[.,]\d+)?\s*(?:k|m|mm|million|thousand)?)\+?\s*(?:muu|monthly uniques?|monthly unique (?:users|visitors)|uniques)\b|\bmuu\s*(?:is|of|=|:)?\s*(\d+(?:[.,]\d+)?\s*(?:k|m|mm|million|thousand)?)/i;
const CLOSE_RE = /\b(?:close date|closing|expected close|close)\s*(?:is|:|=|by|in|to)?\s*(.+)$/i;

function cleanTask(t: string): string {
  return t.replace(/^(to\s+)/i, "").replace(/\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 240);
}

/** Deterministic parse (the no-AI path). `now` resolves relative dates ("by Friday"). */
export function parseCaptureHeuristic(text: string, now: Date): CaptureParse {
  const src = text.slice(0, MAX_CAPTURE_CHARS);
  const tasks: CaptureTask[] = [];
  let nextStep: CaptureParse["nextStep"] = null;
  const noteParts: string[] = [];
  for (const seg of segments(src)) {
    if (seg.marker && /^next step/.test(seg.marker)) {
      if (!nextStep && seg.text.length > 2) nextStep = { text: cleanTask(seg.text), due: parseDue(seg.text, now)?.date.toISOString() ?? null };
      continue;
    }
    if (seg.marker) {
      if (seg.text.length > 2 && tasks.length < 10) tasks.push({ title: cleanTask(seg.text), due: parseDue(seg.text, now)?.date.toISOString() ?? null });
      continue;
    }
    noteParts.push(seg.text);
  }

  const fieldUpdates: CaptureField[] = [];
  const muu = src.match(MUU_RE);
  if (muu) {
    const raw = (muu[1] ?? muu[2] ?? "").toLowerCase().replace(/\s+/g, "").replace(/million|mm/, "m").replace(/thousand/, "k").replace(/,(?=\d{3}\b)/g, "");
    const n = parseAudience(raw);
    if (n && n > 0) fieldUpdates.push({ field: "muu", value: String(n), label: `MUU → ${n.toLocaleString("en-US")}` });
  }
  for (const line of src.split(/\n|(?<=[.!?])\s+/)) {
    const m = line.match(CLOSE_RE);
    if (!m) continue;
    const iso = m[1]!.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
    const d = iso ? new Date(`${iso}T17:00:00Z`) : (resolveCloseDate(`close ${m[1]}`, now)?.date ?? parseDue(m[1], now)?.date ?? null);
    if (d && !Number.isNaN(d.getTime())) {
      fieldUpdates.push({ field: "expected_close_date", value: d.toISOString(), label: `Expected close → ${d.toISOString().slice(0, 10)}` });
      break;
    }
  }

  const note = (noteParts.join("\n").trim() || src.trim()).slice(0, MAX_CAPTURE_CHARS);
  return { note, tasks: dedupeTasks(tasks), nextStep, fieldUpdates, engine: "heuristic" };
}

function dedupeTasks(tasks: CaptureTask[]): CaptureTask[] {
  const seen = new Set<string>();
  return tasks.filter((t) => {
    const k = t.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ───────────────────────────── AI path ───────────────────────────── */

export const aiCaptureSchema = z.object({
  note: z.string().describe("A clean, concise version of the note (keep all facts, no invention)"),
  tasks: z.array(z.object({ title: z.string(), due: z.string().nullable().describe("ISO-8601 date if stated, else null") })),
  next_step: z.object({ text: z.string(), due: z.string().nullable() }).nullable(),
  muu: z.number().nullable().describe("Monthly unique users if explicitly stated, else null"),
  expected_close_date: z.string().nullable().describe("ISO-8601 date only if the note explicitly changes the expected close, else null"),
  deal_or_account_hint: z.string().nullable().describe("Company / deal name the note is about, if mentioned"),
});
export type AiCapture = z.infer<typeof aiCaptureSchema>;

export function capturePrompt(wrappedText: string, now: Date): string {
  return [
    `Turn this sales rep's quick note into structured CRM updates. Today is ${now.toISOString().slice(0, 10)}; resolve relative dates against it.`,
    "Only extract what the note says: tasks the rep must do, the deal's next step, MUU (monthly unique users) and expected close date when explicitly stated.",
    wrappedText,
  ].join("\n");
}

const isoOrNull = (v: string | null | undefined, now: Date): string | null => {
  if (!v) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T17:00:00Z` : v);
  if (Number.isNaN(d.getTime())) return null;
  // Guard against hallucinated far-past / far-future dates.
  if (d.getTime() < now.getTime() - 30 * 86_400_000 || d.getTime() > now.getTime() + 3 * 365 * 86_400_000) return null;
  return d.toISOString();
};

/** Normalize AI output; numbers must appear in the source text (grounding), dates must be sane. */
export function normalizeAiCapture(ai: AiCapture, text: string, now: Date, model: string): CaptureParse {
  const fieldUpdates: CaptureField[] = [];
  const digits = text.replace(/[,\s]/g, "");
  if (ai.muu && ai.muu > 0) {
    const n = Math.round(ai.muu);
    const shown = [String(n), String(n / 1_000_000), String(n / 1000)].some((x) => digits.includes(x.replace(/\.0+$/, "")));
    if (shown || MUU_RE.test(text)) fieldUpdates.push({ field: "muu", value: String(n), label: `MUU → ${n.toLocaleString("en-US")}` });
  }
  const close = isoOrNull(ai.expected_close_date, now);
  if (close) fieldUpdates.push({ field: "expected_close_date", value: close, label: `Expected close → ${close.slice(0, 10)}` });
  return {
    note: (ai.note.trim() || text.trim()).slice(0, MAX_CAPTURE_CHARS),
    tasks: dedupeTasks(ai.tasks.filter((t) => t.title.trim().length > 2).slice(0, 10).map((t) => ({ title: cleanTask(t.title), due: isoOrNull(t.due, now) }))),
    nextStep: ai.next_step?.text.trim() ? { text: cleanTask(ai.next_step.text), due: isoOrNull(ai.next_step.due, now) } : null,
    fieldUpdates,
    engine: `ai:${model}`,
  };
}

/* ───────────────────────────── Target auto-detect ───────────────────────────── */

export type CaptureTargetCandidate = { kind: "deal" | "account"; id: string; name: string; accountName?: string | null; mine?: boolean };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function nameVariants(name: string): string[] {
  const base = name.replace(/\s+[—–-]\s+.*$/, "").replace(/\(.*?\)/g, "").trim(); // "TheStreet — NET" → "TheStreet"
  return [...new Set([name.trim(), base])].filter((n) => n.length >= 3);
}

/** Which deal/account the note is about: the longest name mentioned as a whole word; the user's own deal wins ties. */
export function detectTarget(text: string, candidates: CaptureTargetCandidate[]): CaptureTargetCandidate | null {
  let best: { c: CaptureTargetCandidate; len: number; score: number } | null = null;
  for (const c of candidates) {
    for (const v of [...nameVariants(c.name), ...(c.accountName ? nameVariants(c.accountName) : [])]) {
      if (!new RegExp(`(^|[^\\p{L}\\p{N}])${esc(v)}($|[^\\p{L}\\p{N}])`, "iu").test(text)) continue;
      const score = v.length * 10 + (c.kind === "deal" ? 5 : 0) + (c.mine ? 3 : 0);
      if (!best || score > best.score) best = { c, len: v.length, score };
    }
  }
  return best?.c ?? null;
}

/** `/deals/<uuid>…` or `/accounts/<uuid>…` → the record the page is about (Capture opens pre-targeted on it). */
export function captureTargetFromPath(path: string | null | undefined): { kind: "deal" | "account"; id: string } | null {
  const m = /^\/(deals|accounts)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i.exec(path ?? "");
  if (!m) return null;
  return { kind: m[1] === "deals" ? "deal" : "account", id: m[2]!.toLowerCase() };
}
