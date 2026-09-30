/**
 * Post-call processing (CALL-6, Appendix D "Transcript analysis"): zod schema for the AI call and a deterministic
 * heuristic fallback. Pure and unit-tested.
 */
import { z } from "zod";
import { parseAudience } from "@/lib/domain";
import { parseDue, parseIsoDue } from "@/lib/integrations/due-date";
import { heuristicSentiment, splitSentences } from "@/lib/gmail/analysis-core";
import { matchStageName } from "@/lib/integrations/matching-core";
import { parsePlainText, type Utterance } from "./parse";

export const transcriptAnalysisAiSchema = z.object({
  summary: z.array(z.string()).describe("Exactly 5 concise executive-summary bullets"),
  decisions: z.array(z.string()),
  action_items: z.array(
    z.object({
      owner: z.string().describe('"us" (RTB side), "them" (prospect side) or a specific person name'),
      task: z.string(),
      due: z.string().nullable().describe("ISO-8601 date if stated or clearly inferable relative to the call date, else null"),
      evidence: z.string().describe("Exact quote from the transcript"),
      timestamp: z.string().nullable().describe("hh:mm:ss of the evidence line if present"),
    }),
  ),
  objections: z.array(z.object({ objection: z.string(), response_given: z.string(), recommended_rebuttal: z.string() })),
  qualification: z.object({
    muu_confirmed: z.number().nullable().describe("Monthly unique users stated by the prospect, as an integer"),
    decision_maker: z.string().nullable(),
    current_stack: z.array(z.string()),
    pain: z.array(z.string()),
    timeline: z.string().nullable(),
    rev_share_appetite: z.string().nullable(),
    nda_status: z.string().nullable(),
    migration_complexity: z.enum(["low", "med", "high"]).nullable(),
  }),
  competitors: z.array(z.string()),
  risks: z.array(z.string()),
  sentiment: z.number().describe("-1 to 1"),
  suggested_stage: z.object({ stage: z.string().nullable(), confidence: z.number(), reason: z.string() }),
  field_updates: z.array(z.object({ field: z.string().describe("muu | next_step | expected_close_date"), value: z.string(), evidence: z.string() })),
  follow_up_email_draft: z.object({ subject: z.string(), body: z.string() }),
});
export type TranscriptAnalysisAi = z.infer<typeof transcriptAnalysisAiSchema>;

export type ActionItem = { id: string; owner: string; task: string; due: string | null; evidence: string; timestamp: string | null };
export type FieldUpdate = { field: "muu" | "next_step" | "expected_close_date"; value: string; evidence: string };
export type TranscriptAnalysis = Omit<TranscriptAnalysisAi, "action_items" | "field_updates" | "follow_up_email_draft"> & {
  action_items: ActionItem[];
  field_updates: FieldUpdate[];
  follow_up_email_draft: { subject: string; body: string; claims_check: "pass" | "flagged" | "unchecked" };
  engine: string;
};

export type TranscriptContext = {
  title: string | null;
  occurredAt: Date;
  ourNames: string[]; // RTB-side participant names (uploader, owner) — used to attribute "us"
  ownerName: string;
  accountName?: string | null;
  /** Stage names of the attached deal's pipeline — the model must pick one of these (or null). */
  stageNames?: string[];
};

export { matchStageName };

const ALLOWED_FIELDS = new Set(["muu", "next_step", "expected_close_date"]);
const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0);

