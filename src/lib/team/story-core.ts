/**
 * Team feed & win/loss stories (docs/V2_SPEC.md §C9) — pure, client-safe, unit-tested core:
 * story prefill heuristic, story body compose/parse, reactions, playbook tags.
 */
import { fmtNumber, fmtUsd } from "@/lib/format";

const DAY = 86_400_000;

export const POST_KINDS = ["win", "loss", "announcement", "clip"] as const;
export type PostKind = (typeof POST_KINDS)[number];

/** Playbook tags offered when clipping a call or adding a story to the playbook. */
export const PLAYBOOK_TAGS = ["objection", "pitch", "pricing", "coalition"] as const;
export type PlaybookTag = (typeof PLAYBOOK_TAGS)[number];
export const PLAYBOOK_TAG_LABELS: Record<PlaybookTag, string> = { objection: "Objection", pitch: "Pitch", pricing: "Pricing", coalition: "Coalition" };

/** The only reactions offered (emoji in the feed is allowed by the spec; nowhere else in chrome). */
export const REACTIONS = ["🎉", "👏", "🔥", "💡", "🙌", "❤️"] as const;
export type Reaction = (typeof REACTIONS)[number];
export const REACTION_NAMES: Record<Reaction, string> = { "🎉": "Celebrate", "👏": "Applause", "🔥": "Fire", "💡": "Insight", "🙌": "Raise hands", "❤️": "Love" };

/** Story prompts are offered for this long after a deal closes. */
export const STORY_WINDOW_DAYS = 7;
export const STORY_PROMPT_TTL_DAYS = 14;

/* ───────────── Prefill ───────────── */

export type StoryFacts = {
  status: "won" | "lost";
  dealName: string;
  accountName: string | null;
  pipelineKey: string;
  unit: "muu" | "usd" | "activation";
  valueUsd: number;
  muu: number | null;
  createdAt: Date;
  closedAt: Date;
  lostReason: string | null;
  /** Stage names in order entered (from stage history), first = where the deal started. */
  stagePath: string[];
  activity: { email: number; call: number; meeting: number };
  objections: { objection: string; response: string }[];
  champion: string | null;
};

export type StoryDraft = {
  kind: "win" | "loss";
  title: string;
  whatWorked: string;
  objection: string;
  timeline: string;
};

export const STORY_SECTION_LABELS = {
  win: { whatWorked: "What worked", objection: "Objection handled", timeline: "Timeline" },
  loss: { whatWorked: "What we'd do differently", objection: "Objection we couldn't overcome", timeline: "Timeline" },
} as const;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Human value: "12.4M MUU" for MUU motions, "$180K" for $ motions, "" when unknown. */
export function storyValue(f: Pick<StoryFacts, "unit" | "valueUsd" | "muu">): string {
  if (f.unit === "muu" && f.muu && f.muu > 0) return `${fmtNumber(f.muu, { compact: true })} MUU`;
  if (f.valueUsd > 0) return fmtUsd(f.valueUsd, { compact: true });
  return "";
}

