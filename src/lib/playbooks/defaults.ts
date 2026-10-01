/**
 * Default stage playbooks for NET / ENT / R100 / ADS, derived from the PRD stage definitions (Appendix A),
 * the stage gates (DEAL-2/3/7) and the seed automations (Appendix C). Installed by scripts/seed-playbooks.ts
 * (idempotent: only stages without a playbook get one). Pure data — admins edit them in /admin/playbooks.
 */
import type { PlaybookEmail, PlaybookTask } from "./core";

export type DefaultPlaybook = { name: string; guidance: string; tasks: PlaybookTask[]; emailTemplates?: PlaybookEmail[] };

const t = (title: string, dueInDays: number, assignTo: PlaybookTask["assignTo"] = "owner", priority: PlaybookTask["priority"] = "medium", description?: string): PlaybookTask => ({
  title,
  dueInDays,
  assignTo,
  priority,
  ...(description ? { description } : {}),
});

const INTRO_EMAIL: PlaybookEmail = {
  name: "Intro — coalition",
  subject: "{{company}} × Roundtable",
  body:
    "Hi {{first_name}},\n\nI lead partnerships at Roundtable. We run the publishing platform behind a growing coalition of independent publishers — CMS, AI site migration, syndication and the ad stack — on a revenue share, so there's no platform cost to you.\n\nWould a 20-minute call next week be useful to see whether it fits {{company}}?\n\nBest,\n{{sender_first_name}}",
};
const FOLLOW_UP_EMAIL: PlaybookEmail = {
  name: "Follow-up — after first call",
  subject: "Next steps — {{company}} × Roundtable",
  body:
    "Hi {{first_name}},\n\nThanks for the time today. As discussed, the next step is:\n\n- \n\nI'll send over the materials we covered. Anything else your team needs to evaluate this?\n\nBest,\n{{sender_first_name}}",
};

/** NET + SPT share the MUU stage set (scripts/seed.ts MUU_STAGES). */
const MUU_MOTION: Record<string, DefaultPlaybook> = {
  target: {
    name: "Target — qualify",
    guidance: "Confirm the publisher fits (audience, vertical, independent ownership) and find the decision maker before reaching out. Log MUU with its source.",
    tasks: [t("Research the publisher and confirm MUU", 2), t("Find the owner / publisher contact", 3)],
    emailTemplates: [INTRO_EMAIL],
  },
  outreach: {
    name: "Outreach — first touch",
    guidance: "Personal first touch to the decision maker, then two follow-ups over ten business days. Lead with what changes for them (no platform cost, syndication, yield) — only approved claims.",
    tasks: [t("Send personal intro email", 1, "owner", "high"), t("Follow up if no reply", 4), t("Second follow-up / LinkedIn touch", 9, "owner", "low")],
    emailTemplates: [INTRO_EMAIL],
  },
  in_comms: {
    name: "In comms — discovery",
    guidance: "Run discovery: current CMS and vendors, ad stack, headcount, traffic by source, what they'd want from a partner. Identify the decision maker and a champion.",
    tasks: [t("Run discovery call", 3, "owner", "high"), t("Send recap with next steps", 1), t("Link decision maker and champion as stakeholders", 3)],
    emailTemplates: [FOLLOW_UP_EMAIL],
  },
  warming: {
    name: "Warming up — show the value",
    guidance: "Make it concrete: illustrative economics at their MUU, examples of coalition partners, and what migration looks like. Agree a date to review a demo or beta clone.",
    tasks: [t("Share illustrative economics at their MUU", 3, "owner", "high"), t("Book demo / beta review", 5)],
  },
  hot: {
    name: "Hot — verbal",
    guidance: "Verbal interest: confirm terms (revenue share, ramp, any guarantee) and who signs. Loop in your manager for anything outside standard terms.",
    tasks: [t("Confirm terms and signatory", 2, "owner", "high"), t("Review terms with manager", 2, "manager")],
  },
  demo: {
    name: "Demo / beta review",
    guidance: "Walk them through the beta clone of their site; capture feedback and blockers. Send the term sheet once they're happy with the clone.",
    tasks: [t("Walk through beta clone with the publisher", 3, "owner", "high"), t("Send term sheet", 5, "owner", "high")],
  },
  contract: {
    name: "Contract — get it signed",
    guidance: "Contract out: requires MUU and a primary contact. Follow up on signature within three business days; keep legal questions moving daily.",
    tasks: [t("Follow up on signature", 3, "owner", "high"), t("Confirm NDA is signed and linked", 1)],
  },
  migrating: {
    name: "Won — kickoff migration",
    guidance: "Won. Onboarding owns the migration from here; the AE stays the relationship owner. Kickoff call within three business days.",
    tasks: [t("Schedule migration kickoff call", 3, "onboarding", "high"), t("Introduce onboarding lead to the publisher", 1, "owner", "high")],
  },
  live: {
    name: "Live — first 30 days",
    guidance: "The site is live. Check in at 30 days on traffic, yield and editorial workflow.",
    tasks: [t("30-day check-in with the publisher", 20)],
  },
  on_hold: {
    name: "On hold",
    guidance: "Keep a dated reason. Agree when to re-engage and put it in the next step.",
    tasks: [t("Re-engage the publisher", 15, "owner", "low")],
  },
  cold: {
    name: "Cold / nurture",
    guidance: "Low-touch nurture: share a relevant coalition update every few weeks; move back to Outreach when there's a trigger.",
    tasks: [t("Send a nurture touch", 20, "owner", "low")],
  },
};

