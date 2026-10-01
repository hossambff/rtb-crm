/**
 * Plain-language glossary (docs/V2_SPEC.md §B10). One sentence each, written for a new intern on day one.
 * Use with <Term id="muu">MUU</Term> (src/components/ui/term.tsx). Client-safe, no deps.
 */
export type GlossaryEntry = { term: string; short: string; long?: string };

export const GLOSSARY = {
  muu: {
    term: "MUU",
    short: "Monthly unique users — how many different people visit a site in a month.",
    long: "For publisher motions, deal value is MUU × $ per MUU, so a bigger audience means a bigger deal.",
  },
  weighted: {
    term: "Weighted value",
    short: "Deal value × the chance it closes (the stage probability).",
    long: "A $100K deal at a 25% stage counts as $25K weighted. It's how we avoid counting chickens.",
  },
  gross: { term: "Gross", short: "Total revenue the deal produces, before anyone's share is taken out." },
  rtbNet: { term: "RTB net", short: "Roundtable's share of gross revenue after the partner's revenue share." },
  health: {
    term: "Health",
    short: "A 0–100 score of how on-track a deal is.",
    long: "It drops when the next step is missing or overdue, activity goes quiet, or the deal sits in a stage too long.",
  },
  override: {
    term: "Override",
    short: "A manual change to a deal's win probability instead of the stage default.",
    long: "Overrides above the threshold need an executive's approval and always show who set them and why.",
  },
  nextStep: { term: "Next step", short: "The one concrete thing that moves the deal forward, with a date. Every open deal needs one." },
  sla: { term: "Stage SLA", short: "How many days a deal should normally stay in a stage before it counts as stale." },
  r100: {
    term: "R100",
    short: "Roundtable 100 — public companies and token projects with a live RTB100 profile and channel.",
    long: "Success is counted in live accounts (goal: 100), not dollars.",
  },
  net: { term: "NET", short: "Network Development — independent publishers joining the Roundtable coalition (MUU-based, revenue share)." },
  ent: { term: "ENT", short: "Enterprise — large media groups moving their full stack under a multi-year platform agreement." },
  spt: { term: "SPT", short: "Roundtable Sports Network — fan and team sites running a channel on roundtable.io/sports." },
  ads: { term: "ADS", short: "TheStreet sponsorship & advertising — brands buying packages and campaigns ($ contract value)." },
  pay: { term: "PAY", short: "Payments — the Media Liquidity Pool: early settlement of receivables for partner publishers." },
  mlp: { term: "MLP", short: "Media Liquidity Pool — we advance publishers' receivables for a fee (the PAY motion)." },
  commit: { term: "Commit", short: "Forecast category: you're confident it closes this period — you'd bet on it." },
  best: { term: "Best case", short: "Forecast category: could close this period if things go well." },
  pipelineCat: { term: "Pipeline", short: "Forecast category: real opportunity, but not expected to close this period." },
  unscheduled: {
    term: "Unscheduled",
    short: "Open deals with no expected close date, so they can't be placed in any quarter yet.",
    long: "They stay out of Commit and Best case until someone sets a close date.",
  },
  mnpi: {
    term: "MNPI",
    short: "Material non-public information — confidential deal info that could move markets.",
    long: "MNPI deals are marked Restricted: only people on the access list can see them, and they never appear in Slack, exports or AI answers for anyone else.",
  },
  restricted: { term: "Restricted", short: "Visible only to an explicit access list (usually because of MNPI). Every view is logged." },
  alertBudget: {
    term: "Alert budget",
    short: "How many alerts a day may interrupt you. The rest are bundled into your daily digest.",
    long: "Critical alerts always come through.",
  },
  motion: {
    term: "Motion",
    short: "A type of pipeline — a way we sell (NET, ENT, SPT, R100, ADS, PAY). Each has its own board and stages.",
    long: "“Pipelines” is the page with every board; a motion is one of them. The code (NET…) is always shown next to the full name.",
  },
  omitted: { term: "Omitted", short: "Forecast category: left out of this period's forecast on purpose (e.g. slipped or on hold)." },
  weightedPipeline: { term: "Weighted pipeline", short: "The sum of every open deal's weighted value — what the pipeline is realistically worth." },
  approvalSla: { term: "Approval SLA", short: "How long an approver has to decide before the request escalates to the next person." },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryId = keyof typeof GLOSSARY;

/** Motion code → glossary id (NET → "net"), for pipeline keys coming from the database. */
export function motionTermId(key: string): GlossaryId | null {
  const id = key.toLowerCase();
  return id in GLOSSARY ? (id as GlossaryId) : null;
}
