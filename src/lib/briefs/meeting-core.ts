/**
 * Auto meeting briefs (V2 A5) — pure brief assembly, unit-tested. The server side (meeting.ts) gathers permission-
 * checked facts; this file turns them into talking points, risks and the stored text. AI may replace the talking points
 * and add risks (aiBriefSchema), but the deterministic brief always exists.
 */
import { z } from "zod";
import { untrustedField } from "@/lib/untrusted-core";

export type BriefAttendee = { email: string; name: string | null; title: string | null; lastTouch: string | null; known: boolean };
export type BriefTask = { title: string; due: string | null; overdue: boolean };
export type BriefDeal = {
  id: string;
  name: string;
  stage: string;
  status: string;
  nextStep: string | null;
  nextStepDueAt: string | null;
  expectedCloseDate: string | null;
  health: number | null;
  daysInStage: number | null;
  stageSlaDays: number | null;
  lastActivityAt: string | null;
};
export type BriefCall = { id: string; title: string | null; at: string | null; highlights: string[]; risks: string[]; objections: string[] };

export type BriefInput = {
  meeting: { id: string; title: string | null; startsAt: string | null; endsAt: string | null };
  account: { id: string; name: string } | null;
  deal: BriefDeal | null;
  attendees: BriefAttendee[];
  ours: BriefTask[];
  theirs: BriefTask[];
  lastCall: BriefCall | null;
  now: Date;
};

export type MeetingBrief = {
  version: 1;
  meeting: BriefInput["meeting"];
  account: BriefInput["account"];
  deal: BriefDeal | null;
  attendees: BriefAttendee[];
  commitments: { ours: BriefTask[]; theirs: BriefTask[] };
  lastCall: BriefCall | null;
  talkingPoints: string[];
  risks: string[];
  engine: string; // heuristic | ai:<model>
  generatedAt: string;
};

const DAY = 86_400_000;
const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function stagePoint(stage: string): string | null {
  const s = stage.toLowerCase();
  if (/\bnda\b/.test(s)) return "Get the NDA signed and agree what happens right after.";
  if (/proposal|pro ?forma/.test(s)) return "Walk through the pro forma assumptions and confirm the numbers they care about.";
  if (/negotiat|verbal|hot/.test(s)) return "Close open terms and agree a signature date.";
  if (/contract|loi/.test(s)) return "Confirm who signs, the redline status and the signature date.";
  if (/demo|beta/.test(s)) return "Tie the demo to their stated pain and agree the evaluation criteria.";
  if (/target|outreach|comms|warm/.test(s)) return "Qualify: audience size (MUU), current stack, decision maker and timeline.";
  return null;
}