const ENT: Record<string, DefaultPlaybook> = {
  target: {
    name: "Target — account plan",
    guidance: "Strategic account: map the group (brands, MUU, current vendors and cost base) and the executive sponsor before first contact.",
    tasks: [t("Build the account map (brands, MUU, vendors)", 3), t("Identify executive sponsor", 5)],
  },
  outreach: {
    name: "Outreach — executive intro",
    guidance: "Executive-to-executive intro where possible. Ask for help from James/Bill when a warm path exists.",
    tasks: [t("Send executive intro", 2, "owner", "high"), t("Follow up on intro", 5)],
  },
  in_comms: {
    name: "In comms — discovery",
    guidance: "Understand the P&L: revenue by line, platform and vendor costs, headcount, strategic goals. Agree an NDA so they can share numbers.",
    tasks: [t("Run discovery with the executive sponsor", 5, "owner", "high"), t("Send mutual NDA", 3)],
  },
  nda: {
    name: "NDA — get the numbers",
    guidance: "NDA signed: request the data needed for the pro forma (traffic, revenue by line, costs).",
    tasks: [t("Request financials for the pro forma", 2, "owner", "high"), t("Link the signed NDA to the deal", 1)],
  },
  proposal: {
    name: "Proposal / pro forma",
    guidance: "Build the pro forma (revenue share, guarantee, ramp, term) and review it internally before it goes out. Anything beyond standard terms needs executive approval.",
    tasks: [t("Build pro forma v1", 5, "owner", "high"), t("Internal review of pro forma", 6, "manager"), t("Present pro forma to the client", 8, "owner", "high")],
  },
  negotiation: {
    name: "Negotiation",
    guidance: "Track every open term and who owes what. Keep the mutual action plan dated; escalate stalls early.",
    tasks: [t("Send updated terms after negotiation", 3, "owner", "high"), t("Agree mutual action plan to signature", 5)],
  },
  contract: {
    name: "Contract",
    guidance: "Requires MUU, revenue share and a primary contact. Daily follow-up with legal on both sides.",
    tasks: [t("Follow up on signature", 3, "owner", "high"), t("Prepare onboarding plan", 5, "onboarding")],
  },
  won: {
    name: "Signed — kickoff",
    guidance: "Signed platform agreement. Kickoff with the client's leadership within a week; onboarding owns the migration plan.",
    tasks: [t("Executive kickoff meeting", 5, "owner", "high"), t("Migration plan and timeline", 5, "onboarding", "high")],
  },
  on_hold: { name: "On hold", guidance: "Record why and when to re-engage.", tasks: [t("Re-engage the sponsor", 20, "owner", "low")] },
  cold: { name: "Cold / nurture", guidance: "Quarterly executive touch with relevant coalition news.", tasks: [t("Quarterly executive touch", 40, "owner", "low")] },
};