/** Deterministic story prefill from deal facts. Only states facts; leaves blanks for the rep's judgement. */
export function prefillStory(f: StoryFacts): StoryDraft {
  const kind = f.status === "won" ? "win" : "loss";
  const value = storyValue(f);
  const title = kind === "win" ? `Won ${f.dealName}${value ? ` — ${value}` : ""}` : `Lost ${f.dealName} — what we learned`;

  const days = Math.max(1, Math.round((f.closedAt.getTime() - f.createdAt.getTime()) / DAY));
  const path = dedupeConsecutive(f.stagePath);
  const touches = [
    f.activity.meeting ? plural(f.activity.meeting, "meeting") : null,
    f.activity.call ? plural(f.activity.call, "call") : null,
    f.activity.email ? plural(f.activity.email, "email") : null,
  ].filter(Boolean);
  const timeline = [
    `${plural(days, "day")} from first entry to ${kind === "win" ? "signature" : "close"}.`,
    path.length > 1 ? `Path: ${path.slice(-6).join(" → ")}.` : null,
    touches.length ? `${touches.join(", ")}.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const worked: string[] = [];
  if (kind === "win") {
    if (f.champion) worked.push(`Champion: ${f.champion}.`);
    if (f.activity.meeting >= 3) worked.push(`Stayed in front of the buyer — ${plural(f.activity.meeting, "meeting")}.`);
    if (days <= 30) worked.push(`Fast cycle (${plural(days, "day")}).`);
  } else if (f.lostReason) {
    worked.push(`Lost reason: ${clip(f.lostReason, 200)}.`);
  }

  const o = f.objections.find((x) => x.objection.trim());
  const objection = o ? `“${clip(o.objection.trim(), 200)}”${o.response.trim() ? ` → ${clip(o.response.trim(), 240)}` : ""}` : "";

  return { kind, title: clip(title, 140), whatWorked: worked.join(" "), objection, timeline };
}

function dedupeConsecutive(xs: string[]): string[] {
  return xs.filter((x, i) => x && x !== xs[i - 1]);
}

/** Strip source citations the house system prompt asks models for ("(CRM)", "(crm_deal)") — feed text is prose. */
export function stripCitations(text: string): string {
  return text
    .replace(/\s*[([](?:source:\s*)?(?:crm|call|draft|transcript|email)[\w\s:.-]{0,30}[)\]]/gi, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ───────────── Body ───────────── */

/** Plain-text body (also used for Slack): labelled sections separated by blank lines; empty sections are dropped. */
export function composeStoryBody(kind: "win" | "loss", d: Pick<StoryDraft, "whatWorked" | "objection" | "timeline">): string {
  const labels = STORY_SECTION_LABELS[kind];
  return (["whatWorked", "objection", "timeline"] as const)
    .map((k) => [labels[k], d[k].trim()] as const)
    .filter(([, text]) => text)
    .map(([label, text]) => `${label}:\n${text}`)
    .join("\n\n");
}

export type BodyBlock = { label: string | null; text: string };

/** Split a post body into blocks; a block whose first line is a short "Label:" renders as a labelled section. */
export function parseBody(body: string | null | undefined): BodyBlock[] {
  if (!body?.trim()) return [];
  return body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const nl = block.indexOf("\n");
      const head = nl === -1 ? "" : block.slice(0, nl).trim();
      if (head.length > 1 && head.length <= 48 && head.endsWith(":") && !/[.!?]/.test(head.slice(0, -1))) {
        return { label: head.slice(0, -1), text: block.slice(nl + 1).trim() };
      }
      return { label: null, text: block };
    });
}

/* ───────────── Reactions ───────────── */

export function isReaction(x: string): x is Reaction {
  return (REACTIONS as readonly string[]).includes(x);
}

/** Toggle `userId` on `emoji` (pure; mirrors the SQL update for optimistic UI). Empty lists are removed. */
export function toggleReaction(reactions: Record<string, string[]>, emoji: string, userId: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(reactions ?? {})) if (Array.isArray(v) && v.length) out[k] = [...v];
  const list = out[emoji] ?? [];
  const next = list.includes(userId) ? list.filter((u) => u !== userId) : [...list, userId];
  if (next.length) out[emoji] = next;
  else delete out[emoji];
  return out;
}

/** Reaction pills in the fixed REACTIONS order (unknown keys ignored). */
export function reactionSummary(reactions: Record<string, string[]> | null | undefined, userId: string): { emoji: Reaction; count: number; mine: boolean }[] {
  return REACTIONS.map((emoji) => {
    const list = Array.isArray(reactions?.[emoji]) ? reactions![emoji]! : [];
    return { emoji, count: list.length, mine: list.includes(userId) };
  }).filter((r) => r.count > 0);
}

/* ───────────── Clips ───────────── */

/** Normalize text for "is this quote really in the transcript?" (whitespace, quotes, case). */
export function normalizeQuote(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The transcript text with "[hh:mm:ss] Speaker:" prefixes removed per line, so a selection across lines still matches. */
export function transcriptPlain(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.replace(/^\s*(?:\[\d{2}:\d{2}:\d{2}\]\s*)?(?:[^:\n]{1,60}:\s)?/, ""))
    .join(" ");
}

export function quoteInTranscript(quote: string, raw: string): boolean {
  const q = normalizeQuote(quote);
  if (q.length < 8) return false;
  return normalizeQuote(raw).includes(q) || normalizeQuote(transcriptPlain(raw)).includes(q);
}