/** Deterministic brief: always available, also the AI fallback. */
export function buildHeuristicBrief(input: BriefInput): MeetingBrief {
  const { deal, now } = input;
  const points: string[] = [];
  const risks: string[] = [];

  if (deal?.nextStep) {
    const due = deal.nextStepDueAt ? new Date(deal.nextStepDueAt) : null;
    points.push(due && due.getTime() < now.getTime() ? `Close out the overdue next step: “${clip(deal.nextStep, 120)}”.` : `Confirm the next step: “${clip(deal.nextStep, 120)}”.`);
  } else if (deal) {
    points.push("Leave with a dated next step — the deal has none.");
  }
  const theirsOpen = input.theirs.filter((t) => t.title.trim());
  if (theirsOpen.length) points.push(`Check on what they owe: ${theirsOpen.slice(0, 2).map((t) => `“${clip(t.title.replace(/^Waiting on [^:]+:\s*/i, ""), 80)}”`).join(", ")}.`);
  const objection = input.lastCall?.objections[0];
  if (objection) points.push(`Revisit last call's concern: “${clip(objection, 110)}”.`);
  const sp = deal ? stagePoint(deal.stage) : null;
  if (sp) points.push(sp);
  const unknown = input.attendees.filter((a) => !a.known);
  if (unknown.length) points.push(`Learn the role of ${unknown.slice(0, 2).map((a) => a.name ?? a.email).join(" and ")} in the decision.`);
  points.push("Confirm the decision process, timeline and who else needs to be involved.");
  points.push("Agree the next meeting before you hang up.");

  if (deal) {
    if (deal.health != null && deal.health < 40) risks.push(`Deal health is low (${deal.health}/100).`);
    if (deal.nextStepDueAt && new Date(deal.nextStepDueAt).getTime() < now.getTime()) risks.push("Next step is overdue.");
    if (!deal.nextStep) risks.push("No next step on the deal.");
    if (deal.daysInStage != null && deal.stageSlaDays && deal.daysInStage > deal.stageSlaDays) risks.push(`Stuck in ${deal.stage} for ${deal.daysInStage} days (SLA ${deal.stageSlaDays}).`);
    if (deal.lastActivityAt && now.getTime() - new Date(deal.lastActivityAt).getTime() > 21 * DAY) risks.push("No logged activity in the last 3 weeks.");
    if (deal.expectedCloseDate && new Date(deal.expectedCloseDate).getTime() < now.getTime() && deal.status === "open") risks.push("Expected close date has passed.");
  }
  const oursOverdue = input.ours.filter((t) => t.overdue);
  if (oursOverdue.length) risks.push(`We owe ${oursOverdue.length} overdue item${oursOverdue.length === 1 ? "" : "s"} — address before they ask.`);
  for (const r of input.lastCall?.risks ?? []) risks.push(clip(r, 140));

  return {
    version: 1,
    meeting: input.meeting,
    account: input.account,
    deal: input.deal,
    attendees: input.attendees,
    commitments: { ours: input.ours, theirs: input.theirs },
    lastCall: input.lastCall,
    talkingPoints: dedupe(points).slice(0, 3),
    risks: dedupe(risks).slice(0, 5),
    engine: "heuristic",
    generatedAt: now.toISOString(),
  };
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ───────────────────────────── AI enrichment ───────────────────────────── */

export const aiBriefSchema = z.object({
  talking_points: z.array(z.string()).describe("Exactly 3 concise, specific talking points for the rep, grounded in the context"),
  risks: z.array(z.string()).describe("Up to 3 deal risks grounded in the context; empty if none"),
});
export type AiBrief = z.infer<typeof aiBriefSchema>;

/** Prompt with facts only; call highlights/objections come from untrusted transcripts and are wrapped as such. */
export function briefPrompt(b: MeetingBrief, wrap: (label: string, text: string) => string): string {
  const facts = {
    meeting: { title: b.meeting.title, startsAt: b.meeting.startsAt },
    account: b.account?.name ?? null,
    deal: b.deal ? { stage: b.deal.stage, nextStep: b.deal.nextStep, nextStepDueAt: b.deal.nextStepDueAt, health: b.deal.health, expectedClose: b.deal.expectedCloseDate } : null,
    attendees: b.attendees.map((a) => ({ name: a.name, title: a.title, inCrm: a.known })),
    weOwe: b.commitments.ours.map((t) => t.title),
    theyOwe: b.commitments.theirs.map((t) => t.title),
    heuristicRisks: b.risks,
  };
  return [
    "Prepare a pre-meeting brief for an RTB sales rep. Give exactly 3 talking points (imperative, one sentence each, specific to this deal)",
    "and up to 3 risks. Use only the facts below; never invent numbers, names or dates; never mention internal pipeline totals or other clients.",
    `Meeting title: ${untrustedField("meeting:title", b.meeting.title)}`,
    `Facts (JSON): ${JSON.stringify(facts)}`,
    b.lastCall ? wrap("last-call-notes", [...b.lastCall.highlights, ...b.lastCall.objections.map((o) => `Objection: ${o}`)].join("\n")) : "No previous call notes.",
  ].join("\n");
}

export function mergeAiBrief(b: MeetingBrief, ai: AiBrief, model: string): MeetingBrief {
  const points = ai.talking_points.map((p) => clip(p.trim(), 220)).filter((p) => p.length > 8);
  if (points.length < 3) return b; // keep the deterministic points rather than a partial AI answer
  return {
    ...b,
    talkingPoints: points.slice(0, 3),
    // Top deterministic risks first, then AI ones, then the rest (so AI insight isn't crowded out).
    risks: dedupe([...b.risks.slice(0, 3), ...ai.risks.map((r) => clip(r.trim(), 160)).filter((r) => r.length > 5).slice(0, 2), ...b.risks.slice(3)]).slice(0, 5),
    engine: `ai:${model}`,
  };
}

/* ───────────────────────────── Text + notification ───────────────────────────── */

/** Plain-text brief stored on meetings.prep_brief (readable anywhere, e.g. digests). */
export function briefToText(b: MeetingBrief, fmtDate: (iso: string) => string): string {
  const lines: string[] = [];
  lines.push(`Brief: ${b.meeting.title ?? "Meeting"}${b.account ? ` · ${b.account.name}` : ""}`);
  if (b.deal) lines.push(`Deal: ${b.deal.name} — ${b.deal.stage}${b.deal.nextStep ? ` · next step: ${b.deal.nextStep}${b.deal.nextStepDueAt ? ` (due ${fmtDate(b.deal.nextStepDueAt)})` : ""}` : " · no next step"}`);
  if (b.attendees.length) {
    lines.push("", "Attendees:");
    for (const a of b.attendees) lines.push(`• ${a.name ?? a.email}${a.title ? `, ${a.title}` : ""}${a.lastTouch ? ` — last touch ${fmtDate(a.lastTouch)}` : a.known ? "" : " — new contact"}`);
  }
  if (b.commitments.ours.length || b.commitments.theirs.length) {
    lines.push("", "Open commitments:");
    for (const t of b.commitments.ours) lines.push(`• We owe: ${t.title}${t.due ? ` (due ${fmtDate(t.due)})` : ""}`);
    for (const t of b.commitments.theirs) lines.push(`• They owe: ${t.title.replace(/^Waiting on [^:]+:\s*/i, "")}${t.due ? ` (due ${fmtDate(t.due)})` : ""}`);
  }
  if (b.lastCall?.highlights.length) {
    lines.push("", `Last call${b.lastCall.at ? ` (${fmtDate(b.lastCall.at)})` : ""}:`);
    for (const h of b.lastCall.highlights.slice(0, 3)) lines.push(`• ${h}`);
  }
  lines.push("", "Talking points:");
  b.talkingPoints.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  if (b.risks.length) {
    lines.push("", "Risks:");
    for (const r of b.risks) lines.push(`• ${r}`);
  }
  return lines.join("\n").slice(0, 8000);
}

/** "Brief ready: TheStreet in 30 min" (rounded to 5 minutes; "now" when it is about to start). */
export function briefNotificationTitle(name: string | null, startsAt: Date, now: Date): string {
  const min = Math.round((startsAt.getTime() - now.getTime()) / 60_000 / 5) * 5;
  const when = min <= 2 ? "starting now" : min >= 60 ? `in ${Math.round(min / 60)} h` : `in ${min} min`;
  return `Brief ready: ${clip(name ?? "your meeting", 60)} ${when}`;
}

/** Briefs older than this are rebuilt before the pre-meeting notification (data may have moved since the morning). */
export const BRIEF_STALE_MS = 3 * 60 * 60 * 1000;

export function isStale(content: { generatedAt?: unknown } | null | undefined, now: Date): boolean {
  const t = typeof content?.generatedAt === "string" ? new Date(content.generatedAt).getTime() : NaN;
  return !Number.isFinite(t) || now.getTime() - t > BRIEF_STALE_MS;
}

export const briefHref = (meetingId: string) => `/calls/briefs/${meetingId}`;

/* ───────────────────────────── Eligibility (QA MAJ-11 / MAJ-14, CR M7) ───────────────────────────── */

export type BriefSkipReason = "internal" | "unlinked" | "off";

/**
 * Should an AUTOMATIC brief be built? External attendees AND a linked/linkable account or a deal the owner can see.
 * Vendors, recruiters and personal invites with no CRM link get none (a manual "Prepare now" still works).
 */
export function briefEligibility(f: { externalAttendees: number; accountId: string | null; dealVisible: boolean }): BriefSkipReason | null {
  if (f.externalAttendees <= 0) return "internal";
  if (!f.accountId && !f.dealVisible) return "unlinked";
  return null;
}

/**
 * Marker rows for meetings the tick decided not to brief: stored with `deliveredAt` set so the same meeting is never
 * re-selected (starvation fix). They are not briefs — readers must treat them as "no brief".
 */
export function skippedMarker(reason: BriefSkipReason, now: Date): Record<string, unknown> {
  return { skipped: reason, at: now.toISOString() };
}

export function isSkippedMarker(content: unknown): boolean {
  return Boolean(content && typeof content === "object" && "skipped" in (content as Record<string, unknown>));
}

/** AI for a brief only when the owner may use AI and nothing restricted (MNPI) would be sent to the model (SEC M-6). */
export function briefMayUseAi(f: { requested: boolean; aiAvailable: boolean; userMayUseAi: boolean; sensitive: boolean }): boolean {
  return f.requested && f.aiAvailable && f.userMayUseAi && !f.sensitive;
}
