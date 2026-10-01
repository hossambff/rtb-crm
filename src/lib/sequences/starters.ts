/**
 * Starter sequences (seeded INACTIVE and unowned by scripts/seed-sequences.ts). Pure data, unit-tested: every template
 * passes validateSequence, uses only {{first_name}} {{company}} {{sender_first_name}} {{opener}}, carries an opt-out
 * line, and makes no numeric or product claims beyond the approved claims library ("no cost to join the coalition").
 * Copy follows the sales doctrine: benefits not features, invitation-first, never promise CPM/RPM, no "premium",
 * no dashes as punctuation.
 */
import { normalizeSteps, OPT_OUT_HINT, type ExitRules, type Step } from "./core";

export type StarterSequence = { name: string; description: string; pipelineKeys: string[]; dailyCap: number; exitOn: ExitRules; steps: Step[] };

const EXIT: ExitRules = { reply: true, meetingBooked: true, stageChange: true, unsubscribe: true };
const OPENER = "{{opener|I've been following your work and had an idea worth sharing.}}";

export const STARTER_SEQUENCES: StarterSequence[] = [
  {
    name: "Starter: NET publisher outreach",
    description: "Cold invitation to an independent publisher to talk about joining the Roundtable coalition. Pairs with Lead Scout openers.",
    pipelineKeys: ["NET"],
    dailyCap: 30,
    exitOn: EXIT,
    steps: normalizeSteps([
      {
        kind: "email",
        delayDays: 0,
        subject: "An invitation for {{company}}",
        body: `Hi {{first_name}},\n\n${OPENER}\n\nRoundtable runs a coalition of independent publishers that share technology, audience and revenue, while each keeps its brand, domain and editorial control. There is no cost to join the coalition.\n\nWould you be open to a short call to see whether it fits {{company}}?\n\nBest,\n{{sender_first_name}}\n\n${OPT_OUT_HINT}`,
      },
      {
        kind: "email",
        delayDays: 3,
        body: "Hi {{first_name}},\n\nBringing this back to the top of your inbox. The conversation is mostly about your P&L, not a tech demo: what you'd stop paying for and what you'd keep.\n\nHappy to work around your calendar.\n\n{{sender_first_name}}",
        replyInThread: true,
      },
      { kind: "linkedin", delayDays: 2, title: "Connect with {{first_name}} at {{company}} on LinkedIn" },
      {
        kind: "email",
        delayDays: 5,
        body: "Hi {{first_name}},\n\nLast note from me for now. If the timing isn't right for {{company}}, just say so and I'll check back next quarter.\n\n{{sender_first_name}}",
        replyInThread: true,
      },
    ]),
  },
  {
    name: "Starter: Roundtable 100 invite",
    description: "Invite a public company or token project to activate its Roundtable 100 profile and channel.",
    pipelineKeys: ["R100"],
    dailyCap: 30,
    exitOn: EXIT,
    steps: normalizeSteps([
      {
        kind: "email",
        delayDays: 0,
        subject: "{{company}} and the Roundtable 100",
        body: `Hi {{first_name}},\n\n${OPENER}\n\nWe're building the Roundtable 100, a set of company profiles and channels where leadership teams share updates directly with an engaged audience. We'd like {{company}} to be part of it, and setting up the profile is something we handle with your team.\n\nWho is the best person to walk through it with?\n\nThanks,\n{{sender_first_name}}\n\n${OPT_OUT_HINT}`,
      },
      {
        kind: "email",
        delayDays: 4,
        body: "Hi {{first_name}},\n\nFollowing up on the Roundtable 100 invitation. If a quick walkthrough of the profile and channel would help, I can share a few times that work.\n\n{{sender_first_name}}",
        replyInThread: true,
      },
      { kind: "task", delayDays: 3, title: "Find the comms or IR lead at {{company}} and personalize a last note" },
    ]),
  },
  {
    name: "Starter: Re-engagement",
    description: "Reopen a conversation that went quiet. Low pressure, two touches.",
    pipelineKeys: [],
    dailyCap: 25,
    exitOn: EXIT,
    steps: normalizeSteps([
      {
        kind: "email",
        delayDays: 0,
        subject: "Picking things back up with {{company}}",
        body: `Hi {{first_name}},\n\nIt's been a little while since we last spoke, so I wanted to check in. Has anything changed on your side at {{company}} that would make another conversation useful?\n\nIf yes, I'll send over a couple of times. If not, no problem at all.\n\n{{sender_first_name}}\n\n${OPT_OUT_HINT}`,
      },
      {
        kind: "email",
        delayDays: 7,
        body: "Hi {{first_name}},\n\nOne last check in from me. Whenever the timing is better, just reply here and we'll pick it up.\n\n{{sender_first_name}}",
        replyInThread: true,
      },
    ]),
  },
];