export function normalizeAiTranscriptAnalysis(ai: TranscriptAnalysisAi, text: string, ctx: TranscriptContext, model: string): TranscriptAnalysis {
  const lower = text.toLowerCase().replace(/\s+/g, " ");
  const grounded = (q: string) => {
    const t = q.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);
    return t.length > 0 && lower.includes(t);
  };
  return {
    summary: ai.summary.slice(0, 7).map((s) => s.slice(0, 400)),
    decisions: ai.decisions.slice(0, 10),
    action_items: ai.action_items
      .filter((a) => a.task.trim())
      .slice(0, 20)
      .map((a, i) => ({
        id: `a${i + 1}`,
        owner: a.owner.slice(0, 80),
        task: a.task.slice(0, 300),
        // QA-11: an explicit phrase in the quote/task ("next week", "by Friday") resolved against the call date beats the
        // model's own date guess, which drifted (e.g. "next week" → this Friday).
        due: (parseDue(a.evidence, ctx.occurredAt)?.date ?? parseDue(a.task, ctx.occurredAt)?.date ?? parseIsoDue(a.due, ctx.occurredAt) ?? null)?.toISOString() ?? null,
        evidence: grounded(a.evidence) ? a.evidence.slice(0, 500) : "",
        timestamp: a.timestamp && /^\d{1,2}:\d{2}(:\d{2})?$/.test(a.timestamp) ? a.timestamp : findTimestamp(text, a.evidence),
      })),
    objections: ai.objections.slice(0, 10),
    qualification: {
      ...ai.qualification,
      muu_confirmed: ai.qualification.muu_confirmed && ai.qualification.muu_confirmed > 0 ? Math.round(ai.qualification.muu_confirmed) : null,
    },
    competitors: ai.competitors.slice(0, 10),
    risks: ai.risks.slice(0, 10),
    sentiment: clamp(ai.sentiment, -1, 1),
    suggested_stage: {
      ...ai.suggested_stage,
      stage: ctx.stageNames?.length ? matchStageName(ai.suggested_stage.stage, ctx.stageNames) : ai.suggested_stage.stage,
      confidence: clamp(ai.suggested_stage.confidence, 0, 1),
    },
    field_updates: ai.field_updates
      .filter((f) => ALLOWED_FIELDS.has(f.field) && grounded(f.evidence))
      .map((f) => ({ field: f.field as FieldUpdate["field"], value: String(f.value).slice(0, 300), evidence: f.evidence.slice(0, 500) })),
    follow_up_email_draft: { ...ai.follow_up_email_draft, claims_check: "unchecked" },
    engine: `ai:${model}`,
  };
}

/** Find the [hh:mm:ss] of the line containing the quote. */
export function findTimestamp(text: string, quote: string): string | null {
  const q = quote.trim().toLowerCase().slice(0, 40);
  if (!q) return null;
  for (const line of text.split("\n")) {
    if (line.toLowerCase().includes(q)) return line.match(/^\[(\d{2}:\d{2}:\d{2})\]/)?.[1] ?? null;
  }
  return null;
}

/* ───────────────────────────── Heuristic fallback ───────────────────────────── */

export const COMPETITORS = [
  "WordPress VIP",
  "Arc XP",
  "Brightspot",
  "Piano",
  "Taboola",
  "Outbrain",
  "Raptive",
  "Mediavine",
  "Ezoic",
  "Freestar",
  "Playwire",
  "Newspack",
  "Ghost",
  "Substack",
  "Beehiiv",
  "Automattic",
  "AdSense",
  "Setupad",
  "Venatus",
  "Admiral",
  "BlueConic",
  "Zephr",
  "Leaf Group",
  "Minute Media",
  "Arena Group",
];
const STACK = ["WordPress", "Drupal", "Arc XP", "Brightspot", "Ghost", "Substack", "Beehiiv", "Piano", "Google Ad Manager", "GAM", "Prebid", "AdSense", "Taboola", "Outbrain", "Mediavine", "Raptive", "Ezoic", "Newspack", "Webflow", "Squarespace"];

