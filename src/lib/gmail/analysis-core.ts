/**
 * Email analysis (PRD EML-5, Appendix D "Email analysis"): zod schema for the AI call + deterministic heuristic
 * fallback. Pure and unit-tested with fixtures.
 */
import { z } from "zod";
import { parseDue, parseIsoDue } from "@/lib/integrations/due-date";
import { matchStageName } from "@/lib/integrations/matching-core";

export const EMAIL_INTENTS = ["interested", "objection", "scheduling", "legal", "pricing", "not_interested", "ooo", "referral", "other"] as const;
export type EmailIntent = (typeof EMAIL_INTENTS)[number];
export const PROGRESS_TYPES = ["nda_signed", "demo_requested", "legal_review", "pricing_requested", "contract_sent", "other"] as const;

/** Schema sent to the model. Keep it flat and nullable (no optional) for broad structured-output support. */
export const emailAnalysisAiSchema = z.object({
  intent: z.enum(EMAIL_INTENTS),
  awaiting_reply_from: z.enum(["us", "them", "none"]),
  commitments: z
    .array(
      z.object({
        by: z.enum(["us", "them"]),
        person: z.string().describe("Name or email of the person who committed"),
        text: z.string().describe("The commitment, rephrased as a short task"),
        due: z.string().nullable().describe("ISO-8601 date if stated or clearly implied, else null"),
        evidence: z.string().describe("Exact quote from the email"),
      }),
    )
    .describe("Promises to do something. 'us' = RTB side (the mailbox owner's company), 'them' = the external party."),
  progress_signals: z.array(z.object({ type: z.enum(PROGRESS_TYPES), evidence: z.string() })),
  suggested_stage: z.object({ stage: z.string().nullable(), confidence: z.number(), reason: z.string() }),
  sentiment: z.number().describe("-1 (very negative) to 1 (very positive)"),
  risk_flags: z.array(z.string()),
});
export type EmailAnalysisAi = z.infer<typeof emailAnalysisAiSchema>;

export type Commitment = {
  by: "us" | "them";
  person: string;
  text: string;
  due: string | null; // ISO
  evidence: string;
};
export type EmailAnalysis = {
  intent: EmailIntent;
  awaiting_reply_from: "us" | "them" | "none";
  commitments: Commitment[];
  progress_signals: { type: (typeof PROGRESS_TYPES)[number]; evidence: string }[];
  suggested_stage: { stage: string | null; confidence: number; reason: string };
  sentiment: number;
  risk_flags: string[];
  engine: string; // ai:<model> | heuristic
};

export type EmailAnalysisInput = {
  text: string; // new text only (quoted history stripped)
  subject: string | null;
  direction: "inbound" | "outbound";
  fromName: string | null;
  fromEmail: string | null;
  sentAt: Date;
  /** Stage names of the linked deal's pipeline; suggestions are mapped onto these. */
  stageNames?: string[];
};

const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0);

/** Normalize and sanity-check AI output: clamp numbers, resolve due dates, require evidence to exist in the text. */
export function normalizeAiEmailAnalysis(ai: EmailAnalysisAi, input: EmailAnalysisInput, model: string): EmailAnalysis {
  const lower = input.text.toLowerCase();
  const grounded = (q: string) => {
    const t = q.trim().toLowerCase().slice(0, 60);
    return t.length > 0 && lower.includes(t.slice(0, Math.min(40, t.length)));
  };
  return {
    intent: ai.intent,
    awaiting_reply_from: ai.awaiting_reply_from,
    commitments: ai.commitments
      .filter((c) => c.text.trim() && grounded(c.evidence))
      .slice(0, 10)
      .map((c) => ({
        by: c.by,
        person: c.person.slice(0, 120),
        text: c.text.slice(0, 300),
        due: (parseIsoDue(c.due, input.sentAt) ?? parseDue(c.evidence, input.sentAt)?.date ?? null)?.toISOString() ?? null,
        evidence: c.evidence.slice(0, 500),
      })),
    progress_signals: ai.progress_signals.filter((p) => grounded(p.evidence) && !(p.type === "nda_signed" && FUTURE.test(p.evidence))).slice(0, 10),
    suggested_stage: {
      stage: input.stageNames?.length ? matchStageName(ai.suggested_stage.stage, input.stageNames) : ai.suggested_stage.stage,
      confidence: clamp(ai.suggested_stage.confidence, 0, 1),
      reason: ai.suggested_stage.reason.slice(0, 500),
    },
    sentiment: clamp(ai.sentiment, -1, 1),
    risk_flags: ai.risk_flags.slice(0, 10).map((r) => r.slice(0, 200)),
    engine: `ai:${model}`,
  };
}

/* ───────────────────────────── Heuristic fallback ───────────────────────────── */

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])|\s*[\n•]\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

