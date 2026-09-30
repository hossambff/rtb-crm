/**
 * Built-in RTB sales playbook (PRD §11.3 "RTB playbook corpus"): objection library + stage agendas.
 * Pure data — used by meeting_prep and as grounding for Copilot. Admin-curated knowledge base replaces this later.
 * Rebuttals deliberately avoid banned/restricted claims (see claim library): no "paid in seconds", no audited-revenue
 * claims, no unconditional guarantees, no beta features presented as live.
 */

export type Objection = {
  id: string;
  objection: string;
  rebuttal: string;
  /** Keywords that, when seen in recent activity text, make this objection likely. */
  keywords: string[];
  /** Pipelines where the objection typically comes up. */
  pipelines: string[];
};

export const OBJECTIONS: Objection[] = [
  {
    id: "rev-share-fairness",
    objection: "A 50/50 revenue share feels like giving away half our business.",
    rebuttal:
      "The share applies to revenue the platform generates after the ramp, and RTB carries the platform, ad-stack and syndication costs you pay today. Compare net take-home, not headline split: walk through their current vendor and ad-ops costs line by line and model it in the pro forma.",
    keywords: ["rev share", "revenue share", "50/50", "split", "take rate", "percentage"],
    pipelines: ["NET", "ENT", "SPT"],
  },
  {
    id: "migration-risk",
    objection: "Migrating our CMS and archive is too risky — we'll lose traffic and SEO.",
    rebuttal:
      "Migration is staged: RTB builds a clone for review before anything switches, URLs and redirects are preserved, and the team runs QA before launch. Offer a reference call with a migrated partner and a written migration plan with a rollback step.",
    keywords: ["migration", "migrate", "seo", "archive", "redirect", "downtime", "cms"],
    pipelines: ["NET", "ENT", "SPT"],
  },
  {
    id: "loss-of-control",
    objection: "We'll lose control of our stack, our brand and our editorial independence.",
    rebuttal:
      "Editorial stays 100% theirs, and so does the brand and domain. RTB runs the technology and monetization layer under a contract with defined terms and reporting. Show the partner dashboard and the reporting cadence they will get.",
    keywords: ["control", "independence", "editorial", "own our", "lock-in", "locked in", "brand"],
    pipelines: ["NET", "ENT", "SPT"],
  },
  {
    id: "guarantees",
    objection: "Can you guarantee we'll make at least what we make today?",
    rebuttal:
      "Some agreements include a monthly guarantee or a profit floor, but the mechanics are defined per contract (e.g. trailing-12-month digital operating profit). Don't promise a number in the room: offer to model it in a pro forma and route terms through the approval flow.",
    keywords: ["guarantee", "minimum", "floor", "downside", "worse off"],
    pipelines: ["NET", "ENT", "SPT"],
  },
  {
    id: "crypto-skepticism",
    objection: "We don't want to be associated with crypto / DeFi.",
    rebuttal:
      "The platform is a publishing and monetization stack first; crypto-native payment rails are optional. The Media Liquidity Pool and real-time payouts are beta/upcoming and never required. Lead with CMS, syndication and yield; RTB is a NASDAQ-listed public company (RTB).",
    keywords: ["crypto", "defi", "token", "blockchain", "stablecoin", "usdc", "web3"],
    pipelines: ["NET", "ENT", "SPT", "R100", "ADS"],
  },
  {
    id: "why-not-hubspot-wp",
    objection: "Why not just stay on WordPress VIP / HubSpot / our current vendors?",
    rebuttal:
      "Those are single tools; RTB replaces several categories of vendor tooling (CMS, video, ad stack, syndication) with one platform and funds it through the revenue share. Build a side-by-side of their current tool costs and the effort to run them.",
    keywords: ["wordpress", "vip", "hubspot", "arc", "vendor", "current stack", "in-house", "our own tech"],
    pipelines: ["NET", "ENT", "SPT"],
  },
  {
    id: "timing",
    objection: "Now isn't the right time — come back next quarter.",
    rebuttal:
      "Agree a concrete date and a small next step now (NDA, data-room access or a scoped pro forma) so the evaluation is ready when their window opens. Ask what event makes the timing right and put it on the calendar.",
    keywords: ["timing", "next quarter", "next year", "busy", "later", "not now", "budget cycle"],
    pipelines: ["NET", "ENT", "SPT", "R100", "ADS", "PAY"],
  },
  {
    id: "proof",
    objection: "What results have other publishers actually seen?",
    rebuttal:
      "Use only approved proof points from the claim library, with their evidence. Offer a reference call. Never quote unaudited figures as audited or present syndication reach as direct audience.",
    keywords: ["results", "case study", "proof", "references", "numbers", "track record"],
    pipelines: ["NET", "ENT", "SPT", "ADS"],
  },
  {
    id: "r100-value",
    objection: "What do we get from a Roundtable 100 profile — is it just another listing?",
    rebuttal:
      "It is a live profile and channel with editorial exposure (interviews, power-ranking placement on TheStreet) at no cost. Show an active RTB100 profile and the posting cadence that keeps it valuable.",
    keywords: ["profile", "listing", "rtb100", "roundtable 100", "exposure"],
    pipelines: ["R100"],
  },
  {
    id: "ads-price",
    objection: "The sponsorship package is too expensive for our budget.",
    rebuttal:
      "Re-scope to the placements that match their goal (newsletter, section sponsorship, podcast redistribution) and anchor on audience fit and deliverables, not CPM alone. Offer a shorter test flight with clear reporting.",
    keywords: ["price", "expensive", "budget", "cpm", "cost"],
    pipelines: ["ADS"],
  },
];