const ACTION = new RegExp(
  "\\b(I|we|I'm|we're)(?:'ll| will| shall| am going to| are going to|'m going to|'re going to| can| need to| should)\\s+(?:also\\s+|then\\s+|definitely\\s+)?(send|get|follow up|share|circle back|review|confirm|provide|prepare|sign|schedule|loop|check|forward|introduce|update|set up|draft|put together|talk to|run|finalize|book|intro|look into|come back)\\b",
  "i",
);
const NEXT_STEP = /\b(action item|next steps?|to-?do|let'?s (schedule|set up|book|plan)|can you (send|share|get|confirm|introduce))\b/i;
const DECISION = /\b(we (agreed|decided)|agreed (to|that)|decision is|let'?s go (with|ahead)|sounds like a plan|we'?re (moving|going) forward|green ?light)\b/i;
const OBJECTION_PATTERNS: { re: RegExp; rebuttal: string }[] = [
  { re: /\b(too expensive|cost(s)? too much|can'?t afford|no budget|budget)\b/i, rebuttal: "RTB is revenue-share: no upfront platform cost; walk through the pro forma showing net uplift vs. today." },
  { re: /\b(lose|losing|give up) (control|ownership)|editorial (control|independence)\b/i, rebuttal: "Publishers keep full editorial control and ownership of their brand, domain and audience." },
  { re: /\b(migration|migrate|move (our|the) (site|archive))\b.*\b(risk|hard|painful|worried|concern)|\b(risk|hard|painful|worried|concern)\b.*\b(migrat\w*)\b/i, rebuttal: "RTB's onboarding team builds a clone first and migrates content before cut-over; SEO redirects are preserved." },
  { re: /\b(already (use|have|work with)|locked in|under contract|existing (vendor|contract|partner))\b/i, rebuttal: "Compare total net revenue including platform fees; offer a phased start once the current term allows." },
  { re: /\b(guarantee|minimum|downside)\b/i, rebuttal: "Discuss guarantee options per the approved deal desk terms; don't commit numbers without approval." },
  { re: /\b(not sure|skeptical|prove|proof|case stud(y|ies))\b/i, rebuttal: "Share approved case studies and references from comparable publishers (approved claims only)." },
  { re: /\b(timing|not now|next (quarter|year)|too busy|bandwidth)\b/i, rebuttal: "Propose a low-effort discovery step now and align the migration window with their calendar." },
];
const RISK_PATTERNS: { flag: string; re: RegExp }[] = [
  { flag: "Budget constraint", re: /\b(no budget|budget (freeze|cuts?|constraints?))\b/i },
  { flag: "Timeline slipping", re: /\b(delay\w*|push(ed)? (back|out)|postpone\w*|on hold)\b/i },
  { flag: "Competing vendor in evaluation", re: /\b(also (talking|speaking) (to|with)|evaluating (other|another)|rfp|other (options|vendors))\b/i },
  { flag: "Decision maker not engaged", re: /\b(need to (run it by|check with|get approval)|board (needs to|has to)|not my (call|decision))\b/i },
  { flag: "Legal/NDA pending", re: /\b(legal (review|team)|nda (first|pending|before))\b/i },
];
const PAIN = /\b(pain|struggl\w*|problem|frustrat\w*|costly|expensive|slow|declin\w*|drop(ped|ping)?|losing|churn|hard to)\b/i;
const TIMELINE = /\b(by (q[1-4]|the end of (the )?(year|quarter|month)|january|february|march|april|may|june|july|august|september|october|november|december)|next (quarter|month|year)|in \d+ (weeks|months)|end of (the )?(year|quarter)|this (quarter|year))\b/i;
const REV_SHARE = /\b(rev(enue)?[- ]share|split|guarantee|percentage|70\/30|80\/20|60\/40)\b/i;
const DECISION_MAKER = /\b(ceo|founder|co-?founder|publisher|owner|cro|cfo|coo|president|board|editor[- ]in[- ]chief|gm|general manager)\b[^.]{0,40}\b(decide|decision|sign|approve|call|final say)\b|\b(decide|decision|sign off|approve)\b[^.]{0,40}\b(ceo|founder|publisher|owner|cro|cfo|board)\b/i;
const MUU = /(\d+(?:[.,]\d+)?\s*(?:k|m|million|thousand|mm)?)\+?\s*(?:monthly\s+)?(?:unique\s+(?:users|visitors)|uniques|muu|monthly (?:users|visitors|readers)|mau)\b/i;

function speakerSide(speaker: string | null, ourNames: string[]): "us" | "them" | null {
  if (!speaker) return null;
  const s = speaker.toLowerCase();
  if (ourNames.some((n) => n && (s === n.toLowerCase() || s.split(/\s+/)[0] === n.toLowerCase().split(/\s+/)[0]))) return "us";
  return "them";
}

function parseMuu(raw: string): number | null {
  const s = raw.toLowerCase().replace(/\s+/g, "").replace(/million|mm/, "m").replace(/thousand/, "k").replace(/,(?=\d{3}\b)/g, "");
  return parseAudience(s);
}

export function heuristicTranscriptAnalysis(text: string, ctx: TranscriptContext): TranscriptAnalysis {
  const utterances: Utterance[] = parsePlainText(text);
  const units = utterances.flatMap((u) => splitSentences(u.text).map((s) => ({ u, s })));
  const all = units.map((x) => x.s).join(" ");

  const action_items: ActionItem[] = [];
  for (const { u, s } of units) {
    if (!(ACTION.test(s) || NEXT_STEP.test(s))) continue;
    if (s.split(/\s+/).length < 4) continue;
    const side = speakerSide(u.speaker, ctx.ourNames);
    const first = /^(i|we|i'm|we're|i'll|we'll)\b/i.test(s) || ACTION.test(s);
    const owner = first ? (side ?? u.speaker ?? "us") : side === "us" ? "them" : side === "them" ? "us" : "us";
    if (action_items.some((a) => a.evidence === s)) continue;
    action_items.push({
      id: `a${action_items.length + 1}`,
      owner,
      task: s.replace(/^(so|okay|ok|great|yeah|and|alright)[, ]+/i, "").slice(0, 200),
      due: parseDue(s, ctx.occurredAt)?.date.toISOString() ?? null,
      evidence: s.slice(0, 500),
      timestamp: u.ts,
    });
    if (action_items.length >= 12) break;
  }

  const objections: TranscriptAnalysis["objections"] = [];
  units.forEach(({ u, s }, i) => {
    if (speakerSide(u.speaker, ctx.ourNames) === "us") return;
    const hit = OBJECTION_PATTERNS.find((o) => o.re.test(s));
    if (!hit || objections.length >= 6 || objections.some((o) => o.objection === s)) return;
    const reply = units.slice(i + 1).find((x) => x.u !== u && x.u.speaker !== u.speaker);
    objections.push({ objection: s.slice(0, 300), response_given: reply?.s.slice(0, 300) ?? "", recommended_rebuttal: hit.rebuttal });
  });

  const competitors = COMPETITORS.filter((c) => new RegExp(`\\b${c.replace(/\s+/g, "\\s+")}\\b`, "i").test(all));
  const current_stack = STACK.filter((c) => new RegExp(`\\b${c.replace(/\s+/g, "\\s+")}\\b`, "i").test(all));
  const muuMatch = all.match(MUU);
  const muu = muuMatch ? parseMuu(muuMatch[1]!) : null;
  const muuEvidence = muuMatch ? (units.find((x) => x.s.includes(muuMatch[0]))?.s ?? muuMatch[0]) : "";
  const ndaSentence = units.find((x) => /\bnda\b/i.test(x.s))?.s ?? null;
  const complexityHits = (all.match(/\b(custom|legacy|integration|paywall|archive|subscriptions?|membership|plugins?|multiple sites|app)\b/gi) ?? []).length;

  const decisions = units.filter((x) => DECISION.test(x.s)).map((x) => x.s.slice(0, 300)).slice(0, 6);
  const risks = RISK_PATTERNS.filter((r) => r.re.test(all)).map((r) => r.flag);
  const informative = units.map((x) => x.s).filter((s) => s.split(/\s+/).length >= 8);
  const keyed = informative.filter((s) => /\b(muu|traffic|revenue|migrat|platform|contract|nda|pricing|timeline|decision|next step)/i.test(s));
  const summary = [...new Set([...keyed, ...informative])].slice(0, 5).map((s) => s.slice(0, 240));

  const nextStepItem = action_items.find((a) => a.owner === "us") ?? action_items[0];
  const field_updates: FieldUpdate[] = [];
  if (muu) field_updates.push({ field: "muu", value: String(muu), evidence: muuEvidence.slice(0, 500) });
  if (nextStepItem) field_updates.push({ field: "next_step", value: nextStepItem.task.slice(0, 200), evidence: nextStepItem.evidence });

  let suggested: TranscriptAnalysis["suggested_stage"] = { stage: null, confidence: 0, reason: "No clear stage signal in the call." };
  if (/\b(send|sending|share) (over )?(the |a )?(contract|agreement|io)\b/i.test(all)) suggested = { stage: "Contract", confidence: 0.5, reason: "Contract discussed as next step." };
  else if (/\b(proposal|pro ?forma|pricing)\b/i.test(all) && /\b(send|share|prepare)\b/i.test(all)) suggested = { stage: "Proposal", confidence: 0.45, reason: "Proposal/pricing requested." };
  else if (/\bdemo\b/i.test(all)) suggested = { stage: "Demo", confidence: 0.4, reason: "Demo discussed." };
  if (suggested.stage && ctx.stageNames?.length) suggested = { ...suggested, stage: matchStageName(suggested.stage, ctx.stageNames) };

  const qualification: TranscriptAnalysis["qualification"] = {
    muu_confirmed: muu,
    decision_maker: units.find((x) => DECISION_MAKER.test(x.s))?.s.slice(0, 200) ?? null,
    current_stack,
    pain: units.filter((x) => speakerSide(x.u.speaker, ctx.ourNames) !== "us" && PAIN.test(x.s)).map((x) => x.s.slice(0, 200)).slice(0, 4),
    timeline: all.match(TIMELINE)?.[0] ?? null,
    rev_share_appetite: units.find((x) => REV_SHARE.test(x.s))?.s.slice(0, 200) ?? null,
    nda_status: ndaSentence ? (/\bsigned\b/i.test(ndaSentence) ? "signed" : /\bsend|request|need\b/i.test(ndaSentence) ? "requested" : "discussed") : null,
    migration_complexity: complexityHits === 0 ? null : complexityHits <= 2 ? "low" : complexityHits <= 5 ? "med" : "high",
  };

  return {
    summary: summary.length ? summary : ["Transcript too short to summarize automatically."],
    decisions,
    action_items,
    objections,
    qualification,
    competitors,
    risks,
    sentiment: heuristicSentiment(all),
    suggested_stage: suggested,
    field_updates,
    follow_up_email_draft: followUpDraft(ctx, summary, action_items),
    engine: "heuristic",
  };
}

export function followUpDraft(ctx: TranscriptContext, summary: string[], items: ActionItem[]): TranscriptAnalysis["follow_up_email_draft"] {
  const first = ctx.ownerName.split(/\s+/)[0] ?? ctx.ownerName;
  const ours = items.filter((a) => a.owner === "us" || ctx.ourNames.some((n) => n && a.owner.toLowerCase().includes(n.toLowerCase().split(" ")[0]!)));
  const theirs = items.filter((a) => !ours.includes(a));
  const lines = [
    "Hi {{first_name}},",
    "",
    `Thanks for the time today${ctx.accountName ? ` — great to learn more about ${ctx.accountName}` : ""}. A quick recap:`,
    "",
    ...summary.slice(0, 3).map((s) => `• ${s}`),
  ];
  if (ours.length) lines.push("", "On our side:", ...ours.slice(0, 5).map((a) => `• ${a.task}`));
  if (theirs.length) lines.push("", "On your side:", ...theirs.slice(0, 5).map((a) => `• ${a.task}`));
  lines.push("", "Let me know if I missed anything.", "", "Best,", first);
  return { subject: `Recap: ${ctx.title ?? "our call"}`.slice(0, 150), body: lines.join("\n"), claims_check: "unchecked" };
}

export function transcriptAnalysisPrompt(ctx: TranscriptContext, wrapped: string): string {
  return [
    `Analyze this sales call transcript for ${ctx.ownerName} at RTB Digital. RTB-side participants ("us"): ${ctx.ourNames.join(", ") || ctx.ownerName}.`,
    `Call date: ${ctx.occurredAt.toISOString()}. Title: ${ctx.title ?? "(none)"}.${ctx.accountName ? ` Prospect account: ${ctx.accountName}.` : ""}`,
    "Return exactly 5 summary bullets, decisions, action items with owners (us/them/name), due dates resolved relative to the call date,",
    "verbatim evidence quotes and [hh:mm:ss] timestamps when present. Only propose field_updates for: muu (integer), next_step, expected_close_date (ISO).",
    "Draft a short follow-up email in the rep's voice using only facts from the call; never state unverified performance multiples or unaudited figures.",
    ctx.stageNames?.length
      ? `suggested_stage.stage must be exactly one of: ${ctx.stageNames.map((n) => `"${n}"`).join(", ")} — or null if the call doesn't justify a move.`
      : "No deal is attached: leave suggested_stage.stage null unless a generic stage (e.g. Demo, Contract) is clearly implied.",
    wrapped,
  ].join("\n");
}
