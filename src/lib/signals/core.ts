/**
 * Deal signals (docs/V2_SPEC.md §A4) — pure detection logic, unit-tested.
 *
 * Signals come from analyzed inbound emails and call transcripts linked to a deal:
 *   advance    "send over the contract", "looping in legal", "let's sign"           → next stage
 *   close_date "next quarter", "after the holidays", "push it to March"             → expected close date
 *   stall      "not a priority right now", "putting this on hold"                   → hold stage
 *   risk       "budget freeze", "evaluating other vendors", "our CEO left"         → follow-up task
 *   won / lost "contract is fully executed" / "we went with another vendor"          → won / lost stage
 *
 * Two engines feed the same candidate shape: a deterministic phrase library (always runs) and the AI analysis that
 * already ran on the email/transcript (its stage suggestion + grounded progress signals). Nothing here moves a deal:
 * signals are stored as `pending` and applied only by a human click through the gated stage-move service.
 */
import { splitSentences } from "@/lib/gmail/analysis-core";
import { matchStageName } from "@/lib/integrations/matching-core";
import { parsePlainText } from "@/lib/transcripts/parse";

export const SIGNAL_KINDS = ["advance", "close_date", "stall", "risk", "won", "lost"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export type StageLite = { id: string; name: string; category: "open" | "won" | "lost" | "hold"; sortOrder: number };

export type SignalContext = {
  stages: StageLite[];
  currentStageId: string;
  /** Message / call time — relative dates ("next quarter") resolve against it. */
  ref: Date;
  expectedCloseDate: Date | null;
};

export type SignalCandidate = {
  kind: SignalKind;
  quote: string | null;
  rationale: string;
  confidence: number; // 0..1
  engine: string; // "heuristic" | "ai:<model>"
  suggestedStageId: string | null;
  suggestedCloseDate: Date | null;
};

/** Below this we don't bother the rep. */
export const MIN_CONFIDENCE = 0.5;

/* ───────────────────────────── Phrase library ───────────────────────────── */

type StageHint = "contract" | "nda" | "proposal" | "demo" | "next";
type Phrase = { kind: SignalKind; re: RegExp; confidence: number; label: string; hint?: StageHint };

const DOC = "(?:contract|agreement|msa|order form|paperwork|io|insertion order|docusign|term sheet)";
const VENDOR = "(?:vendor|partner|provider|platform|solution|company|option|direction)";

export const PHRASES: Phrase[] = [
  // won — must be a completed fact, not a promise (see FUTURE guard)
  { kind: "won", re: new RegExp(`\\b(signed|countersigned|executed)\\s+(the\\s+|our\\s+)?${DOC}\\b`, "i"), confidence: 0.75, label: "Contract signed" },
  { kind: "won", re: new RegExp(`\\b${DOC}\\s+(is\\s+|has been\\s+|was\\s+)?(now\\s+)?(fully\\s+)?(signed|executed|countersigned)\\b`, "i"), confidence: 0.75, label: "Contract signed" },
  { kind: "won", re: /\bfully executed\b|\bpo (has been |was )?(issued|approved)\b|\bwe'?re officially (live|partners)\b/i, confidence: 0.7, label: "Deal closed" },
  // lost
  {
    kind: "lost",
    re: new RegExp(`\\b(went|are going|decided to go|have decided to go|chose|have chosen|selected|signed) (with )?(another|a different|an?other|a competing) ${VENDOR}\\b`, "i"),
    confidence: 0.7,
    label: "Chose another vendor",
  },
  {
    kind: "lost",
    re: /\b(not (going to )?(move|moving) forward|decided not to (proceed|move forward|pursue|go ahead)|won'?t be (moving forward|proceeding)|we('ll| will) (have to )?pass|pass on this|no longer interested|not interested (in|at)|decided against)\b/i,
    confidence: 0.65,
    label: "Declined",
  },
  // stall
  {
    kind: "stall",
    re: /\b(not a (top |high )?priority|low(er)? (on the )?priority|deprioriti[sz]ed|on hold|put (this|it|things|everything) on (hold|ice|pause|the back burner)|pause (this|things|the conversation)|no bandwidth|(too|very) (busy|stretched)|revisit (this |it )?(later|in|next))\b/i,
    confidence: 0.6,
    label: "Deal stalling",
  },
  // risk
  { kind: "risk", re: /\b(budget (freeze|cuts?|is frozen|has been cut)|no budget|frozen budget|(hiring|spending) freeze|cost[- ]cutting)\b/i, confidence: 0.65, label: "Budget risk" },
  {
    kind: "risk",
    re: /\b(evaluating|looking at|talking (to|with)|speaking (to|with)|considering) (other|another|a few|several|multiple) (vendors?|options|partners|providers|platforms)\b|\b(an? |the )?rfp\b/i,
    confidence: 0.55,
    label: "Competing vendors",
  },
  {
    kind: "risk",
    re: /\b(left the company|is leaving (the company|us)|no longer (with|at) (the company|us)|new (ceo|cfo|cro|leadership|management)|reorg(ani[sz]ation)?|restructuring|being acquired|layoffs?)\b/i,
    confidence: 0.55,
    label: "Stakeholder change",
  },
  // advance
  {
    kind: "advance",
    re: new RegExp(`\\b(send|sending|share|forward|draft|get)\\s+(me |us )?(over )?(the |your |a |an )?(final |draft )?${DOC}\\b`, "i"),
    confidence: 0.7,
    label: "Contract requested",
    hint: "contract",
  },
  {
    kind: "advance",
    re: /\b(loop(ing)? in|cc'?(ing|ed)|bring(ing)? in|looped in|(sent|sending|passed|passing) (it |this )?(over )?to) (our |my )?(legal|general counsel|gc|lawyers?|counsel|procurement)\b|\blegal (is|are) (reviewing|looking)\b/i,
    confidence: 0.65,
    label: "Legal involved",
    hint: "contract",
  },
  { kind: "advance", re: /\b(let'?s|ready to|happy to|want to|we can|we'?d like to|we'?ll|we will|we'?re going to|we plan to) (sign|get (this|it) signed|get (this|it) done|make it official)\b/i, confidence: 0.7, label: "Ready to sign", hint: "contract" },
  { kind: "advance", re: /\b(let'?s|ready to|happy to|we'?d like to|we want to|we'?re going to) (move forward|proceed|go ahead)\b|\bgreen ?light\b/i, confidence: 0.6, label: "Ready to proceed", hint: "next" },
  { kind: "advance", re: /\b(send|share|sending) (me |us )?(over )?(the |your |a |an )?(mutual )?nda\b|\bnda (is |has been )?signed\b/i, confidence: 0.6, label: "NDA", hint: "nda" },
  { kind: "advance", re: /\b(send|share|see) (me |us )?(over )?(the |your |a |an )?(proposal|pro ?forma|pricing|quote|terms|numbers)\b/i, confidence: 0.55, label: "Proposal requested", hint: "proposal" },
  { kind: "advance", re: /\b(set up|schedule|book|see) (a |the )?(demo|walk-?through|product tour)\b/i, confidence: 0.5, label: "Demo requested", hint: "demo" },
];

/** Promises / hypotheticals: "we'll sign once…", "if we decide not to proceed…", "have you signed…?" */
const FUTURE = /\b(will|'ll|going to|plan to|hope to|once|when we|after we)\b/i;
const CONDITIONAL = /\b(if|unless|whether|in case)\b/i;

/* ───────────────────────────── Close-date phrases ───────────────────────────── */

const TIMING_CUE =
  /\b(sign|signing|decision|decide|revisit|push|pushed|start|starting|launch|kick ?off|move forward|budget|timing|timeline|close|closing|contract|onboard\w*|migrat\w*|go live|circle back|pick (this|it) back up|reconnect|reconvene|regroup|look at (this|it) again|come back to)\b/i;

const QUARTER_END = (year: number, q: number) => new Date(Date.UTC(year, q * 3, 0, 17)); // q 1..4 → last day of quarter

/** Resolve a close-date expression in one sentence (pure). Returns null for vague / unrelated timing. */
export function resolveCloseDate(sentence: string, ref: Date): { date: Date; phrase: string } | null {
  if (!TIMING_CUE.test(sentence)) return null;
  const s = sentence.toLowerCase();
  const y = ref.getUTCFullYear();
  const curQ = Math.floor(ref.getUTCMonth() / 3) + 1;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/\bnext quarter\b/))) {
    const q = curQ === 4 ? 1 : curQ + 1;
    return { date: QUARTER_END(curQ === 4 ? y + 1 : y, q), phrase: m[0] };
  }
  if ((m = s.match(/\bafter (the )?(holidays|new year|christmas)\b/))) {
    // Only meaningful in Q4 (or very early Q1): mid-January.
    const month = ref.getUTCMonth();
    if (month >= 9) return { date: new Date(Date.UTC(y + 1, 0, 15, 17)), phrase: m[0] };
    if (month === 0) return { date: new Date(Date.UTC(y, 1, 1, 17)), phrase: m[0] };
    return null;
  }
  if ((m = s.match(/\b(early|beginning of|start of) next year\b/))) return { date: new Date(Date.UTC(y + 1, 1, 15, 17)), phrase: m[0] };
  if ((m = s.match(/\b(mid|middle of) next year\b/))) return { date: new Date(Date.UTC(y + 1, 5, 30, 17)), phrase: m[0] };
  if ((m = s.match(/\bnext year\b/))) return { date: QUARTER_END(y + 1, 1), phrase: m[0] };
  if ((m = s.match(/\b(end of (the |this )?year|year[- ]end|eoy)\b/))) {
    const d = new Date(Date.UTC(y, 11, 31, 17));
    return { date: d.getTime() < ref.getTime() + 7 * 86_400_000 ? new Date(Date.UTC(y + 1, 11, 31, 17)) : d, phrase: m[0] };
  }
  if ((m = s.match(/\b(?:in|by|until|till|for|to) q([1-4])(?:\s*(?:of\s*)?(?:'|20)?(\d{2}))?\b/))) {
    const q = Number(m[1]);
    let year = m[2] ? 2000 + Number(m[2]) : y;
    if (!m[2] && (q < curQ || (q === curQ && ref.getTime() > QUARTER_END(y, q).getTime() - 14 * 86_400_000))) year = y + 1;
    return { date: QUARTER_END(year, q), phrase: m[0] };
  }
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const monthRe = new RegExp(`\\b(?:push(?:ed)?(?: it| this| things| the \\w+)?(?: back| out)? (?:to|until|till)|(?:sign|signing|decision|decide|launch|start|kick ?off|go live|revisit|reconnect|close|closing)\\w*(?: \\w+){0,3} (?:in|by|until|till|for|around)|(?:not|nothing) (?:until|before|till)) (?:early |mid |late |the end of )?(${MONTHS.join("|")})\\b`);
  if ((m = s.match(monthRe))) {
    const idx = MONTHS.indexOf(m[1]!);
    let year = y;
    if (idx < ref.getUTCMonth() || (idx === ref.getUTCMonth() && ref.getUTCDate() > 20)) year = y + 1;
    return { date: new Date(Date.UTC(year, idx + 1, 0, 17)), phrase: m[0] };
  }
  return null;
}

/* ───────────────────────────── Stage resolution ───────────────────────────── */

/** Open stages that are "parking lots" rather than progress (cold / nurture / lapsed / renewal). */
const PARKING = /\b(cold|nurture|lapsed|dormant|renewal|archive)\b/i;
/** Ordered preferences per hint: the first regex that matches a forward stage wins ("Contract" before "Negotiation"). */
const HINT_RE: Record<Exclude<StageHint, "next">, RegExp[]> = {
  contract: [/contract/i, /legal|paper|sign|loi/i, /negotiat|closing|verbal/i],
  nda: [/\bnda\b/i],
  proposal: [/proposal|pro ?forma/i, /pricing|quote|terms/i],
  demo: [/demo/i, /beta|discovery|review/i],
};

function sorted(stages: StageLite[]) {
  return [...stages].sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Forward progress stages after the current one (open, not a parking-lot stage). */
export function forwardStages(ctx: SignalContext): StageLite[] {
  const cur = ctx.stages.find((s) => s.id === ctx.currentStageId);
  if (!cur || cur.category !== "open") {
    // On hold / won / lost: "advance" means back into the funnel — any open non-parking stage.
    return sorted(ctx.stages).filter((s) => s.category === "open" && !PARKING.test(s.name));
  }
  return sorted(ctx.stages).filter((s) => s.category === "open" && s.sortOrder > cur.sortOrder && !PARKING.test(s.name));
}

export function stageForHint(hint: StageHint, ctx: SignalContext): StageLite | null {
  const fwd = forwardStages(ctx);
  if (!fwd.length) return null;
  if (hint === "next") {
    // From hold/closed there is no meaningful "next" stage (it would be the top of the funnel) — only named targets.
    const cur = ctx.stages.find((s) => s.id === ctx.currentStageId);
    return cur?.category === "open" ? fwd[0]! : null;
  }
  for (const re of HINT_RE[hint]) {
    const hit = fwd.find((s) => re.test(s.name));
    if (hit) return hit;
  }
  return null;
}

export function stageForCategory(category: "won" | "lost" | "hold", ctx: SignalContext): StageLite | null {
  const cur = ctx.stages.find((s) => s.id === ctx.currentStageId);
  if (cur?.category === category) return null; // already there
  const list = sorted(ctx.stages);
  if (category === "hold") return list.find((s) => s.category === "hold") ?? list.find((s) => s.category === "open" && PARKING.test(s.name) && s.id !== ctx.currentStageId) ?? null;
  return list.find((s) => s.category === category) ?? null;
}

/* ───────────────────────────── Detection ───────────────────────────── */

const clip = (s: string, n = 280) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Phrase-library detection over plain text (one email body, or the prospect-side lines of a transcript).
 * At most one candidate per kind (highest confidence wins). Pure and deterministic.
 */
export function detectSignalsHeuristic(text: string, ctx: SignalContext): SignalCandidate[] {
  const out: SignalCandidate[] = [];
  const cur = ctx.stages.find((s) => s.id === ctx.currentStageId);
  for (const sentence of splitSentences(text).slice(0, 400)) {
    if (sentence.length < 6 || sentence.length > 600) continue;
    const question = /\?\s*$/.test(sentence);
    for (const p of PHRASES) {
      if (!p.re.test(sentence)) continue;
      const conditional = CONDITIONAL.test(sentence.split(p.re)[0] ?? "");
      if (conditional) continue;
      if ((p.kind === "won" || p.kind === "lost") && (question || FUTURE.test(sentence))) {
        // "we'll sign the contract next week" → that's an advance, not a win
        if (p.kind === "won" && FUTURE.test(sentence) && !question) {
          const st = stageForHint("contract", ctx) ?? stageForHint("next", ctx);
          if (st) push(out, { kind: "advance", quote: clip(sentence), rationale: "Signature coming — move toward contract.", confidence: 0.6, engine: "heuristic", suggestedStageId: st.id, suggestedCloseDate: null });
        }
        continue;
      }
      if (p.kind === "advance") {
        if (question && p.hint !== "proposal" && p.hint !== "contract") continue;
        const st = stageForHint(p.hint ?? "next", ctx);
        if (!st) continue; // already at/after that stage
        push(out, { kind: "advance", quote: clip(sentence), rationale: `${p.label} — suggests moving to ${st.name}.`, confidence: p.confidence, engine: "heuristic", suggestedStageId: st.id, suggestedCloseDate: null });
      } else if (p.kind === "won" || p.kind === "lost") {
        const st = stageForCategory(p.kind, ctx);
        if (!st) continue;
        push(out, { kind: p.kind, quote: clip(sentence), rationale: `${p.label} — mark the deal ${p.kind === "won" ? "won" : "lost"}?`, confidence: p.confidence, engine: "heuristic", suggestedStageId: st.id, suggestedCloseDate: null });
      } else if (p.kind === "stall") {
        if (cur?.category === "hold") continue;
        const st = stageForCategory("hold", ctx);
        push(out, { kind: "stall", quote: clip(sentence), rationale: st ? `${p.label} — park it in ${st.name}?` : `${p.label} — plan a re-engagement.`, confidence: p.confidence, engine: "heuristic", suggestedStageId: st?.id ?? null, suggestedCloseDate: null });
      } else if (p.kind === "risk") {
        push(out, { kind: "risk", quote: clip(sentence), rationale: `${p.label} — address it before it stalls the deal.`, confidence: p.confidence, engine: "heuristic", suggestedStageId: null, suggestedCloseDate: null });
      }
    }
    if (!question) {
      const cd = resolveCloseDate(sentence, ctx.ref);
      if (cd && closeDateMoves(cd.date, ctx.expectedCloseDate)) {
        push(out, {
          kind: "close_date",
          quote: clip(sentence),
          rationale: `Timing: “${cd.phrase}” — update the expected close date.`,
          confidence: 0.55,
          engine: "heuristic",
          suggestedStageId: null,
          suggestedCloseDate: cd.date,
        });
      }
    }
  }
  return reconcile(out);
}

/** A close-date signal is worth showing only when it moves the date by more than two weeks (or there is none). */
export function closeDateMoves(next: Date, current: Date | null): boolean {
  if (!current) return true;
  return Math.abs(next.getTime() - current.getTime()) > 14 * 86_400_000;
}

function push(out: SignalCandidate[], c: SignalCandidate) {
  const i = out.findIndex((x) => x.kind === c.kind);
  if (i === -1) out.push(c);
  else if (c.confidence > out[i]!.confidence) out[i] = c;
}

/** One candidate per kind; contradictory pairs resolved (a win/loss trumps "advance"; lost trumps stall). */
export function reconcile(list: SignalCandidate[]): SignalCandidate[] {
  const byKind = new Map<SignalKind, SignalCandidate>();
  for (const c of list) {
    if (c.confidence < MIN_CONFIDENCE) continue;
    const prev = byKind.get(c.kind);
    if (!prev || c.confidence > prev.confidence || (c.confidence === prev.confidence && prev.engine === "heuristic" && c.engine !== "heuristic")) byKind.set(c.kind, c);
  }
  if (byKind.has("won") || byKind.has("lost")) byKind.delete("advance");
  if (byKind.has("won") && byKind.has("lost")) {
    // contradictory: keep the stronger one only
    const w = byKind.get("won")!;
    const l = byKind.get("lost")!;
    byKind.delete(w.confidence >= l.confidence ? "lost" : "won");
  }
  if (byKind.has("lost")) byKind.delete("stall");
  if (byKind.has("won")) {
    byKind.delete("stall");
    byKind.delete("risk");
  }
  return SIGNAL_KINDS.map((k) => byKind.get(k)).filter((x): x is SignalCandidate => Boolean(x));
}

/* ───────────────────────────── AI-analysis adapters ───────────────────────────── */

type SuggestedStage = { stage: string | null; confidence: number; reason: string };

/** Map an analysis' stage suggestion (AI or heuristic) onto a signal candidate. */
export function candidateFromStageSuggestion(s: SuggestedStage | null | undefined, ctx: SignalContext, engine: string, quote: string | null): SignalCandidate | null {
  if (!s?.stage || !(s.confidence >= MIN_CONFIDENCE)) return null;
  const name = matchStageName(s.stage, ctx.stages.map((x) => x.name));
  const st = name ? ctx.stages.find((x) => x.name === name) : null;
  if (!st || st.id === ctx.currentStageId) return null;
  const confidence = Math.min(0.9, Math.max(0, s.confidence));
  const rationale = clip(s.reason || `Suggested stage: ${st.name}.`, 300);
  if (st.category === "won" || st.category === "lost") return { kind: st.category, quote, rationale, confidence, engine, suggestedStageId: st.id, suggestedCloseDate: null };
  if (st.category === "hold" || PARKING.test(st.name)) return { kind: "stall", quote, rationale, confidence, engine, suggestedStageId: st.id, suggestedCloseDate: null };
  if (!forwardStages(ctx).some((x) => x.id === st.id)) return null; // backwards moves aren't "advance" signals
  return { kind: "advance", quote, rationale, confidence, engine, suggestedStageId: st.id, suggestedCloseDate: null };
}

const PROGRESS_HINT: Record<string, StageHint> = { contract_sent: "contract", legal_review: "contract", nda_signed: "nda", pricing_requested: "proposal", demo_requested: "demo" };

export type EmailAnalysisLike = {
  engine: string;
  suggested_stage: SuggestedStage;
  progress_signals: { type: string; evidence: string }[];
};

/**
 * Signals for one analyzed INBOUND email (the caller skips outbound mail, private threads and unlinked threads).
 * Heuristic phrases on the text + the analysis' grounded progress signals and stage suggestion.
 */
export function signalsFromEmail(text: string, analysis: EmailAnalysisLike | null, ctx: SignalContext): SignalCandidate[] {
  const out = detectSignalsHeuristic(text, ctx);
  if (analysis) {
    const ai = analysis.engine !== "heuristic";
    for (const p of analysis.progress_signals ?? []) {
      const hint = PROGRESS_HINT[p.type];
      if (!hint || !ai) continue; // heuristic progress signals are already covered by the phrase library
      const st = stageForHint(hint, ctx);
      if (st) out.push({ kind: "advance", quote: clip(p.evidence), rationale: `${p.type.replace(/_/g, " ")} — suggests moving to ${st.name}.`, confidence: 0.6, engine: analysis.engine, suggestedStageId: st.id, suggestedCloseDate: null });
    }
    if (ai) {
      const fromStage = candidateFromStageSuggestion(analysis.suggested_stage, ctx, analysis.engine, out.find((c) => c.kind === "advance")?.quote ?? null);
      if (fromStage) out.push(fromStage);
    }
  }
  return reconcile(out);
}

export type TranscriptAnalysisLike = { engine: string; suggested_stage: SuggestedStage };

/** Prospect-side text of a transcript ("them" lines); falls back to everything when speakers are unknown. */
export function prospectText(rawText: string, ourNames: string[]): string {
  const ours = ourNames.map((n) => n.trim().toLowerCase()).filter(Boolean);
  const firsts = ours.map((n) => n.split(/\s+/)[0]!);
  const utterances = parsePlainText(rawText);
  if (!utterances.some((u) => u.speaker)) return rawText;
  return utterances
    .filter((u) => {
      const sp = (u.speaker ?? "").toLowerCase().trim();
      if (!sp) return true;
      return !(ours.includes(sp) || firsts.includes(sp.split(/\s+/)[0]!));
    })
    .map((u) => u.text)
    .join("\n");
}

/** Signals for an analyzed call transcript linked to a deal. */
export function signalsFromTranscript(rawText: string, ourNames: string[], analysis: TranscriptAnalysisLike | null, ctx: SignalContext): SignalCandidate[] {
  const out = detectSignalsHeuristic(prospectText(rawText, ourNames), ctx);
  if (analysis) {
    const fromStage = candidateFromStageSuggestion(analysis.suggested_stage, ctx, analysis.engine, out.find((c) => c.kind === "advance")?.quote ?? null);
    // The heuristic transcript analysis tops out at 0.5 confidence for stage hints; only AI suggestions count here.
    if (fromStage && analysis.engine !== "heuristic") out.push(fromStage);
  }
  return reconcile(out);
}

/* ───────────────────────────── Presentation helpers (shared by panel + queue) ───────────────────────────── */

export const SIGNAL_LABELS: Record<SignalKind, string> = {
  advance: "Ready to advance",
  close_date: "Timing changed",
  stall: "Stalling",
  risk: "Risk",
  won: "Looks won",
  lost: "Looks lost",
};

export type SignalApplyMode = "stage" | "close_date" | "task";

export function applyMode(kind: SignalKind, suggestedStageId: string | null): SignalApplyMode {
  if (kind === "close_date") return "close_date";
  if (kind === "risk") return "task";
  return suggestedStageId ? "stage" : "task";
}

export function applyLabel(kind: SignalKind, suggestedStageName: string | null, suggestedCloseDate: Date | null, fmt: (d: Date) => string): string {
  const mode = applyMode(kind, suggestedStageName ? "x" : null);
  if (mode === "close_date") return suggestedCloseDate ? `Set close to ${fmt(suggestedCloseDate)}` : "Update close date";
  if (mode === "task") return "Create follow-up task";
  if (kind === "won") return `Mark won (${suggestedStageName})`;
  if (kind === "lost") return `Mark lost (${suggestedStageName})`;
  return `Move to ${suggestedStageName}`;
}

/** Severity for the Today queue: lost/won/risk are louder than an advance suggestion. */
export function signalUrgency(kind: SignalKind, confidence: number): number {
  const base = { lost: 70, won: 65, risk: 60, stall: 55, close_date: 45, advance: 50 }[kind];
  return Math.round(Math.min(90, base + (confidence - 0.5) * 30));
}

/** Follow-up task title for risk / stall signals applied as a task. */
export function followUpTaskTitle(kind: SignalKind, dealName: string, rationale: string | null): string {
  const what = kind === "stall" ? "Re-engage" : "Address risk";
  const why = (rationale ?? "").replace(/\s*—.*$/, "").trim();
  return `${what}: ${dealName}${why ? ` (${why})` : ""}`.slice(0, 240);
}

/**
 * CR M9: a stage signal that would fail the target stage's gate (e.g. an open stage needs a next step + due date) is not
 * a dead end — the caller opens the deal's stage-move dialog prefilled instead. `missing` = gate fields the deal lacks.
 */
export function moveDialogHref(dealId: string, stageId: string, signalId: string): string {
  return `/deals/${dealId}?move=${encodeURIComponent(stageId)}&signal=${encodeURIComponent(signalId)}`;
}

export function needsInputMessage(dealName: string, stageName: string, missingLabels: string[]): string {
  const what = missingLabels.length ? missingLabels.join(", ") : "a few details";
  return `Moving ${dealName} to ${stageName} needs ${what} — finish it in the move dialog.`;
}