/** Suggested agenda by stage key (falls back to a generic discovery agenda). */
export const STAGE_AGENDAS: Record<string, string[]> = {
  target: ["Introductions and why RTB reached out", "Their business: audience, revenue mix, current stack", "Pain points and priorities", "Agree next step"],
  outreach: ["Introductions and context", "Discovery: audience (MUU), monetization, stack", "Coalition overview (high level)", "Agree next step and owner"],
  in_comms: ["Recap of last conversation", "Qualification gaps: MUU, decision maker, stack, timeline", "Platform walkthrough tailored to their pain", "Agree concrete next step (NDA / demo / data)"],
  warming: ["Recap and open questions", "Address objections raised so far", "Economics: revenue share and costs replaced", "Agree path to a decision"],
  nda: ["Confirm NDA status and data exchange", "Data request for the pro forma", "Stakeholder map and decision process", "Timeline to proposal"],
  proposal: ["Walk through the pro forma assumptions", "Terms overview (subject to approval)", "Open questions and concerns", "Decision timeline and signatories"],
  negotiation: ["Outstanding terms", "Legal / redline status", "Migration plan and timeline", "Close plan and signatures"],
  hot: ["Confirm verbal intent", "Remaining blockers", "Contract logistics", "Migration kickoff plan"],
  demo: ["Demo / beta review feedback", "Gaps vs. their requirements", "Next step to contract"],
  contract: ["Contract status and redlines", "Signatories and dates", "Migration kickoff"],
  warm: ["Campaign goals and audience", "Package options", "Budget and flight dates", "Next step"],
  verbal: ["Confirm scope and pricing", "Insertion order / contract", "Creative and launch dates"],
  renewal: ["Results of the current flight", "Renewal scope", "Pricing and dates"],
};

export const GENERIC_AGENDA = ["Introductions and goals for the call", "Recap of history and open items", "Discussion of their priorities", "Agree next step, owner and date"];

/** Rank objections for a meeting: keyword hits in recent text first, then pipeline defaults. */
export function likelyObjections(opts: { pipelineKey?: string | null; text?: string; max?: number }): Objection[] {
  const text = (opts.text ?? "").toLowerCase();
  const max = opts.max ?? 4;
  const scored = OBJECTIONS.map((o) => {
    const hits = o.keywords.filter((k) => text.includes(k)).length;
    const pipelineFit = opts.pipelineKey ? (o.pipelines.includes(opts.pipelineKey) ? 1 : 0) : 1;
    return { o, score: hits * 10 + pipelineFit };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((x) => x.o);
}

export function agendaFor(stageKey?: string | null): string[] {
  return (stageKey && STAGE_AGENDAS[stageKey]) || GENERIC_AGENDA;
}
