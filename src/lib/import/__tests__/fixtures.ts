import type { StageLite } from "../status";

/** Seed-equivalent stages (scripts/seed.ts, PRD Appendix A) for pure tests. */
const mk = (key: string, name: string, sortOrder: number, probability: number, category: StageLite["category"], importAliases: string[]): StageLite & { id: string } => ({
  id: `${key}-id`,
  key,
  name,
  sortOrder,
  probability,
  category,
  importAliases,
});

export const MUU_STAGES = [
  mk("target", "Target", 0, 0.1, "open", ["target", "new", "no status", ""]),
  mk("outreach", "Outreach", 1, 0.1, "open", ["outreach", "reached out", "outreach sent"]),
  mk("in_comms", "In Comms", 2, 0.5, "open", ["in comms", "met", "call set", "call done"]),
  mk("warming", "Warming Up", 3, 0.5, "open", ["warming up", "warming", "warm"]),
  mk("hot", "Hot", 4, 0.9, "open", ["hot", "verbal"]),
  mk("demo", "Demo / Beta Review", 5, 0.9, "open", ["demo", "beta"]),
  mk("contract", "Contract", 6, 1, "open", ["contract", "contract sent"]),
  mk("migrating", "Migrating", 7, 1, "won", ["migrating", "onboarding"]),
  mk("live", "Live", 8, 1, "won", ["live", "launched"]),
  mk("on_hold", "On Hold", 9, 0.5, "hold", ["hold", "on hold", "on pause", "stuck", "paused"]),
  mk("cold", "Cold / Nurture", 10, 0.1, "open", ["cold", "old lead", "cold, keep comms", "cold - keep comms"]),
  mk("lost", "Lost / Rejected", 11, 0, "lost", ["rejected", "lost", "dead"]),
];

export const R100_STAGES = [
  mk("target", "Target", 0, 0.1, "open", ["target"]),
  mk("outreach", "Outreach", 1, 0.1, "open", ["outreach", "followed up", "follow up"]),
  mk("warming", "Warming Up", 2, 0.5, "open", ["warming up", "warming"]),
  mk("hot", "Hot", 3, 0.9, "open", ["hot"]),
  mk("relationship", "Relationship already", 4, 0.9, "open", ["relationship already"]),
  mk("onboarding", "Onboarding (Profile setup)", 5, 0.9, "open", ["onboarding"]),
  mk("profile_activated", "Profile Activated", 6, 1, "won", ["profile activated"]),
  mk("first_post", "Made First Post (Live)", 7, 1, "won", ["made first post", "live"]),
  mk("lapsed", "Lapsed", 8, 0.5, "hold", ["lapsed"]),
  mk("cold", "Cold – keep comms", 9, 0.1, "open", ["cold", "cold, keep comms", "cold - keep comms"]),
  mk("lost", "Declined", 10, 0, "lost", ["declined", "rejected"]),
];

export const ADS_STAGES = [
  mk("warm", "Warm Deal", 0, 0.5, "open", ["warm deal", "warm"]),
  mk("negotiation", "Negotiation", 1, 0.5, "open", ["negotiation", "hot"]),
  mk("verbal", "Verbal", 2, 0.9, "open", ["verbal", "verbal - closing now"]),
  mk("loi", "Signed LOI", 3, 0.9, "open", ["signed loi", "loi"]),
  mk("won", "Contract Signed (Won)", 4, 1, "won", ["active deal", "contract signed", "won"]),
  mk("current_client", "Current Client", 5, 1, "won", ["current client"]),
];