const OOO = /\b(out of (the )?office|ooo|on (vacation|holiday|leave|annual leave|pto)|automatic reply|auto-?reply|away from (my )?(desk|email)|limited access to email)\b/i;
const NOT_INTERESTED = /\b(not interested|no longer interested|not a fit|not the right fit|we('ll| will) pass|pass on this|unsubscribe|remove me|please stop|not at this time|no thanks)\b/i;
const LEGAL = /\b(contract|nda|mutual non-?disclosure|redline[sd]?|legal (team|review)|msa|master services|terms and conditions|countersign(ed)?|docusign|signature)\b/i;
const PRICING = /\b(pricing|price|prices|rev(enue)?[- ]share|cost|costs|quote|rate card|cpm|fees?|guarantee[sd]?|budget)\b/i;
const SCHEDULING = /\b(schedule|reschedul\w*|calendar|availability|available|time works|does .{0,20}work for you|zoom link|meet link|invite|book a (call|time|meeting)|let'?s (meet|chat|talk))\b/i;
const OBJECTION = /\b(concern(ed|s)?|worried|hesitant|too expensive|not sure|skeptical|however|unfortunately|push back|risk|locked in|already (use|have|work with))\b/i;
const INTERESTED = /\b(interested|sounds (great|good)|love to|keen|excited|let'?s do it|happy to (move|proceed)|move forward|makes sense|looks good)\b/i;
const REFERRAL = /\b(loop(ing)? in|cc'?(ing|ed)|introduc(e|ing)|best person|right person|reach out to|connect you with)\b/i;

const COMMIT_VERBS =
  "send|get back|follow up|share|circle back|review|confirm|provide|prepare|sign|countersign|schedule|loop|check|revert|forward|introduce|reply|respond|update|set up|draft|put together|come back|discuss|talk to|speak (?:to|with)|run (?:it|this) by|finalize|deliver|book";
const FIRST_PERSON_COMMIT = new RegExp(
  `\\b(I|we)(?:'ll| will| shall| am going to| are going to|'m going to|'re going to| plan to| intend to| can| aim to| expect to| hope to)\\s+(?:be able to\\s+)?(?:also\\s+|then\\s+|definitely\\s+|try to\\s+)?(${COMMIT_VERBS})\\b`,
  "i",
);
const WILL_GET_BACK = /\b(will|'ll)\s+(get back to you|come back to you|revert|circle back)\b/i;
const REQUEST_US = new RegExp(`\\b(can|could|would) you (please )?(${COMMIT_VERBS})\\b`, "i");

const SIGNALS: { type: (typeof PROGRESS_TYPES)[number]; re: RegExp }[] = [
  { type: "nda_signed", re: /\b(signed|countersigned|executed) (the )?(mutual )?nda\b|\bnda (is |has been )?(signed|executed|countersigned)\b/i },
  { type: "contract_sent", re: /\b(attached|attaching|sending( over)?|sent( over)?|here is|here's) (is )?(the |our )?(contract|agreement|msa|order form|io)\b|\b(contract|agreement) (is )?attached\b/i },
  { type: "legal_review", re: /\b(legal (team )?(is |will be )?review\w*|sent (it )?to (our )?legal|with (our )?legal|legal review|redlines?)\b/i },
  { type: "demo_requested", re: /\b(demo|walk ?through|show us|see (the|a) (platform|product))\b/i },
  { type: "pricing_requested", re: /\b(send (over )?(the |your |a )?(pricing|quote|proposal|rate card|terms)|what (would|does) (it|this) cost|how much|pricing (details|info))\b/i },
];

const FUTURE = /\b(will|'ll|going to|plan to|shall|once)\b/i;

const RISK_PATTERNS: { flag: string; re: RegExp }[] = [
  { flag: "Budget constraint", re: /\b(no budget|budget (freeze|cuts?|constraints?)|tight budget)\b/i },
  { flag: "Timeline slipping", re: /\b(delay(ed)?|push(ed)? (back|out)|postpone\w*|on hold|next (quarter|year))\b/i },
  { flag: "Competing vendor", re: /\b(competitor|another vendor|other (options|vendors|partners)|already (use|have|work with)|rfp)\b/i },
  { flag: "Stakeholder change", re: /\b(left the company|leaving|new role|reorg\w*|restructur\w*|no longer (with|at))\b/i },
  { flag: "Low priority", re: /\b(not a priority|low priority|revisit (later|in)|circle back (later|next))\b/i },
];

const POSITIVE = /\b(great|thanks|thank you|excited|love|perfect|happy|glad|awesome|excellent|appreciate|interested|looking forward)\b/gi;
const NEGATIVE = /\b(unfortunately|concern\w*|worried|disappoint\w*|problem|issue|delay\w*|not interested|frustrat\w*|cancel\w*|decline\w*|sorry)\b/gi;

export function heuristicSentiment(text: string): number {
  const pos = text.match(POSITIVE)?.length ?? 0;
  const neg = text.match(NEGATIVE)?.length ?? 0;
  if (pos + neg === 0) return 0;
  return Math.round(((pos - neg) / (pos + neg)) * 100) / 100;
}

function classifyIntent(text: string, subject: string): EmailIntent {
  const t = `${subject}\n${text}`;
  if (OOO.test(t)) return "ooo";
  if (NOT_INTERESTED.test(text)) return "not_interested";
  if (LEGAL.test(t)) return "legal";
  if (PRICING.test(text)) return "pricing";
  if (SCHEDULING.test(text)) return "scheduling";
  if (REFERRAL.test(text)) return "referral";
  if (OBJECTION.test(text)) return "objection";
  if (INTERESTED.test(text)) return "interested";
  return "other";
}

/** Short task text from a commitment sentence: trims greetings and trailing sign-offs. */
export function commitmentTask(sentence: string): string {
  return sentence
    .replace(/^(hi|hello|hey|thanks|thank you)[^,.!]*[,.!]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function extractCommitments(input: EmailAnalysisInput): Commitment[] {
  const out: Commitment[] = [];
  const sender = input.fromName ?? input.fromEmail ?? (input.direction === "outbound" ? "Us" : "Them");
  const senderSide: "us" | "them" = input.direction === "outbound" ? "us" : "them";
  for (const s of splitSentences(input.text)) {
    let by: "us" | "them" | null = null;
    if (FIRST_PERSON_COMMIT.test(s) || WILL_GET_BACK.test(s)) by = senderSide;
    else if (REQUEST_US.test(s)) by = senderSide === "us" ? "them" : "us"; // "Could you send…?" → the recipient owes it
    if (!by) continue;
    if (/\b(if|unless|whether)\b/i.test(s.split(/\b(I|we)\b/i)[0] ?? "")) continue; // conditional preamble
    const due = parseDue(s, input.sentAt);
    out.push({
      by,
      person: by === senderSide ? sender : input.direction === "outbound" ? "Them" : "Us",
      text: commitmentTask(s),
      due: due?.date.toISOString() ?? null,
      evidence: s.slice(0, 500),
    });
    if (out.length >= 8) break;
  }
  return out;
}

const STAGE_FOR_SIGNAL: Record<string, { stage: string; confidence: number }> = {
  nda_signed: { stage: "NDA signed", confidence: 0.6 },
  contract_sent: { stage: "Contract", confidence: 0.55 },
  legal_review: { stage: "Contract", confidence: 0.5 },
  demo_requested: { stage: "Demo", confidence: 0.45 },
  pricing_requested: { stage: "Proposal", confidence: 0.4 },
};

export function heuristicEmailAnalysis(input: EmailAnalysisInput): EmailAnalysis {
  const text = input.text;
  const intent = classifyIntent(text, input.subject ?? "");
  const sentences = splitSentences(text);
  const progress_signals: EmailAnalysis["progress_signals"] = [];
  for (const sig of SIGNALS) {
    // "I'll send the signed NDA" is a promise, not a signed NDA.
    const s = sentences.find((x) => sig.re.test(x) && !(sig.type === "nda_signed" && FUTURE.test(x)));
    if (s) progress_signals.push({ type: sig.type, evidence: s.slice(0, 300) });
  }
  const risk_flags = RISK_PATTERNS.filter((r) => r.re.test(text)).map((r) => r.flag);
  if (intent === "not_interested") risk_flags.unshift("Prospect signalled no interest");
  const top = progress_signals.map((p) => ({ p, s: STAGE_FOR_SIGNAL[p.type] })).find((x) => x.s);
  const commitments = intent === "ooo" ? [] : extractCommitments(input);
  const awaiting: EmailAnalysis["awaiting_reply_from"] =
    input.direction === "outbound" ? "them" : intent === "ooo" || intent === "not_interested" ? "none" : "us";
  return {
    intent,
    awaiting_reply_from: awaiting,
    commitments,
    progress_signals,
    suggested_stage: top
      ? {
          stage: input.stageNames?.length ? matchStageName(top.s!.stage, input.stageNames) : top.s!.stage,
          confidence: top.s!.confidence,
          reason: `Signal: ${top.p.type.replace(/_/g, " ")} — "${top.p.evidence.slice(0, 120)}"`,
        }
      : { stage: null, confidence: 0, reason: "No stage-changing signal found." },
    sentiment: heuristicSentiment(text),
    risk_flags,
    engine: "heuristic",
  };
}

/** Prompt for the AI call; email content is wrapped by the caller with untrusted(). */
export function emailAnalysisPrompt(input: EmailAnalysisInput, wrappedBody: string, ownerName: string): string {
  return [
    `Analyze this ${input.direction === "outbound" ? "OUTBOUND email sent by" : "INBOUND email received by"} ${ownerName} (RTB side = "us").`,
    `Sent at: ${input.sentAt.toISOString()}. From: ${input.fromName ?? ""} <${input.fromEmail ?? ""}>. Subject: ${input.subject ?? "(none)"}.`,
    "Extract intent, who owes the next reply, explicit commitments (with exact quotes and due dates resolved relative to the sent date),",
    "deal progress signals, a stage suggestion only if clearly supported, sentiment and risk flags. Quotes must be copied verbatim.",
    input.stageNames?.length
      ? `suggested_stage.stage must be exactly one of: ${input.stageNames.map((n) => `"${n}"`).join(", ")} — or null.`
      : "No deal is linked: leave suggested_stage.stage null unless a generic stage (e.g. Demo, Contract) is clearly implied.",
    wrappedBody,
  ].join("\n");
}
