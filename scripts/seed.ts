/**
 * Seed configuration data (idempotent): allowed domains, pipelines & stages (PRD Appendix A), picklists,
 * Nothing-Slips alert rules (PRD §12), product catalog (§5), claim library (§11.5), Apify actor registry (§M25.7),
 * org settings (D7/D8), teams, commission plan templates.
 *
 * Dev users (only when ALLOW_DEV_LOGIN=true): one per role, password = DEV_PASSWORD below. Email/password sign-in is
 * hard-disabled in production builds, so these accounts cannot sign in on the deployed app.
 *
 * Usage: npx tsx scripts/seed.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { scriptDb } from "./_db";
import * as s from "../src/db/schema";
import { CLAIM_PATTERNS } from "../src/lib/claims-patterns";

const DEV_PASSWORD = "rtb-dev-only-2026";

type StageSeed = { key: string; name: string; p: number; cat?: "open" | "won" | "lost" | "hold"; sla?: number; aliases?: string[]; req?: string[] };

const MUU_STAGES: StageSeed[] = [
  { key: "target", name: "Target", p: 0.1, sla: 30, aliases: ["target", "new", "no status", ""] },
  { key: "outreach", name: "Outreach", p: 0.1, sla: 14, aliases: ["outreach", "reached out", "outreach sent"] },
  { key: "in_comms", name: "In Comms", p: 0.5, sla: 10, aliases: ["in comms", "met", "call set", "call done"] },
  { key: "warming", name: "Warming Up", p: 0.5, sla: 14, aliases: ["warming up", "warming", "warm"] },
  { key: "hot", name: "Hot", p: 0.9, sla: 5, aliases: ["hot", "verbal"] },
  { key: "demo", name: "Demo / Beta Review", p: 0.9, sla: 7, aliases: ["demo", "beta"] },
  { key: "contract", name: "Contract", p: 1, sla: 5, aliases: ["contract", "contract sent"], req: ["muu", "primaryContactId"] },
  { key: "migrating", name: "Migrating", p: 1, cat: "won", aliases: ["migrating", "onboarding"] },
  { key: "live", name: "Live", p: 1, cat: "won", aliases: ["live", "launched"] },
  { key: "on_hold", name: "On Hold", p: 0.5, cat: "hold", sla: 30, aliases: ["hold", "on hold", "on pause", "stuck", "paused"] },
  { key: "cold", name: "Cold / Nurture", p: 0.1, sla: 60, aliases: ["cold", "old lead", "cold, keep comms", "cold - keep comms"] },
  { key: "lost", name: "Lost / Rejected", p: 0, cat: "lost", aliases: ["rejected", "lost", "dead"] },
];

const ENT_STAGES: StageSeed[] = [
  { key: "target", name: "Target", p: 0.1, sla: 30, aliases: ["target", "new"] },
  { key: "outreach", name: "Outreach", p: 0.1, sla: 14, aliases: ["outreach", "reached out"] },
  { key: "in_comms", name: "In Comms", p: 0.5, sla: 10, aliases: ["in comms", "met", "call set"] },
  { key: "nda", name: "NDA", p: 0.5, sla: 10, aliases: ["nda", "nda sent"] },
  { key: "proposal", name: "Proposal / Pro Forma", p: 0.5, sla: 10, aliases: ["proposal", "pro forma"] },
  { key: "negotiation", name: "Negotiation", p: 0.9, sla: 7, aliases: ["negotiation", "hot", "verbal"] },
  { key: "contract", name: "Contract", p: 1, sla: 5, aliases: ["contract"], req: ["muu", "revSharePct", "primaryContactId"] },
  { key: "won", name: "Signed (Won)", p: 1, cat: "won", aliases: ["signed", "closed", "won", "closed: platform agreement"] },
  { key: "on_hold", name: "On Hold", p: 0.5, cat: "hold", sla: 30, aliases: ["hold", "stuck", "on pause"] },
  { key: "cold", name: "Cold / Nurture", p: 0.1, sla: 60, aliases: ["cold"] },
  { key: "lost", name: "Lost", p: 0, cat: "lost", aliases: ["lost", "rejected"] },
];

const R100_STAGES: StageSeed[] = [
  { key: "target", name: "Target", p: 0.1, sla: 30, aliases: ["target"] },
  { key: "outreach", name: "Outreach", p: 0.1, sla: 14, aliases: ["outreach", "followed up", "follow up"] },
  { key: "warming", name: "Warming Up", p: 0.5, sla: 14, aliases: ["warming up", "warming"] },
  { key: "hot", name: "Hot", p: 0.9, sla: 7, aliases: ["hot"] },
  { key: "relationship", name: "Relationship already", p: 0.9, sla: 7, aliases: ["relationship already"] },
  { key: "onboarding", name: "Onboarding (Profile setup)", p: 0.9, sla: 7, aliases: ["onboarding"] },
  { key: "profile_activated", name: "Profile Activated", p: 1, cat: "won", aliases: ["profile activated"] },
  { key: "first_post", name: "Made First Post (Live)", p: 1, cat: "won", aliases: ["made first post", "live"] },
  { key: "lapsed", name: "Lapsed", p: 0.5, cat: "hold", sla: 30, aliases: ["lapsed"] },
  { key: "cold", name: "Cold – keep comms", p: 0.1, sla: 60, aliases: ["cold", "cold, keep comms", "cold - keep comms"] },
  { key: "lost", name: "Declined", p: 0, cat: "lost", aliases: ["declined", "rejected"] },
];

const ADS_STAGES: StageSeed[] = [
  { key: "warm", name: "Warm Deal", p: 0.5, sla: 14, aliases: ["warm deal", "warm"] },
  { key: "negotiation", name: "Negotiation", p: 0.5, sla: 10, aliases: ["negotiation", "hot"] },
  { key: "verbal", name: "Verbal", p: 0.9, sla: 5, aliases: ["verbal", "verbal - closing now"] },
  { key: "loi", name: "Signed LOI", p: 0.9, sla: 7, aliases: ["signed loi", "loi"] },
  { key: "won", name: "Contract Signed (Won)", p: 1, cat: "won", aliases: ["active deal", "contract signed", "won"], req: ["contractValueCents"] },
  { key: "current_client", name: "Current Client", p: 1, cat: "won", aliases: ["current client"] },
  { key: "renewal", name: "Renewal", p: 0.9, sla: 14, aliases: ["renewal"] },
  { key: "churned", name: "Churned / Lost", p: 0, cat: "lost", aliases: ["churned", "lost"] },
];

const PAY_STAGES: StageSeed[] = [
  { key: "qualified", name: "Qualified", p: 0.3, sla: 14 },
  { key: "underwriting", name: "Underwriting", p: 0.6, sla: 10 },
  { key: "approved", name: "Approved", p: 0.9, sla: 7 },
  { key: "funded", name: "Funded", p: 1, cat: "won" },
  { key: "declined", name: "Declined", p: 0, cat: "lost" },
];

const PIPELINES = [
  { key: "NET", type: "NET", name: "Network Development", unit: "muu", color: "#5C98D5", rev: 0.5, stages: MUU_STAGES, desc: "Independent & mid-size publishers joining the Roundtable coalition platform." },
  { key: "ENT", type: "ENT", name: "Enterprise Media", unit: "muu", color: "#AB6DBA", rev: 0.4, stages: ENT_STAGES, desc: "Large media groups — multi-year strategic platform agreements." },
  { key: "SPT", type: "SPT", name: "Sports Network", unit: "muu", color: "#44A781", rev: 0.5, stages: MUU_STAGES, desc: "Fan & team sites on roundtable.io/sports." },
  { key: "R100", type: "R100", name: "Roundtable 100", unit: "activation", color: "#A9933B", rev: null, stages: R100_STAGES, desc: "Public companies & token projects with live RTB100 profiles. Goal: 100 live." },
  { key: "ADS", type: "ADS", name: "TheStreet Sponsorships", unit: "usd", color: "#CE7C4C", rev: null, stages: ADS_STAGES, desc: "Sponsorship & advertising deals on TheStreet Crypto / Roundtable." },
  { key: "PAY", type: "PAY", name: "Media Liquidity Pool", unit: "usd", color: "#13A5B2", rev: null, stages: PAY_STAGES, desc: "Receivables advance / early settlement attach for partner publishers (beta)." },
] as const;

const PICKLISTS: Record<string, string[]> = {
  category: [
    "Finance", "Crypto", "Politics", "News", "Business", "AI", "Emerging Tech", "Consumer Tech", "Math/Science",
    "Military/Defense", "Space/Aviation/Military", "Sports", "Sustainability", "Travel/Adventure", "Real Estate",
    "Healthcare", "Cyber Security", "Lifestyle", "Gaming", "Food", "Local News", "Entertainment", "Education", "Enterprise Tech",
  ],
  league: ["NFL", "NBA", "MLB", "NHL", "Soccer/Premier League", "NCAA-SEC", "NCAA-Big Ten", "NCAA-ACC", "NCAA-Big 12", "MLS", "Boxing/MMA", "Other"],
  source: ["Inbound", "Outbound", "Referral", "Event", "Lead Scout", "Commission registration", "Import", "Strategic Top Targets", "NetDev Pipeline", "Sports"],
  lost_reason: ["Not interested", "Too small", "Group sign-off blocked", "Competitor / locked-in contract", "Timing", "No response", "Terms (rev share)", "Terms (guarantee)", "Technical fit", "Other"],
  reject_reason: ["Too small", "Wrong vertical", "Group-owned", "Competitor-locked", "Not independent", "Low quality", "Already in CRM", "Other"],
  contact_role: ["decision_maker", "champion", "influencer", "legal", "tech", "blocker", "finance"],
  hold_reason: ["Waiting on client", "Waiting on legal", "Waiting on engineering", "Budget cycle", "Other"],
};

const ALERT_RULES: { code: string; name: string; sev: "info" | "warning" | "serious" | "critical"; params?: Record<string, unknown>; esc?: number; desc: string }[] = [
  { code: "NS-01", name: "Open deal without next step", sev: "warning", esc: 24, desc: "Every open deal needs a next step and due date." },
  { code: "NS-02", name: "Next step overdue", sev: "serious", esc: 48, desc: "Next-step due date has passed." },
  { code: "NS-03", name: "Stale in stage beyond SLA", sev: "warning", esc: 48, desc: "No activity longer than the stage SLA." },
  { code: "NS-04", name: "Inbound email unanswered", sev: "serious", params: { hours: 24 }, esc: 24, desc: "Prospect email with no reply after 24 business hours." },
  { code: "NS-05", name: "Our commitment due", sev: "warning", esc: 48, desc: "A promise we made (from email/call) is due or overdue." },
  { code: "NS-06", name: "Their commitment passed", sev: "info", params: { graceDays: 2 }, desc: "Prospect's promised action is overdue — nudge draft ready." },
  { code: "NS-07", name: "Meeting without notes", sev: "warning", params: { hours: 2 }, desc: "External meeting ended with no transcript/notes." },
  { code: "NS-08", name: "Meeting prep not viewed", sev: "info", params: { minutes: 60 }, desc: "Upcoming meeting — prep brief ready." },
  { code: "NS-09", name: "Close date passed", sev: "warning", esc: 48, desc: "Expected close date passed, deal still open." },
  { code: "NS-10", name: "Contract/NDA not signed", sev: "warning", params: { businessDays: 5 }, desc: "Sent document unsigned after 5 business days." },
  { code: "NS-11", name: "Document expiring", sev: "info", params: { days: 30 }, desc: "NDA or contract expiring within 30 days." },
  { code: "NS-12", name: "Health score dropped", sev: "serious", params: { points: 20, days: 7 }, desc: "Deal health fell ≥20 pts in 7 days." },
  { code: "NS-13", name: "Champion went silent", sev: "warning", params: { touches: 2, days: 10 }, desc: "No reply to the last 2 touches." },
  { code: "NS-14", name: "Contact left company", sev: "warning", desc: "Bounce or enrichment shows the contact left." },
  { code: "NS-15", name: "High-value lead unassigned", sev: "serious", params: { hours: 4, muu: 10000000 }, desc: "High-value deal without an owner." },
  { code: "NS-16", name: "Lead registration conflict/expiring", sev: "info", params: { days: 7 }, desc: "Commission registration needs attention." },
  { code: "NS-17", name: "Duplicate account", sev: "info", desc: "Duplicate account detected." },
  { code: "NS-18", name: "Probability override needs approval", sev: "serious", desc: "Manual probability override pending executive approval." },
  { code: "NS-19", name: "Migration stalled", sev: "warning", params: { days: 10 }, desc: "Onboarding project stuck in stage." },
  { code: "NS-20", name: "Go-live slipped", sev: "serious", desc: "Migration target go-live date passed." },
  { code: "NS-21", name: "RTB100 participation lapsing", sev: "warning", desc: "Company hasn't posted this month." },
  { code: "NS-22", name: "RTB100 interview unpublished", sev: "info", params: { days: 14 }, desc: "Interview filmed but not published." },
  { code: "NS-23", name: "Invoice overdue", sev: "critical", params: { days: [1, 7, 14] }, desc: "Invoice past due." },
  { code: "NS-24", name: "Renewal approaching", sev: "info", params: { days: [60, 30, 14] }, desc: "Sponsorship renewal coming up." },
  { code: "NS-25", name: "Rep inactivity", sev: "warning", params: { businessDays: 2 }, desc: "No logged activity in 2 business days." },
  { code: "NS-26", name: "Task snoozed repeatedly", sev: "warning", params: { snoozes: 3 }, desc: "Task snoozed 3+ times." },
  { code: "NS-27", name: "Data quality gap", sev: "info", desc: "Engaged deal missing MUU / primary contact / valid email." },
  { code: "NS-28", name: "Sequence stuck", sev: "info", desc: "Sequence enrollment paused or bounced." },
  { code: "NS-29", name: "Proposal awaiting approval", sev: "warning", params: { businessDays: 1 }, desc: "Proposal waiting on approver." },
  { code: "NS-30", name: "Integration disconnected", sev: "serious", desc: "Gmail/Zoom/Granola/Apify connection broken." },
  { code: "NS-31", name: "Scout candidates awaiting review", sev: "info", params: { businessDays: 3 }, desc: "Lead Scout review queue aging." },
  { code: "NS-32", name: "Accepted scout target untouched", sev: "warning", params: { unassignedDays: 1, noTouchDays: 5 }, desc: "Accepted target without owner or first touch." },
  { code: "NS-33", name: "Apify budget threshold", sev: "warning", params: { thresholds: [0.5, 0.8, 1] }, desc: "Apify spend reached 50/80/100% of monthly budget." },
  { code: "NS-34", name: "Enriched contact bounced", sev: "info", desc: "Email bounced — re-enrich suggested." },
  { code: "NS-35", name: "Trigger event on high-fit account", sev: "info", desc: "Leadership change, traffic drop, CMS migration or ownership change." },
];

const PRODUCTS = [
  ["Platform", "Full-stack platform (CMS, hosting)", ["NET", "ENT", "SPT"], "rev_share", "live"],
  ["Platform", "AI site clone & archive migration (AI Import)", ["NET", "ENT", "SPT"], "free", "live"],
  ["Platform", "Video platform", ["NET", "ENT"], "rev_share", "live"],
  ["Platform", "Community & comments with AI moderation", ["NET", "ENT", "SPT"], "rev_share", "live"],
  ["Platform", "Apps", ["ENT"], "rev_share", "live"],
  ["Platform", "Identity & membership", ["ENT"], "rev_share", "live"],
  ["Platform", "Reporting & analytics", ["NET", "ENT", "SPT"], "free", "live"],
  ["Platform", "Ad stack / GAM management / direct sales", ["NET", "ENT", "SPT"], "rev_share", "live"],
  ["Distribution", "Syndication (Yahoo, MSN, Apple News)", ["NET", "ENT", "SPT"], "rev_share", "live"],
  ["Distribution", "Roundtable network channel", ["NET", "SPT"], "rev_share", "live"],
  ["Monetization", "Programmatic yield", ["NET", "ENT", "SPT"], "rev_share", "live"],
  ["Monetization", "Subscriptions & membership", ["ENT"], "rev_share", "live"],
  ["Payments", "Media Liquidity Pool (early settlement)", ["PAY", "NET", "ENT"], "fixed", "beta"],
  ["Payments", "Real-time payouts (USDC rails)", ["PAY"], "fixed", "upcoming"],
  ["Roundtable 100", "RTB100 profile", ["R100"], "free", "live"],
  ["Roundtable 100", "RTB100 channel posting", ["R100"], "free", "live"],
  ["Roundtable 100", "Executive interview (video)", ["R100"], "free", "live"],
  ["Roundtable 100", "Editorial power-ranking placement", ["R100"], "free", "live"],
  ["TheStreet sponsorship", "Crypto section sponsorship", ["ADS"], "package", "live"],
  ["TheStreet sponsorship", "Newsletter sponsorship", ["ADS"], "package", "live"],
  ["TheStreet sponsorship", "Podcast redistribution", ["ADS"], "package", "live"],
  ["TheStreet sponsorship", "Custom content", ["ADS"], "package", "live"],
] as const;

const CLAIMS: { text: string; pattern: string; status: "approved" | "restricted" | "banned"; alt?: string; evidence?: string }[] = [
  { text: "Paid in 8 seconds / powered by Coinbase", pattern: CLAIM_PATTERNS.paidInSeconds, status: "banned", alt: "Real-time payouts are in beta; early settlement is available through the Media Liquidity Pool (beta).", evidence: "Clear Street DD tracker 5 Sep 2026 flagged as material securities-accuracy issue." },
  { text: "$100M audited revenue", pattern: CLAIM_PATTERNS.auditedRevenue100m, status: "banned", alt: "~$100M annualized revenue run-rate across the partner network (unaudited).", evidence: "Figure is an annualized unaudited run-rate." },
  { text: "Replaces all 17 vendors", pattern: "(replace[sd]?|eliminate[sd]?) (all )?17 (software )?vendors", status: "restricted", alt: "Replaces up to 17 categories of vendor tools (CMS, video, ad stack…) — list available on request.", evidence: "Vendor list and savings math not yet verified per publisher." },
  { text: "500M audience reach", pattern: "500\\s?m(illion)?\\s+(audience|reach|users)", status: "restricted", alt: "Syndication reach via partners (Yahoo, MSN, Apple News); direct platform MUU is reported separately.", evidence: "500M includes syndication reach, not direct users." },
  { text: "Guaranteed to make at least what you make today", pattern: "guarantee[d]? .{0,40}(today|current) (profit|revenue)", status: "restricted", alt: "Profit floor guarantee subject to contract terms (trailing-12-month digital operating profit).", evidence: "Guarantee mechanics defined per contract." },
  { text: "AI migration in 2 hours", pattern: "(migrat\\w+|clone\\w*) .{0,20}(in )?2 hours", status: "restricted", alt: "AI Import clones a site and archive in hours rather than weeks (varies by archive size).", evidence: "CTO declined to quantify AI gains." },
  { text: "No cost to join the coalition", pattern: "(costs? nothing|free to join|no cost)", status: "approved", evidence: "Coalition partner agreement template: revenue share only." },
];

const ACTORS = [
  { purpose: "traffic", actorId: "tri_angle/fast-similarweb-scraper", order: 0, cost: 0.002, input: { websites: "{{domains}}" } },
  { purpose: "traffic", actorId: "tri_angle/similarweb-scraper", order: 1, cost: 0.013, input: { websites: "{{domains}}" } },
  { purpose: "lookalike", actorId: "radeance/similarweb-scraper", order: 0, cost: 0.01, input: { urls: "{{domains}}", include_similar_sites: true } },
  { purpose: "serp", actorId: "apify/google-search-scraper", order: 0, cost: 0.0025, input: { queries: "{{query}}", maxPagesPerQuery: 1 } },
  { purpose: "serp", actorId: "apidojo/google-search-scraper", order: 1, cost: 0.002, input: { searchTerms: ["{{query}}"], countryCode: "us", maxItems: 20 } },
  { purpose: "tech_stack", actorId: "builtwith/builtwith-official-technology-scraper", order: 0, cost: 0.002, input: { startDomains: "{{domains}}", maxRequestsPerCrawl: 20 } },
  { purpose: "website_contacts", actorId: "jungle_synthesizer/website-contact-details-scraper", order: 0, cost: 0.001, input: { startUrls: "{{urls}}", maxItems: 20, includeContactPages: true } },
  { purpose: "people", actorId: "harvestapi/linkedin-company-employees", order: 0, cost: 0.012, input: { companies: "{{companyLinkedinUrls}}", jobTitles: "{{titles}}", maxItems: 10, profileScraperMode: "Full + email search" } },
  { purpose: "people", actorId: "thirdwatch/linkedin-company-employees-scraper", order: 1, cost: 0.007, input: { queries: "{{companyNames}}", jobTitle: "{{titlesJoined}}", maxResults: 10 } },
  { purpose: "email_from_linkedin", actorId: "vulnv/linkedin-email-finder", order: 0, cost: 0.028, input: { urls: "{{linkedinUrls}}" } },
  { purpose: "email_finder", actorId: "clearpath/email-finder-api", order: 0, cost: 0.008, input: { people: "{{people}}" } },
  { purpose: "email_verify", actorId: "bounceverify/bounceverify-email-verifier", order: 0, cost: 0.00089, input: { emails: "{{emails}}" } },
  { purpose: "email_verify", actorId: "michael.g/email-verifier-validator", order: 1, cost: 0.001, input: { emails: "{{emails}}" } },
  { purpose: "research", actorId: "apify/rag-web-browser", order: 0, cost: 0.005, input: { query: "{{query}}", maxResults: 3 } },
];

const SETTINGS: Record<string, unknown> = {
  "pipeline.usd_per_muu": 1.0,
  "pipeline.engaged_threshold": 0.5,
  "pipeline.override_approval_threshold_pts": 30,
  "scout.visits_per_unique": 2.5,
  "scout.visits_per_unique_by_category": { News: 3.0, Sports: 2.0 },
  "scout.muu_sweet_spot": { NET: { min: 250000, max: 25000000 }, ENT: { min: 10000000 } },
  "scout.fit_weights": { audience: 25, vertical: 15, ownership: 15, pain: 15, stack: 10, lookalike: 10, geo: 5, relationship: 5 },
  "scout.core_verticals": ["Finance", "Crypto", "Politics", "News", "Sports", "AI", "Emerging Tech", "Military/Defense"],
  "scout.supported_countries": ["US", "GB", "IE", "CA", "AU", "ES", "MX", "AR", "CO", "IN", "PL"],
  "scout.budget": { orgMonthlyCents: 500, userMonthlyCents: 200, execMonthlyCents: 500, perRunMaxCents: 50, maxDomainsPerRun: 50 },
  "scout.target_roles": {
    NET: ["Founder", "Publisher", "Editor-in-Chief", "CEO", "GM"],
    SPT: ["Founder", "Publisher", "Editor-in-Chief", "CEO", "GM"],
    ENT: ["CEO", "CRO", "Chief Digital Officer", "CTO", "CPO", "Head of Ad Ops", "CFO"],
    R100: ["Head of Communications", "PR", "CMO", "Investor Relations"],
  },
  "scout.auto_promote_valid_senior": false,
  "agent.autonomy": {
    task_from_commitment: 2,
    link_email: 2,
    link_transcript: 2,
    log_activity: 2,
    next_step_update: 2,
    stage_change: 1,
    field_update_value: 1,
    create_contact: 1,
    send_email: 0,
  },
  "agent.claims_mode": "warn", // warn | block
  "ai.model_fast": "google/gemini-2.5-flash",
  "ai.model_strong": "openai/gpt-5-mini",
  "email.backfill_days": 90,
  "email.unanswered_hours": 24,
  "email.retention_unlinked_days": 7,
  "r100.goal_live": 100,
  "commission.registration_protect_days": 90,
  // proposals outside these guardrails need executive approval (src/lib/proposals/calc.ts approvalTriggers)
  "proposal.approval_rules": { minRevSharePct: 0.4, maxGuaranteeMonthlyUsd: 250000, maxTermYears: 10 },
};

const TEAMS = [
  { name: "NetDev", pipelineTypes: ["NET"] },
  { name: "Enterprise Partnerships", pipelineTypes: ["ENT"] },
  { name: "Sports", pipelineTypes: ["SPT"] },
  { name: "Roundtable 100", pipelineTypes: ["R100"] },
  { name: "Street Sales", pipelineTypes: ["ADS"] },
];

const COMMISSION_PLANS = [
  { name: "Commission-only — Street sales", description: "% of collected sponsorship revenue on sourced/registered deals.", rules: [{ trigger: "invoice_paid", pipelineKeys: ["ADS"], rateType: "pct_contract", rate: 15, clawbackDays: 90 }] },
  { name: "Commission-only — Publisher network", description: "Bounty per migrated publisher + % of RTB net for 12 months.", rules: [{ trigger: "migration_launched", pipelineKeys: ["NET", "SPT"], rateType: "flat", rate: 50000 }] },
  { name: "SDR — meetings + close", description: "$ per qualified meeting held + % on close.", rules: [{ trigger: "meeting_held", rateType: "flat", rate: 5000 }, { trigger: "deal_won", pipelineKeys: ["NET", "SPT", "ADS"], rateType: "pct_contract", rate: 2 }] },
  { name: "Intern — RTB100 activation bonus", description: "Bonus per RTB100 company going live.", rules: [{ trigger: "r100_live", pipelineKeys: ["R100"], rateType: "flat", rate: 5000 }] },
];

const DEV_USERS: { email: string; name: string; role: string; employmentType: "staff" | "retainer" | "hourly" | "commission" }[] = [
  { email: "dev.superadmin@roundtable.io", name: "Dev Super Admin", role: "super_admin", employmentType: "staff" },
  { email: "dev.exec@roundtable.io", name: "Dev Executive", role: "executive", employmentType: "staff" },
  { email: "dev.svp@roundtable.io", name: "Dev SVP", role: "sales_leader", employmentType: "retainer" },
  { email: "dev.sdr@roundtable.io", name: "Dev SDR", role: "sdr", employmentType: "staff" },
  { email: "dev.intern@roundtable.io", name: "Dev Intern", role: "intern", employmentType: "hourly" },
  { email: "dev.commission@roundtable.io", name: "Dev Commission Rep", role: "commission_rep", employmentType: "commission" },
  { email: "dev.finance@blockchainff.com", name: "Dev Finance", role: "finance", employmentType: "staff" },
];

async function main() {
  const { db, close } = scriptDb();
  try {
    await db.insert(s.allowedDomains).values([{ domain: "roundtable.io" }, { domain: "blockchainff.com" }]).onConflictDoNothing();

    for (const [i, p] of PIPELINES.entries()) {
      const [row] = await db
        .insert(s.pipelines)
        .values({ key: p.key, type: p.type, name: p.name, description: p.desc, unit: p.unit, color: p.color, defaultRevSharePct: p.rev, sortOrder: i })
        .onConflictDoUpdate({ target: s.pipelines.key, set: { name: p.name, description: p.desc, color: p.color } })
        .returning();
      for (const [j, st] of p.stages.entries()) {
        await db
          .insert(s.stages)
          .values({
            pipelineId: row!.id,
            key: st.key,
            name: st.name,
            sortOrder: j,
            probability: st.p,
            category: st.cat ?? "open",
            slaDays: st.sla ?? null,
            importAliases: st.aliases ?? [],
            requiredFields: st.req ?? [],
          })
          .onConflictDoUpdate({
            target: [s.stages.pipelineId, s.stages.key],
            set: { name: st.name, sortOrder: j, importAliases: st.aliases ?? [] },
          });
      }
    }

    for (const [list, values] of Object.entries(PICKLISTS)) {
      await db
        .insert(s.picklists)
        .values(values.map((v, i) => ({ list, value: v, label: v.replace(/_/g, " "), sortOrder: i })))
        .onConflictDoNothing();
    }

    for (const r of ALERT_RULES) {
      await db
        .insert(s.alertRules)
        .values({ code: r.code, name: r.name, description: r.desc, severity: r.sev, params: r.params ?? {}, escalateAfterHours: r.esc ?? null })
        .onConflictDoNothing();
    }

    const existingProducts = await db.select({ name: s.products.name }).from(s.products);
    const have = new Set(existingProducts.map((p) => p.name));
    const newProducts = PRODUCTS.filter((p) => !have.has(p[1]));
    if (newProducts.length)
      await db.insert(s.products).values(
        newProducts.map(([family, name, pipelineKeys, pricingModel, status]) => ({ family, name, pipelineKeys: [...pipelineKeys], pricingModel, status })),
      );

    const existingClaims = await db.select({ text: s.claims.text }).from(s.claims);
    const haveClaims = new Set(existingClaims.map((c) => c.text));
    const newClaims = CLAIMS.filter((c) => !haveClaims.has(c.text));
    if (newClaims.length)
      await db.insert(s.claims).values(newClaims.map((c) => ({ text: c.text, pattern: c.pattern, status: c.status, approvedAlternative: c.alt, evidence: c.evidence })));

    const existingActors = await db.select({ a: s.actorRegistry.actorId, p: s.actorRegistry.purpose }).from(s.actorRegistry);
    const haveActors = new Set(existingActors.map((a) => `${a.p}:${a.a}`));
    const newActors = ACTORS.filter((a) => !haveActors.has(`${a.purpose}:${a.actorId}`));
    if (newActors.length)
      await db.insert(s.actorRegistry).values(
        newActors.map((a) => ({ purpose: a.purpose, actorId: a.actorId, fallbackOrder: a.order, costPerResultUsd: a.cost, inputTemplate: a.input })),
      );

    for (const [key, value] of Object.entries(SETTINGS)) {
      await db.insert(s.appSettings).values({ key, value: value as never }).onConflictDoNothing();
    }

    const existingTeams = await db.select({ name: s.teams.name }).from(s.teams);
    const haveTeams = new Set(existingTeams.map((t) => t.name));
    for (const t of TEAMS) if (!haveTeams.has(t.name)) await db.insert(s.teams).values(t);

    const existingPlans = await db.select({ name: s.commissionPlans.name }).from(s.commissionPlans);
    const havePlans = new Set(existingPlans.map((p) => p.name));
    for (const p of COMMISSION_PLANS) if (!havePlans.has(p.name)) await db.insert(s.commissionPlans).values(p as never);

    if (process.env.ALLOW_DEV_LOGIN === "true") {
      const hash = await hashPassword(DEV_PASSWORD);
      for (const u of DEV_USERS) {
        const id = crypto.randomUUID();
        const inserted = await db
          .insert(s.user)
          .values({ id, email: u.email, name: u.name, role: u.role, emailVerified: true, employmentType: u.employmentType })
          .onConflictDoNothing()
          .returning({ id: s.user.id });
        if (inserted.length) {
          await db.insert(s.account).values({ id: crypto.randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash });
        }
      }
      console.log(`dev users ready (${DEV_USERS.length}); password is DEV_PASSWORD in scripts/seed.ts — local dev only`);
    }

    const [{ n }] = (await db.execute(sql`select count(*)::int as n from rso.stages`)) as unknown as { n: number }[];
    console.log(`seed complete — ${PIPELINES.length} pipelines, ${n} stages, ${ALERT_RULES.length} alert rules, ${ACTORS.length} actors`);
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error("SEED FAILED:", e);
  process.exit(1);
});