const R100: Record<string, DefaultPlaybook> = {
  target: {
    name: "Target",
    guidance: "Public companies and token projects: confirm the IR / comms contact before outreach.",
    tasks: [t("Find the IR / communications contact", 3)],
    emailTemplates: [
      {
        name: "RTB100 invitation",
        subject: "{{company}} in the Roundtable 100",
        body:
          "Hi {{first_name}},\n\nWe'd like to include {{company}} in the Roundtable 100 — a live profile and channel on Roundtable, with editorial visibility on TheStreet.\n\nCan I send over the details?\n\nBest,\n{{sender_first_name}}",
      },
    ],
  },
  outreach: {
    name: "Outreach",
    guidance: "Invitation plus two follow-ups. Keep it short: what they get (profile, channel, interview, editorial placement).",
    tasks: [t("Send RTB100 invitation", 1, "owner", "high"), t("Follow up on invitation", 5)],
  },
  warming: { name: "Warming up", guidance: "Answer questions and book the onboarding call.", tasks: [t("Book onboarding call", 3, "owner", "high")] },
  hot: { name: "Hot", guidance: "They said yes — get profile assets and an editorial contact.", tasks: [t("Collect profile assets (logo, bio, links)", 3, "owner", "high")] },
  relationship: { name: "Relationship already", guidance: "Existing relationship: go straight to onboarding.", tasks: [t("Book onboarding call", 2, "owner", "high")] },
  onboarding: {
    name: "Onboarding — profile setup",
    guidance: "Set up the profile and channel; schedule the executive interview.",
    tasks: [t("Activate the RTB100 profile", 3, "owner", "high"), t("Schedule executive interview", 5)],
  },
  profile_activated: { name: "Profile activated", guidance: "Profile live — get the first post out.", tasks: [t("Publish the first channel post", 3, "owner", "high")] },
  first_post: { name: "Live", guidance: "Live. Track participation for months 1–3.", tasks: [t("Month-2 participation check", 25)] },
  lapsed: { name: "Lapsed", guidance: "Find out why posting stopped and agree a restart.", tasks: [t("Re-engage on posting cadence", 5)] },
  cold: { name: "Cold – keep comms", guidance: "Light-touch updates; move to Outreach on a trigger.", tasks: [t("Send a keep-warm note", 30, "owner", "low")] },
};

const ADS: Record<string, DefaultPlaybook> = {
  warm: {
    name: "Warm deal",
    guidance: "Qualify budget, timing and objectives; match them to a TheStreet package (section sponsorship, newsletter, podcast, events).",
    tasks: [t("Qualify budget and campaign dates", 3, "owner", "high"), t("Send package options", 5)],
    emailTemplates: [
      {
        name: "Package options",
        subject: "TheStreet Crypto — options for {{company}}",
        body: "Hi {{first_name}},\n\nAs promised, here are the packages that fit your goals and dates:\n\n- \n\nHappy to walk through them on a call.\n\nBest,\n{{sender_first_name}}",
      },
    ],
  },
  negotiation: { name: "Negotiation", guidance: "Agree package, price and flight dates in writing.", tasks: [t("Send proposal with pricing", 3, "owner", "high")] },
  verbal: { name: "Verbal", guidance: "Verbal yes: send the IO / LOI the same week.", tasks: [t("Send IO / LOI", 2, "owner", "high")] },
  loi: { name: "Signed LOI", guidance: "Move to contract; collect billing details.", tasks: [t("Send contract", 3, "owner", "high"), t("Collect billing contact and schedule", 5)] },
  won: {
    name: "Contract signed",
    guidance: "Won requires contract value. Confirm the billing schedule so invoices are created; brief the editorial/ad ops team on the campaign.",
    tasks: [t("Confirm billing schedule", 2, "owner", "high"), t("Campaign kickoff with ad ops", 5)],
  },
  current_client: { name: "Current client", guidance: "Report results mid-flight and plan the renewal early.", tasks: [t("Send mid-campaign performance report", 15)] },
  renewal: { name: "Renewal", guidance: "Renewal conversation with results in hand.", tasks: [t("Renewal proposal", 5, "owner", "high")] },
};

/** pipeline key → stage key → default playbook. */
export const DEFAULT_PLAYBOOKS: Record<string, Record<string, DefaultPlaybook>> = {
  NET: MUU_MOTION,
  SPT: MUU_MOTION,
  ENT,
  R100,
  ADS,
};
