# PRD: Roundtable Sales OS

**Product:** Roundtable Sales OS ("RSOS"). An AI-native CRM and sales operating system built for RTB Digital, Inc. (dba Roundtable, NASDAQ: RTB).

| | |
|---|---|
| Status | Draft v1.2 for review. v1.1 added decisions D1–D4 and M25 Lead Scout; v1.2 adds D5–D10 (answers to Q1, Q2, Q13, Q14, Q15) and §16A Visual design system. |
| Date | 30 Sep 2026 |
| Author | BFF Research (for RTB) |
| Inputs | (1) `RTB Global Sales Pipeline 9.29.26 [DRAFT]` and `v7 (ranked by MUU)`; (2) `Chris & Will - Roundtable_Master_Pipeline`; (3) `RTB Sites & RTB100 Pipeline (Top 100 list + Media sites…)`; (4) the RTB Knowledge Base (`RTB Knowledge Base/`), in particular chapters 09 (products) and 10 (sales) |
| Approvers | James Heckman (CEO), Bill Sornsin (COO), Aly Madhavji (CFO), Chris Smith (SVP Strategic Partnerships), Will Heckman (SVP Sales) |

---

## Decisions confirmed (30 Sep 2026)

| # | Decision | Effect on this PRD |
|---|---|---|
| D1 | **Every user, including interns and commission-only reps, gets an RTB Google Workspace email.** | Sign-in is restricted to RTB's Workspace domain(s). The Google OAuth app is **Internal**, so Gmail monitoring works for everyone with no Google security assessment. BCC capture is only a convenience. |
| D2 | **"SVR" = SVP / senior sales executive.** | The `sales_leader` role is confirmed as the SVP role. |
| D3 | **Granola is integrated through its API.** | Native Granola ingestion is P0 (CALL-2). The Zapier and paste paths remain as fallbacks only. |
| D5 | **Allowed sign-in domains: `roundtable.io` and `blockchainff.com`** (Q1). | AUTH-2 allowlist seeded with both. The Google OAuth app must be allowed as an internal/trusted app in **both** Workspace tenants. If they are separate Google Workspace organizations, the app is set to External-but-unpublished (testing) or trusted per tenant; see §13. |
| D6 | **Granola uses one API key per person** (Q2). | Each user connects their own Granola key in Settings (USR-1). The key is encrypted and revocable, and ingestion runs per user. |
| D7 | **Lead Scout ICP confirmed** (Q13): NET sweet spot 250K–25M MUU; 10M+ and group-owned brands route to ENT. | SCOUT-9 default weights and routing (SCOUT-15) are final seed values. |
| D8 | **Apify budget for testing: $10 total per month** (Q14). | Org monthly cap $10 during the pilot. Per-run and per-user caps scale down (§M25.8). Cost estimates block any run that would exceed the remaining budget. |
| D9 | **GDPR is out of scope** (Q15). | GDPR-specific features (lawful-basis fields, data-subject requests, EU/UK legitimate-interest workflow) are removed from v1. Basic opt-out/do-not-contact handling stays as good sales practice. |
| D10 | **Visual design: black background, white text, black-and-white RTB design system, pastel chart colors.** Fonts and components follow the Claude Design file "RTB Product Deck (B&W)". | New §16A Visual design system. |
| D4 | **Add a Lead Scout.** It finds good platform-deal targets based on MUU, then lets the seller enrich them to find executive emails, using **Apify actors**. | New module **M25 Lead Scout & Enrichment** (§10), plus its data model, permissions, agent tools, alerts, analytics, admin settings and release phase. |

---

## Table of contents

1. Summary
2. Problem statement and evidence
3. Goals, non-goals, success metrics
4. RTB's sales motions (what the system must model)
5. Product catalog
6. Users, personas and roles
7. Permissions model
8. Information architecture and navigation
9. Data model
10. Functional requirements by module (M01–M25, including M25 Lead Scout & Enrichment)
11. The Smart Agent ("Roundtable Copilot")
12. The proactive engine ("Nothing Slips")
13. Integrations
14. Analytics and reporting
15. Admin customization
16. Non-functional requirements
16A. Visual design system (black/white, Playfair Display + Work Sans, pastel charts)
17. Technical architecture
18. Data migration from the current spreadsheets
19. Release plan and milestones
20. Risks, assumptions, open questions
21. Appendices (status dictionary, permission matrix, alert catalog, AI output schemas, acceptance tests)

---

## 1. Summary

Today RTB runs sales across several disconnected spreadsheets, Trello boards and personal inboxes. That spans five different sales motions: publisher network development, enterprise media platform deals, the sports network, the Roundtable 100 program, and TheStreet sponsorship sales. The team is about 15 people with very different employment types: executives, SVPs on retainer, hourly interns and commission-only reps.

RSOS replaces that stack with one system. At a high level it:
- models each motion in its own pipeline, with its own units: monthly unique users (MUU), dollars, or activations;
- uses one shared account/contact graph with deduplication by domain;
- gives the team a HubSpot-class sales workspace: kanban board, detailed lead card, contacts, import/export, tasks and sequences;
- adds three things spreadsheets can't do:
  - **Inbox intelligence.** Monitors each rep's Gmail, attaches threads to deals, detects progress and commitments, and creates reminders and action items.
  - **Call intelligence.** Ingests transcripts from Granola, Zoom, Google Meet or manual upload, then produces summaries, next steps, follow-up drafts and tasks.
  - **Lead Scout & Enrichment.** Finds high-fit platform-deal targets by MUU, vertical and ownership. Scores and queues them for review. Turns an accepted target into verified executive contacts in one click, using Apify actors.
  - **A proactive "Nothing Slips" engine plus an embedded AI agent.** Watches every deal, contact, promise and payment, and pushes the right action to the right person before things go stale.

Admins customize everything from the UI without code: pipelines, stages, probabilities, fields, layouts, roles, permissions per module, automations, commission plans and agent behavior. Sign-in is Google OAuth via Better Auth, restricted to RTB Google Workspace accounts.

---

## 2. Problem statement and evidence

These pain points come from the spreadsheets supplied.

| # | Problem | Evidence |
|---|---|---|
| P1 | **Fragmented sources of truth.** The same brand appears in 3–5 tabs or files with different statuses. | Consolidating 3 sources removed **1,349 duplicate rows** (Pipeline Assumptions note). NetDev data lives in "NetDev Active Deal Tracking", "NetDev CLEANED Pipeline", "NETDEV Pipeline", "TechFinance", "NewsPolitics", "Strategic", "Sports" and "New Target List". |
| P2 | **Status fields are free text.** Dates, emails and notes end up in the Status column. | "Status" in RTB 100 MASTER contains values like "2026-08-17", "7/20 outreach", "media@wnco.com", "Sheryl forwarded email to PR team". |
| P3 | **Weak ownership.** Shared or ambiguous owners, and typos. | Owners like "Chris/Will", "Erik/Casey", "Kevin/Erik", "Erik (linkedin)/Andres (email)"; rep names "Caey" and "chris". |
| P4 | **No activity history.** "Last touch" only lives inside notes text. | Notes like "followed up 9/28", "sent email 8/19", "call set for 10/1". |
| P5 | **Forecast integrity.** Probabilities are changed in bulk by instruction with no audit trail. | The sports tab got a 100%/90% override "per James Heckman, 29 Sep 2026". Engaged weighted value moved from $424M to $1,020M in one day through re-tiering (KB ch. 10). |
| P6 | **Inconsistent measurement.** The MUU field mixes sources and formats. | '450k', '1.5–2M', '<100K', '100M+'. Similarweb monthly *visits* are imported as MUU and "overstate unique users". |
| P7 | **Different motions are forced into one sheet.** | RTB100 is a "volume game" measured in live accounts, TheStreet in dollars and collections, NetDev in MUU. |
| P8 | **Post-sale work is invisible.** | Migration is tracked "periodically off Trello for exec visibility" (MigrationPrio tab). |
| P9 | **Mixed workforce with no fit-for-purpose access control.** | Interns (hourly), commission-only external reps, SVPs on retainer, executives. |
| P10 | **Commitments made on calls and in email are lost.** | There is no system of record for next steps. Follow-ups depend on memory. |
| P11 | **Claims risk.** RTB is a public company, and sales material has carried unapproved or inconsistent claims. | KB ch. 09/11: for example "paid in 8 seconds / powered by Coinbase", conflicting TheStreet multiples, "$100M audited". |

---

## 3. Goals, non-goals, success metrics

### 3.1 Goals
- **G1.** One system of record for every RTB sales motion, account, contact, activity and deal.
- **G2.** Zero dropped balls. Every open deal always has an owner, a next step and a due date, and a promise made on a call or in email becomes a tracked task within minutes.
- **G3.** Reps spend their time selling, not doing data entry. Email and call capture, summaries, task creation and follow-up drafts are automatic.
- **G4.** Executives get a trustworthy, audited pipeline and forecast, split by motion, with a provenance label on every number.
- **G5.** The business can reconfigure the system (pipelines, fields, roles, automations, commissions) without engineering.
- **G6.** Safe for a listed company: permissioned data, an audit trail, claim guardrails and MNPI controls.
- **G7.** A steady supply of high-fit platform-deal targets. The system finds publishers that fit RTB's profile by audience size (MUU), vertical and ownership, and gives sellers verified executive contacts in one click.

### 3.2 Non-goals (v1)
- Not a marketing-automation or mass-email platform. Sequences are 1:1 rep-sent, not bulk blasts.
- Not an ERP or billing system. It tracks invoices and collections status and can sync with accounting later.
- Not a publisher analytics product. MUU comes from integrations or manual entry; it is not measured by RSOS.
- No native dialer or VoIP in v1 (integration later).
- No native mobile app. The web app is responsive.

### 3.3 Success metrics (90 days after launch)

| Metric | Target |
|---|---|
| Weekly active users / licensed users | ≥ 90% |
| Open deals with a next step and due date | ≥ 95% |
| Median time from call end to summary plus tasks in CRM | ≤ 10 min |
| Promises detected by the AI that become tasks and are completed on time | ≥ 80% |
| Deals with no activity for more than the stage SLA | ≤ 5% |
| Inbound prospect emails unanswered after 24 business hours | ≤ 2% |
| Duplicate accounts (same normalized domain) | 0 |
| Spreadsheets still used for pipeline | 0 |
| Rep-reported admin time saved | ≥ 5 hours/week per rep |
| Lead Scout candidates accepted into pipeline per month | ≥ 200, with ≥ 30% of accepted targets reaching "In Comms" within 60 days |
| Enriched executive emails that verify as deliverable | ≥ 85% (bounce rate < 3%) |
| Median cost per accepted, enriched target | ≤ $0.50 in Apify spend (pilot budget $10/month, D8) |
| Forecast changes with an audit reason | 100% |

---

## 4. RTB's sales motions (what the system must model)

RSOS models each motion as its own **pipeline type**. Each type has its own stages, value unit, fields and card layout. All motions share Accounts and Contacts, so one brand can be in several motions at once (for example Polygon is both an RTB100 company and a TheStreet sponsor).

| Code | Motion | What is sold | Primary unit | Typical owners | Current source tabs |
|---|---|---|---|---|---|
| **NET** | **Network Development (NetDev)**: independent and mid-size publishers joining the Roundtable coalition platform | Platform migration: CMS, AI clone, syndication, ad stack. 50/50 revenue share after a ramp; monthly guarantee in some cases | **MUU** → pipeline revenue ($/MUU × MUU) | Interns, SDRs, SVPs, commission-only reps | NetDev Active, NetDev CLEANED, NETDEV Pipeline, TechFinance, NewsPolitics, New Target List, NetDev Spanish Targets |
| **ENT** | **Enterprise Media / Strategic Platform Partnerships**: large groups (NY Post, Reach plc, Baltimore Sun, Sinclair, GB News, HT Media, Arena/Paradium) | Full-stack takeover under a multi-year platform agreement. RTB funds platform costs, splits revenue (40–50%) and gives a profit guarantee | MUU, **gross revenue, RTB net share**, EBITDA uplift | CEO, COO, SVP Strategic Partnerships, CFO | Strategic, Pipeline Master (Top 10 / priority rows), proposals (NY Post, Baltimore Sun pro formas) |
| **SPT** | **Roundtable Sports Network**: fan and team sites | Channel on roundtable.io/sports, 50/50 split, $1K–$15K monthly guarantee in some contracts | MUU | Sports reps (Kade, Yousef, SW source) | Sports tab (team, sport/league, priority) |
| **R100** | **Roundtable 100**: public companies and token projects getting live RTB100 profiles and channels | Profile activation, channel posts, executive interview, editorial placement on TheStreet | **Live accounts** (goal: 100). Participation months 1–3, post count | Interns (Kevin), SDRs, Chris/Will, Mariah, Daniel, Erik | RTB 100 MASTER (≈6,300 rows), RTB 100 Editorial Outreach, RTB 100 (activation tracker), RTB100 Interviews |
| **ADS** | **TheStreet / Media Sponsorship & Advertising**: crypto/fintech brands buying sponsorships and packages | Sponsorship packages and campaigns on TheStreet Crypto / Roundtable | **$ contract value**, annualized value, collections | Chris, Will, Ben Johnson (commission), SVPs | TheStreet tab (Active Deal / Current Client / Warm Deal) |
| **PAY** *(attach)* | **Media Liquidity Pool / real-time payments** | Receivables advance / early settlement for partner publishers | $ advanced, fee % | CFO, CTO | New. Attach-motion on NET/ENT accounts |
| **CNT** *(optional)* | **Content & creator partnerships** | Contributor or influencer channels (e.g. Mario Nawfal, Scott Melker) | Channel count, MUU | Editorial | Content Providers agreements |

After a NET, ENT or SPT deal is won, it hands off to a **Migration/Onboarding** workflow (section 10, M15). That replaces the Trello and MigrationPrio tracking.

---

## 5. Product catalog (admin-managed)

Every deal line references catalog items. The catalog is fully editable in Admin, and the list below is the seed. Each item carries:
- name, SKU and description;
- which motions can sell it;
- pricing model: revenue share %, fixed fee, CPM, package price, or free;
- default terms (ramp months, guarantee range, contract term);
- **approved claims**: a list of the exact product claims reps and the AI may use, each with its evidence link and an approver;
- linked collateral (decks, one-pagers).

| Family | Items |
|---|---|
| **Platform** | Full-stack platform (CMS, hosting); AI site clone and archive migration ("AI Import"); video platform; community/comments with AI moderation; apps; identity and membership; reporting and analytics; ad stack / GAM management / direct sales |
| **Distribution** | Syndication (Yahoo, MSN, Apple News and others); Roundtable network channel; cross-coalition content sharing |
| **Monetization** | Programmatic yield; direct-sold campaigns; affiliate/commerce; subscriptions and membership |
| **Payments** | Media Liquidity Pool (early settlement / receivables advance); real-time payouts (USDC rails), labeled "beta/upcoming" until approved |
| **Roundtable 100** | RTB100 profile; RTB100 channel/posting; executive interview (video); editorial power-ranking placement; token-profile variants (e.g. "HIVE100") |
| **TheStreet sponsorship** | Crypto section sponsorship; newsletter; podcast redistribution; event/Cannes packages; custom content |
| **Commercial constructs** | Revenue-share tier (50/50 standard, 40% for Arena-type deals); publisher guarantee ("≥ today's profit" or $X/month); ramp period (0–6 months at 100% to partner); cost takeover (vendors/staff funded by RTB) |

---

## 6. Users, personas and roles

| Persona | Examples today | Employment | Primary jobs | Default role |
|---|---|---|---|---|
| **Super Admin** | Head of RevOps / BFF systems owner | Staff | Configure everything, manage users, integrations, security | `super_admin` |
| **Admin / RevOps** | Ops lead | Staff | Pipelines, fields, imports, dedupe, automations, reports | `admin` |
| **Executive** | James Heckman (CEO), Bill Sornsin (COO), Aly Madhavji (CFO) | Exec | Company-wide view, forecast, approvals (revenue-share floors, guarantees, overrides), own strategic deals | `executive` |
| **Sales Leader / SVP** ("SVR" in the brief is read as SVP; see §20) | Chris Smith (SVP Strategic Partnerships), Will Heckman (SVP Sales) | Retainer | Own ENT and ADS deals, manage the team, assign leads, coach, approve discounts within limits | `sales_leader` |
| **Account Executive / Partnership Manager** | Future hires | Staff | Run qualified deals to close | `ae` |
| **SDR** | Future hires; interns doing outreach | Staff/hourly | Prospect, research, outreach, book meetings, qualify, hand off | `sdr` |
| **Intern** | Kevin Glaittli (RTB100 onboarding), Andres Simbeck and Casey Bohrer (NetDev and Street) | Hourly | Research, data entry, outreach under supervision, RTB100 onboarding | `intern` |
| **Commission-only rep (external)** | Erik Lew (automated outreach), Ben Johnson (Street sales/referrals), Mariah Crom and Daniel Alecio (editorial C-suite relationships) | 1099 / external | Register and work their own leads, see only their own book and commission statements | `commission_rep` |
| **Onboarding / Migration specialist** | Liz (clones), engineering | Staff | Run post-sale migrations | `onboarding` |
| **Finance** | CFO office | Staff | Invoices, collections, commission approval and payout | `finance` |
| **Editorial / Content** | Jackson (RTB100 interview host) | Staff | RTB100 interviews, posts, editorial links | `editorial` |
| **Viewer** | Board observer, auditor | — | Read-only dashboards | `viewer` |

Roles are **templates**. Admins can clone, rename and edit them and create new ones. A user can hold one primary role plus additive **permission sets**, for example "Intern + Sports pipeline access".

---

## 7. Permissions model

### 7.1 Structure
Permissions are evaluated as **Module × Action × Scope**, plus optional field-level rules and record-level sharing.

- **Modules**: every item in §10 (Accounts, Contacts, Deals per pipeline type, Kanban, Activities, Email, Calls, Agent, Proposals, Migration, RTB100, Ads & Revenue, Commissions, Analytics, Import/Export, Admin, Audit).
- **Actions**: `view`, `create`, `edit`, `delete`, `assign/reassign`, `export`, `import`, `approve`, `configure`, `use_ai`.
- **Scopes**:
  - `none`;
  - `own` (records where the user is owner or collaborator);
  - `team` (records owned by anyone in the user's team or teams);
  - `pipeline` (all records in specific pipeline types);
  - `all`.
- **Field-level security**: a field can be marked *hidden*, *read-only* or *editable* per role. Examples:
  - revenue-share %, guarantee amounts and pro forma financials are hidden from `intern` and `commission_rep`;
  - commission amounts are visible only to the rep themselves, their manager and finance.
- **Record-level sharing**: a record can be shared manually with users or teams, at view or edit level.
- **Sensitive-record flag ("Restricted / MNPI")**: restricted records (e.g. Arena/Paradium, M&A-adjacent enterprise deals) are visible only to an explicit access list, whatever the role scope. Every access is logged.

### 7.2 Enforcement
- Enforced **server-side on every query and mutation**, including AI-agent tool calls. The agent acts with the permissions of the user it is acting for; background jobs use a scoped service identity (§11.6).
- Search, analytics, exports and AI retrieval all apply the same filters.
- Permission changes take effect immediately and are audit-logged.

The default permission matrix is in Appendix B.

---

## 8. Information architecture and navigation

Left navigation, filtered by the user's permissions:
1. **Home / My Day**: today's tasks, alerts, meetings (with AI prep), deals needing action, inbox items awaiting reply, the agent's suggested actions.
2. **Pipelines**: one board per pipeline type (NetDev, Enterprise, Sports, RTB100, TheStreet Ads, Payments), plus "All my deals".
3. **Accounts**: media brands and companies, with parent groups.
4. **Contacts**.
5. **Activities**: tasks, calls, meetings, emails, notes.
6. **Inbox**: synced Gmail threads linked to CRM records, triaged by the AI.
7. **Calls**: transcript library.
8. **Proposals**: pro formas and proposal packages.
9. **Onboarding**: the migration board.
10. **Roundtable 100**: program view.
11. **Revenue**: ad deals, invoices, collections, renewals.
12. **Commissions**.
13. **Analytics**: dashboards and report builder.
14. **Copilot**: full-page agent chat (also available as a side panel everywhere).
14a. **Lead Scout**: target discovery, scoring, review queue, enrichment (M25).
15. **Admin** (admins only).

Global UI:
- **⌘K command palette**: search anything, create records, run agent commands.
- Notification center.
- Quick-add.
- A Copilot side panel that knows the current record as context.

---

## 9. Data model (core entities)

All entities carry `id`, `created_at/by`, `updated_at/by`, `owner_id`, `team_id`, soft-delete, `source`, `custom_fields (jsonb)`, and a full field-history audit.

| Entity | Key fields |
|---|---|
| **Organization** (tenant) | RTB. Multi-tenant ready but single-tenant in v1 |
| **User** | Better Auth user, role, permission sets, teams, manager, employment type (staff/retainer/hourly/commission), timezone, working hours, connected accounts (Google, Zoom, Granola), quota |
| **Team** | Name, lead, members, pipelines covered, territory (region/language/vertical) |
| **Account** (brand/company) | Name; **primary domain (normalized, unique)**; alternate domains; parent account (group, e.g. News Corp → NY Post); type (Publisher, Media Group, Public Company, Token Project, Advertiser, Agency, Partner); category/vertical (Finance, Crypto, Politics, AI, Emerging Tech, Sports, Military/Defense…); sport/league/team (sports); country, region, language; ownership (Independent / group name); **ticker**, **token name** (RTB100); B2C flag; market cap; website, press page, PR email, LinkedIn; lifecycle status (Target → Prospect → Customer → Churned); account tier/priority (Top 10, 2-High, 1-Medium, 0-Low) |
| **Audience Metric** (time series) | account_id, metric (MUU, monthly visits, pageviews), value, period, **source** (Similarweb, GA, Comscore, self-reported, BFF estimate, manual), **confidence** (verified/estimated), raw input string (e.g. "1.5–2M"), parsed value, entered_by |
| **Contact** | Name, title, seniority, account(s), emails (multiple, primary flag), phones, LinkedIn, relationship owner (e.g. "Will POC"), role in deal (Decision maker, Champion, Influencer, Legal, Tech, Blocker), status (Active/Left company), last contacted, consent/unsubscribe flags, notes |
| **Deal** (opportunity) | pipeline_type, stage, status (Open/Won/Lost/On hold), account, primary contact, stakeholders[], owner, collaborators[], **split[]** (user, %), source (inbound, outbound, referral, event, commission rep registration), priority, expected close date, next step (text + due date, **required while Open**), lost reason, products[] (catalog lines); **value fields** by type (below); probability (stage default or override) plus override reason and approver; weighted value; health score (AI); restricted flag |
| — NET/SPT/ENT value fields | MUU (from latest Audience Metric or override), $/MUU (default from Admin, $1.00), **pipeline gross revenue** = MUU × $/MUU, revenue share % to RTB, **RTB net revenue**, guarantee (type, amount/month, term), ramp months, contract term (years), cost takeover amount, pro forma link |
| — ADS value fields | Contract value, billing schedule, next payment amount/date, annualized value, currency, campaign start/end, IO number, renewal date |
| — R100 value fields | Program status, first post date, participation (month 1/2/3 booleans), channel post count, profile URL, executive interview (guest, host, status, filmed date, publish date), editorial links[], bonus eligibility |
| — PAY value fields | Receivable amount, advance %, fee %, settlement date |
| **Stage** | pipeline_type, name, order, default probability, category (Open/Won/Lost/Hold), SLA days, entry requirements (required fields, docs, approvals), exit automations |
| **Activity** | type (Email, Call, Meeting, Note, Task, LinkedIn touch, Stage change, System), subject, body/summary, participants, related records (many-to-many: deal/account/contact), timestamp, direction, source (Gmail, Zoom, Granola, Meet, manual, agent) |
| **Task / Reminder** | title, due at, assignee, related record, priority, origin (manual, AI-from-email, AI-from-call, rule, sequence), evidence link (quote plus source), status, snooze history, escalation state |
| **Email Thread / Message** | Gmail thread and message IDs, mailbox owner, participants, subject, snippet, body (stored per retention policy), labels, linked records, AI classification (intent, sentiment, commitment detected, awaiting reply), tracking (opens and clicks, if enabled) |
| **Meeting** | calendar event ID, time, attendees, linked deal, prep brief, transcript_id, recording URL |
| **Transcript** | source (Granola/Zoom/Meet/upload), raw text, speakers, duration, language, file ref (Blob), processing status, AI outputs (summary, action items, decisions, objections, qualification, next steps, risks, sentiment), linked meeting/deal |
| **Document** | type (NDA, Contract, Proposal, Pro forma, Deck, IO, Invoice), file, version, status (Draft/Sent/Signed/Expired), signed date, expiry, linked deal |
| **Proposal / Pro Forma** | deal, template, inputs (revenue scenario, cost stack, revenue-share %, guarantee), computed outputs, version, approval state, exported PDFs |
| **Migration Project** | deal, account, stage (Discovery → Scoping → Clone built → Content migrated → QA → Launched → Live/Hypercare), launched flag, go-live date, engineering owner, checklist, blockers, clone URL, live URL |
| **Invoice / Collection** | deal, amount, due date, status (Scheduled/Sent/Paid/Overdue/Written off), paid date, payer |
| **Commission Plan / Rule / Statement** | plan (rate tables, triggers, caps, clawback), participant assignments, accruals, adjustments, statements, approval, payout status |
| **Sequence** | steps (email/task/LinkedIn), delays, exit conditions, enrollments |
| **Automation Rule** | trigger, conditions, actions, owner, enabled, run log |
| **Alert** | rule, record, recipient, severity, state (open/acknowledged/resolved/escalated), timestamps |
| **Snapshot** | nightly pipeline snapshot (for forecast history and change audit) |
| **Audit Log** | actor (user/agent/system), action, entity, before/after, IP, timestamp |
| **Scout Search** | name, owner, criteria (vertical, country, language, MUU min/max, ownership type, tech-stack signals, seed domains for lookalikes, keywords), sources/actors to use, schedule (one-off/weekly), budget cap, status, run history |
| **Scout Candidate** | search_id, domain (normalized), name, category, country, language, MUU estimate plus source and confidence, traffic trend (3/6/12 months), tech stack, ownership/group, **Fit Score (0–100)** with factor breakdown and explanation, est. pipeline value (MUU × $/MUU), CRM match (new / existing account / existing open deal and owner), state (New → Accepted / Rejected / Snoozed / Duplicate), reject reason, reviewer |
| **Enrichment Run** | account_id, requested_by, actors used (with Apify run IDs), target roles, status, cost (USD), results count, verified count, started/finished, errors |
| **Enriched Contact (staging)** | account_id, name, title, seniority, department, LinkedIn URL, email, email source (website / pattern+SMTP / LinkedIn finder / leads DB), **verification status** (valid, risky/catch-all, invalid, unknown), confidence, found_at; promoted to Contact on accept |
| **Actor Registry** | purpose (traffic, discovery, tech stack, people, email finder, email verify, contact page), Apify actor ID, version, input template (JSON with placeholders), output field mapping, cost per result, timeout, enabled, fallback order |
| **Claim Library** | claim text, product, status (approved/restricted/banned), evidence, approver, expiry |

---

## 10. Functional requirements by module

Priority: **P0** = MVP, **P1** = v1.1, **P2** = later.

### M01. Authentication and identity (Better Auth)
- **AUTH-1 (P0)** Sign in with **Google** via Better Auth's Google social provider. No passwords in v1.
- **AUTH-2 (P0)** Domain restriction. **Only accounts on `roundtable.io` or `blockchainff.com` can sign in** (D1, D5). The allowlist is admin-editable. This applies to every role, including interns and commission-only reps. It is enforced server-side (email domain and `hd` claim), not just by the login hint. New users are auto-provisioned on first login with the `pending` role until an admin assigns a role. Non-RTB Google accounts are always rejected.
- **AUTH-3 (P0)** Admin pre-provisioning: an admin creates the user against their RTB Workspace email with role, team, employment type, commission plan and optional expiry date (for interns and contractors). On first Google sign-in the pre-assigned role applies immediately. Suspending the user in Google Workspace also blocks sign-in on the next session check.
- **AUTH-4 (P0)** Sessions: secure HTTP-only cookies, idle timeout configurable (default 12h), forced re-auth for sensitive admin actions, "sign out all sessions".
- **AUTH-5 (P0)** Incremental Google scopes. Base login requests `openid email profile`. Connecting Gmail and Calendar is a **separate, explicit step** ("Connect inbox") that requests additional scopes. Tokens are stored encrypted, refreshed automatically and revocable by the user or an admin.
- **AUTH-6 (P0)** Deactivation. An admin deactivates a user → sessions revoked, tokens revoked, mailbox sync stopped, open records queued for **reassignment wizard**.
- **AUTH-7 (P1)** Admin **impersonation** ("view as") for support, fully audit-logged, with read-only by default.
- **AUTH-8 (P1)** Optional 2FA (TOTP) enforced for `admin`, `executive` and `finance`.
- **AUTH-9 (P2)** SAML/OIDC SSO for enterprise identity providers.

### M02. Accounts
- **ACC-1 (P0)** Create, edit and view accounts. The domain is normalized (strip protocol, `www.`, path and trailing slash; lowercase) and **unique**. Alternate domains map to the same account.
- **ACC-2 (P0)** Parent/child hierarchy (group → brands) with a roll-up of MUU and pipeline.
- **ACC-3 (P0)** Audience metrics panel: MUU history chart; source and confidence badges; "estimated" styling for research estimates.
- **ACC-4 (P0)** Account 360: all deals across motions, contacts, activity timeline, documents, migration status, RTB100 status, invoices.
- **ACC-5 (P0)** Duplicate detection on create, import and email capture (domain, fuzzy name, shared contacts), with a merge tool that keeps history.
- **ACC-6 (P1)** Enrichment on demand: company data, logo, social, tech stack, estimated traffic. Provider pluggable (e.g. Apollo, Clearbit, Similarweb API). Enrichment values are stored as source = provider.
- **ACC-7 (P1)** Territory assignment rules by region, language, vertical and league.
- **ACC-8 (P0)** Lead registration / ownership protection for commission reps (see COM-6).

### M03. Contacts
- **CON-1 (P0)** CRUD; multiple emails and phones; LinkedIn; title; seniority; multiple accounts (for people who move between brands).
- **CON-2 (P0)** Relationship owner separate from deal owner (e.g. "Will POC" on HIVE).
- **CON-3 (P0)** Buying-committee role per deal, and a **stakeholder map** on the deal card.
- **CON-4 (P0)** Auto-create or suggest contacts from email and calendar participants (the agent proposes; user or admin policy decides auto vs confirm).
- **CON-5 (P1)** Job-change detection (email bounces, new signature, enrichment) → alert the owner.
- **CON-6 (P0)** Do-not-contact and unsubscribe flags honored by sequences and the agent.

### M04. Deals and pipelines
- **DEAL-1 (P0)** Multiple pipeline types (NET, ENT, SPT, R100, ADS, PAY, plus custom), each with its own stages, fields, layouts and value logic (§9).
- **DEAL-2 (P0)** Stage gates. Admins define required fields, documents or approvals to enter a stage. Examples:
  - ENT "Proposal Sent" requires a pro forma v≥1;
  - "Contract" requires a signed NDA;
  - ADS "Won" requires contract value and billing schedule.
- **DEAL-3 (P0)** **Next step + due date required** for all Open deals. Saving without one is blocked, or allowed with a reason ("Waiting on client until …").
- **DEAL-4 (P0)** Probability: the stage default from Admin (seeded from the 100/90/50/10 scheme, Appendix A), or a **per-deal override** with a mandatory reason. Overrides above a configurable threshold (e.g. +30 points, or any bulk override) need **executive approval**. Overrides are flagged on every report.
- **DEAL-5 (P0)** Value calculation per type. MUU-based deals compute gross pipeline revenue = MUU × $/MUU, **RTB net** = gross × RTB share %, and weighted = value × probability. Reports let users choose gross or net and always label which one is shown.
- **DEAL-6 (P0)** Splits. Multiple owners with % credit (replaces "Chris/Will"). The primary owner is accountable for next steps.
- **DEAL-7 (P0)** Won/Lost/Hold with a required reason (picklist + text). Won NET/ENT/SPT deals trigger an onboarding project (M15). Won ADS deals trigger invoice schedule creation.
- **DEAL-8 (P0)** Deal health score (0–100), computed by the agent from recency, next-step status, stakeholder coverage, email sentiment, stage age vs SLA and call signals, with an explanation.
- **DEAL-9 (P1)** Deal rooms: shareable external page per ENT deal (proposal, docs, mutual action plan) with view tracking.
- **DEAL-10 (P1)** Mutual action plan (MAP) template per ENT deal, with milestones shared with the client.
- **DEAL-11 (P0)** Multiple deals per account across motions. Cross-sell suggestions (e.g. an RTB100 company → ADS sponsorship; a NET publisher → PAY).

### M05. Kanban board
- **KAN-1 (P0)** Board per pipeline with drag-and-drop between stages. Stage gates and required-field modals appear on drop.
- **KAN-2 (P0)** Card shows: account logo/name, value (MUU or $), weighted value, owner avatar(s), next step and due date (red if overdue), days in stage, health badge, priority tag, restricted lock icon.
- **KAN-3 (P0)** Swimlanes by owner, priority, category/vertical, region or league. Column totals: count, MUU, gross, net, weighted.
- **KAN-4 (P0)** Filters and saved views (personal or shared): owner, team, tier, category, source, health, overdue, created date, last activity, custom fields.
- **KAN-5 (P0)** Bulk actions: reassign, change stage (gated), add tag, enroll in sequence, export (permissioned).
- **KAN-6 (P1)** WIP limits per stage and per rep, with warnings.
- **KAN-7 (P0)** Quick-view side panel on card click, with inline edit.
- **KAN-8 (P0)** Performance: a board with 2,500 cards renders in under 1.5s (virtualized columns).

### M06. Lead / deal detail card (record page)
- **CARD-1 (P0)** Header: name, domain link, stage path (clickable), value block (MUU/gross/net/weighted or $), owner(s), health, next step, key dates, quick actions (log call, email, task, upload transcript, generate proposal, ask Copilot).
- **CARD-2 (P0)** **AI summary box**, refreshed on every new activity: where the deal stands, last touch, open commitments (ours and theirs), risks, recommended next action. Each claim links to its source (email or transcript quote).
- **CARD-3 (P0)** Unified timeline: emails (threaded), meetings, transcripts, calls, notes, tasks, stage and field changes, agent actions. Filterable, with pinned notes.
- **CARD-4 (P0)** Stakeholders panel: contacts with deal roles, last touch per contact, coverage gaps (e.g. "no economic buyer engaged").
- **CARD-5 (P0)** Tasks panel: open tasks with origin and evidence, and a "promises" list split into *We owe* and *They owe*.
- **CARD-6 (P0)** Documents panel: NDA, contract, proposals, decks; status and expiry; upload or link (Google Drive).
- **CARD-7 (P0)** Type-specific panels: MUU history (NET/SPT/ENT); pro forma (ENT); RTB100 activation tracker (R100); billing schedule and collections (ADS); migration status (post-won).
- **CARD-8 (P0)** Custom field sections and layout configurable per pipeline and role (§15).
- **CARD-9 (P1)** "Meeting prep" tab, generated before each scheduled meeting: attendees, history, open items, suggested agenda, relevant proof points from the **approved** claim library, likely objections and rebuttals (from RTB's objection library).
- **CARD-10 (P0)** Comments with @mentions and notifications.

### M07. List and table views
- **LIST-1 (P0)** Spreadsheet-style grid for accounts, contacts, deals and tasks: inline edit, column chooser, sort, group, filter, saved views.
- **LIST-2 (P0)** Mass edit with permission checks and an audit trail.
- **LIST-3 (P1)** Formula and roll-up columns (read-only, admin-defined).

### M08. Data import, export and sync
- **IMP-1 (P0)** Import CSV/XLSX (multi-sheet) through a wizard: pick sheet → map columns to fields (auto-suggested by AI and header similarity) → preview → validate → import. Mappings can be saved as templates.
- **IMP-2 (P0)** **MUU parsing rules** (configurable): '450k' → 450,000; '1.5–2M' → 1,750,000 (midpoint); '100M+' → 100,000,000; '<100k' → 50,000; 'N/A', '—' or blank → null. The raw string is kept and the source recorded (e.g. "Similarweb visits" ≠ MUU).
- **IMP-3 (P0)** Status normalization. Free-text statuses are mapped to stages through an admin-editable mapping table (Appendix A). Values that aren't statuses (dates, emails, notes) are detected and moved to Notes or Last Contacted rather than set as a stage.
- **IMP-4 (P0)** Owner normalization. "Chris/Will" becomes a split; typos ("Caey", "chris") are mapped through a fuzzy-matched user map; unknown owners go to a review queue.
- **IMP-5 (P0)** Dedupe on import by normalized domain, then fuzzy name. Merge policy is configurable (e.g. keep the most advanced stage; source priority Strategic > Active > Pipeline, as in the current consolidation).
- **IMP-6 (P0)** Import history with row-level results and **one-click rollback** of an import batch.
- **IMP-7 (P0)** Export (CSV/XLSX), permission-gated and watermarked with the user and timestamp. Interns and commission reps have no export by default.
- **IMP-8 (P1)** Two-way Google Sheets sync for selected views (transition period), with conflict resolution (CRM wins by default).
- **IMP-9 (P1)** Scheduled imports (e.g. a weekly Similarweb traffic file updates Audience Metrics).
- **IMP-10 (P0)** Public REST API and webhooks for all core entities (API keys scoped by role).

### M09. Activities, tasks, reminders, sequences
- **ACT-1 (P0)** Log call, meeting, note or LinkedIn touch manually; quick-log from the card or ⌘K.
- **ACT-2 (P0)** Tasks with due date/time, assignee, priority, related record, recurrence, reminders (in-app, email, Slack, and Google Calendar block, optional).
- **ACT-3 (P0)** Snooze with a reason. Repeated snoozes (≥3) escalate to the manager.
- **ACT-4 (P0)** Task origins tracked (manual / email-AI / call-AI / rule / sequence), with the evidence quote.
- **ACT-5 (P1)** Sequences: multi-step 1:1 cadences (email from the rep's Gmail, call tasks, LinkedIn tasks), with auto-exit on reply, meeting booked, stage change or unsubscribe. Per-day send caps per mailbox to protect deliverability.
- **ACT-6 (P0)** Calendar sync (Google Calendar): meetings with known contacts auto-link to deals; external meetings with unknown attendees prompt "create lead?".
- **ACT-7 (P1)** Meeting scheduling links (rep availability) inserted into emails.

### M10. Email intelligence (Gmail)
**Objective A:** monitor each user's email for progress on deals, and set reminders and action items after calls.
- **EML-1 (P0)** A user connects their Gmail with explicit consent (AUTH-5). Admins can require connection for certain roles.
- **EML-2 (P0)** Sync: initial backfill (configurable, default 90 days) plus near-real-time updates via Gmail push notifications (Pub/Sub `watch`), with incremental history sync as fallback.
- **EML-3 (P0)** **Relevance filter.** Only threads involving a known contact or account domain, or a domain on the pipeline target list, are ingested. Personal and blocked domains are ignored. The user can mark a thread "private / don't log" and blocklist senders. Admins set org-wide rules (e.g. ignore `@gmail.com` unless the contact exists).
- **EML-4 (P0)** Auto-link threads to account, contact and deal. If ambiguous, the agent proposes a link and the user confirms.
- **EML-5 (P0)** AI analysis of each relevant inbound and outbound message:
  - intent (interested, objection, scheduling, contract/legal, pricing, not interested, OOO, referral);
  - **commitments** ("I'll send the contract Friday", "we'll get back to you after the board meeting");
  - **progress signals** (NDA signed, legal review started, demo requested, pricing asked);
  - **awaiting-reply state** (which side owes the next message);
  - **stage-change suggestion** with confidence and evidence.
- **EML-6 (P0)** Resulting actions, each governed by an admin-configured automation level (§11.4):
  - create tasks and reminders for *our* commitments;
  - create "waiting on them" reminders for *their* commitments (nudge if the date passes);
  - update next step;
  - suggest (or auto-apply, if permitted) stage changes;
  - log activity.
- **EML-7 (P0)** Unanswered-inbound detection. A prospect email with no reply after X business hours (default 24) → alert the owner. After 48h → escalate to the manager (configurable).
- **EML-8 (P0)** Send from the CRM through the user's Gmail (thread-preserving), with templates, merge fields, the approved-claims check (§11.5) and optional open/click tracking (off by default for enterprise/ENT).
- **EML-9 (P1)** **BCC / forward capture address** (e.g. `log@crm.roundtable.io`), for one-off logging, e.g. emails sent from a phone client before sync catches up or threads forwarded from a colleague. Since every user has an RTB Workspace mailbox (D1), this is a convenience, not the primary capture path.
- **EML-12 (P0)** **Connecting Gmail is mandatory** for the roles `sales_leader`, `ae`, `sdr`, `intern` and `commission_rep`. Onboarding isn't complete until the mailbox is connected, and a broken connection raises NS-30.
- **EML-10 (P1)** Shared inboxes (e.g. partnerships@, rtb100@) with assignment rules.
- **EML-11 (P0)** Privacy:
  - body retention policy is configurable (default: store bodies of linked threads only; purge unlinked after 7 days);
  - a manager sees a rep's *linked* deal emails only if their scope covers that deal;
  - personal threads are never visible.

### M11. Calls, meetings and transcripts
**Objective B:** link to Granola or Zoom transcripts, or accept manual uploads.
- **CALL-1 (P0)** **Zoom.** Connect the org (admin) or user account. Ingest cloud-recording transcripts automatically when the recording's transcript completes (Zoom webhook). Match to a meeting and deal by calendar event, attendee emails and time window.
- **CALL-2 (P0)** **Granola (native API, D3, D6).** Each user adds **their own Granola API key** in Settings. It is stored encrypted, validated on save, and revocable; a broken or expired key raises NS-30. The system polls and/or receives Granola note events through the Granola API and pulls, for each meeting:
  - the enhanced notes and the full transcript;
  - attendees and the meeting time.

  Matching to the calendar event and deal works as for Zoom. Notes already ingested are updated when edited in Granola (versioned). Fallbacks, used only if the API is unavailable: the Zapier "note created" trigger, or pasting a share link or transcript. Build task: confirm the API's auth model, rate limits and event/webhook support against RTB's plan at the start of Phase 2.
- **CALL-3 (P1)** **Google Meet.** Ingest Meet transcripts and recordings from Google Drive (Meet artifacts) for users with Workspace transcription enabled.
- **CALL-4 (P0)** **Manual upload.** .txt, .vtt, .srt, .docx, .pdf, .md, or paste text. Audio/video (.mp3, .m4a, .wav, .mp4) is transcribed by a speech-to-text provider, with speaker diarization when available. Max 4 hours or 2 GB, via direct-to-storage upload.
- **CALL-5 (P0)** Attach a transcript to a deal, or let the agent suggest one from participants and content.
- **CALL-6 (P0)** **Post-call processing**, within 5 minutes of ingest. Schema in Appendix D. Outputs:
  - executive summary (5 bullets);
  - decisions made;
  - **action items** (owner = us/them/specific person, due date if stated or inferred, evidence quote with timestamp);
  - objections raised, with RTB's recommended rebuttals;
  - qualification update (RTB framework: MUU/traffic confirmed, decision maker, current stack/vendors, pain, timeline, budget or revenue-share appetite, legal/NDA status, migration complexity);
  - competitor mentions;
  - risks;
  - sentiment;
  - **suggested stage change**;
  - **draft follow-up email** in the rep's voice;
  - fields to update (MUU, contacts, dates).
- **CALL-7 (P0)** One-click **"Apply"** review screen: accept, edit or reject each task, field update, stage change and email draft. Accepted items are created with origin "call-AI" and linked evidence.
- **CALL-8 (P0)** Missing-notes detector: a meeting with an external contact that ended more than 2h ago with no transcript or notes → prompt the owner ("Upload transcript or log notes").
- **CALL-9 (P1)** Transcript search across all calls the user can see ("where did anyone discuss guarantees with Reach?").
- **CALL-10 (P1)** Coaching insights: talk ratio, questions asked, next step secured (yes/no), per rep and trended.
- **CALL-11 (P0)** Consent. Recording and transcription notices are the user's responsibility. The system shows a configurable consent reminder and stores a consent flag per meeting.

### M12. Smart agent (Copilot): see §11

### M13. Proactive engine ("Nothing Slips"): see §12

### M14. Proposals and pro formas
- **PRO-1 (P0)** Pro forma builder for ENT deals, based on RTB's client pro forma playbook and the NY Post / Baltimore Sun templates.
  - **Inputs:** client revenue scenario (by line: display, programmatic, direct, subscriptions, commerce, syndication); cost stack by vendor/function (CMS, video, ad-ops, engineering, membership…); RTB-funded costs; revenue-share %; guarantee type ("≥ trailing-12-month digital operating profit", or fixed $/month); ramp; term.
  - **Outputs:** client EBITDA before/after, uplift, RTB share, client net, guarantee exposure, multi-year view.
- **PRO-2 (P0)** Versioning, a diff between versions, and a lock once sent.
- **PRO-3 (P0)** Approval workflow. For example: revenue share below the floor (configurable, e.g. <40%), a guarantee above $X, or term above N years → requires executive approval before export or send.
- **PRO-4 (P0)** Export a branded 1-pager, 2-pager and proposal package (PDF/PPTX) from templates. "TBD" masking for fields the exec chooses to withhold (e.g. the commission rate).
- **PRO-5 (P1)** Proposal letter generator (AI draft from deal context plus the approved claim library), with human edit.
- **PRO-6 (P1)** E-signature integration (e.g. DocuSign or Dropbox Sign) for NDAs and contracts. Status syncs to Documents and triggers stage gates.

### M15. Migration / onboarding (post-sale)
- **ONB-1 (P0)** A won NET/ENT/SPT deal auto-creates a Migration Project from a template checklist. Stages: Discovery → Scoping → Clone built → Content migrated → QA → Launched → Hypercare/Live. The "Launched?" flag replaces the MigrationPrio tab.
- **ONB-2 (P0)** Kanban and table views; owner (engineering/onboarding); blockers; target and actual go-live; clone and live URLs.
- **ONB-3 (P0)** Alerts on stalls (no progress in N days per stage) and on slipped go-live dates.
- **ONB-4 (P1)** Trello import and one-way sync during transition.
- **ONB-5 (P1)** After launch, track live MUU and revenue (manual or integration) and first-payout date → feeds the customer health view.

### M16. Roundtable 100 program
- **R100-1 (P0)** Program board. Stages: Target → Outreach → Warming Up → Hot → Onboarding (Profile setup) → **Profile Activated** → **Made First Post** (= Live) → Active (monthly participation) → Lapsed. Plus "Relationship already" (fast-track) and "Cold – keep comms".
- **R100-2 (P0)** Company fields: ticker, token name (e.g. HIVE100), B2C flag, market cap, press page, PR email, internal exec relationship, category (e.g. Bitcoin Mining & Digital Asset Infrastructure; Crypto Protocols & DeFi).
- **R100-3 (P0)** Activation tracker: first post date, month 1/2/3 participation, channel post count, profile link, editorial links (TheStreet power-ranking mentions, X posts).
- **R100-4 (P0)** Interviews sub-module: guest, host, status (scheduled/filmed/rescheduling/published), filmed date, publish date, link. An alert fires if the publish date is "TBD" for more than N days after filming.
- **R100-5 (P0)** Goal tracker: **live accounts vs 100 target**, with the burn-up chart and the funnel behind it ("~145 at Target").
- **R100-6 (P1)** Participation automation: a company not posting in the current month → task for the owner, plus an AI-drafted nudge email.
- **R100-7 (P0)** Bonus eligibility field per company (e.g. $5,000 bonus on the Editorial Outreach tab) → feeds Commissions.

### M17. Ads, sponsorship and revenue (TheStreet)
- **ADS-1 (P0)** Deal categories: Warm Deal → Active Deal (Hot / Verbal / Signed LOI) → Current Client → Renewal due / Churned.
- **ADS-2 (P0)** Billing schedule per deal: next payment value, dates, annualized value. Invoice records with status. Collections board.
- **ADS-3 (P0)** Summary widgets matching today's exec summary: active deals closing (count/$), current-client annualized revenue, upcoming collections, warm deals in negotiation.
- **ADS-4 (P0)** Renewal reminders at 60/30/14 days before the end date. Overdue invoice alerts at +1/+7/+14 days, escalating to finance and the owner.
- **ADS-5 (P1)** Payment-in-kind tracking (token or equity consideration), with separate valuation fields and a finance approval.
- **ADS-6 (P1)** Accounting sync (QuickBooks/Xero) for invoices and payments.

### M18. Commissions
**Objective:** support commission-only reps, SDR incentives, intern bonuses and executive/retainer staff.
- **COM-1 (P0)** Plan builder (admin/finance):
  - **triggers:** deal Won, invoice Paid (cash-basis), RTB100 Live, meeting held (SDR), migration Launched;
  - **rates:** % of contract value, % of RTB net revenue for N months, flat bounty, tiered/accelerators;
  - caps, draws and clawbacks (e.g. refund or churn within 90 days);
  - effective dates.
- **COM-2 (P0)** Plan assignment per user or role. Examples:
  - commission-only: % of collected revenue on deals they sourced or registered;
  - SDR: $ per qualified meeting held plus % on close;
  - intern: bonus per RTB100 activation;
  - SVP: override on team deals.
- **COM-3 (P0)** Splits honored from deal splits. Admins can apply source/closer split rules (e.g. 30% sourcer / 70% closer).
- **COM-4 (P0)** Accrual ledger, monthly statements, a dispute workflow, finance approval, and payout status export for payroll/AP.
- **COM-5 (P0)** Rep portal: commission reps see **only** their own registered leads, their deals, accruals and statements.
- **COM-6 (P0)** **Lead registration.** A commission rep registers an account → admin/SVP approves → ownership is protected for N days (default 90). Conflicts (the account is already owned or in a pipeline) are shown before submit and routed to a manager. Registration expires automatically without activity.
- **COM-7 (P1)** What-if calculator for reps ("if this closes at $200K, I earn…").

### M19. Analytics and reporting: see §14

### M20. Notifications
- **NOT-1 (P0)** Channels: in-app, email digest, Slack (DM and channel), browser push. Users set per-type preferences; admins can mark some types mandatory.
- **NOT-2 (P0)** Daily **"My Day" digest** at the user's local 8:00: overdue tasks, today's meetings with prep links, deals at risk, unanswered emails, commitments due, agent suggestions.
- **NOT-3 (P0)** Weekly manager digest: team pipeline changes, stale deals, rep activity, forecast movement with reasons.
- **NOT-4 (P1)** Slack bot: `/rtb deal <name>`, approvals from Slack, alert actions (snooze/done) inline.

### M21. Search
- **SRCH-1 (P0)** Global search across accounts, contacts, deals, emails, transcripts and documents. Permission-filtered, typo-tolerant, domain-aware.
- **SRCH-2 (P1)** Semantic search ("publishers in politics above 1M MUU that went cold after a demo").

### M22. Admin console: see §15

### M23. Audit, compliance and governance
- **AUD-1 (P0)** Immutable audit log for data changes, permission changes, exports, logins, impersonation, restricted-record access and every agent action (prompt, tools called, records touched).
- **AUD-2 (P0)** Field history on all deal value fields (stage, probability, MUU, value, close date), with who, when, why.
- **AUD-3 (P0)** **Restricted/MNPI records** (§7.1). Watermarked views; export blocked; the agent never includes restricted content in answers to users outside the access list.
- **AUD-4 (P0)** Basic outreach hygiene (GDPR is out of scope, D9):
  - unsubscribe and do-not-contact honored across sequences and the agent;
  - global suppression list;
  - retention policies per data type.
- **AUD-5 (P1)** Data retention jobs and legal hold.

### M24. Settings for the individual user
- **USR-1 (P0)** Profile, timezone, working hours (drives SLA timers), notification preferences, connected accounts (Gmail, Calendar, Zoom, Granola), email signature, AI voice samples (to tune follow-up drafts), privacy blocklist.

### M25. Lead Scout & Enrichment (Apify-powered)
**Objective:** continuously find the publishers that best fit an RTB platform deal, sized by MUU, and let a seller turn any target into verified executive contacts in one click (D4).

#### M25.1 Concept and flow
```
Define search (ICP filters or natural language via Copilot)
   → Discover candidates (Apify: SERP / top-sites lists / lookalikes / tech-stack reverse lookup / seed lists)
   → Measure (Apify: Similarweb traffic → MUU estimate; tech stack; ownership)
   → Dedupe against CRM (normalized domain; parent group)
   → Score (Fit Score 0–100 plus explanation)
   → Review queue (accept / reject / snooze / assign)
   → Accepted → Account + Target-stage deal (NET, SPT or ENT) + owner
   → Enrich (Apify: executives → emails → SMTP verification)
   → Contacts promoted → outreach (sequence / Copilot draft) → pipeline
```

#### M25.2 Scout searches
- **SCOUT-1 (P0)** Search builder:
  - **filters:** vertical/category (Finance, Crypto, Politics, News, Sports by league, AI, Emerging Tech, Military/Defense, Business…), country and language, **MUU range**, traffic trend (growing/flat/declining), ownership type (independent / group-owned / public company), CMS or tech-stack signals (e.g. WordPress VIP, Arc XP, Piano, Taboola, Outbrain, GAM), paywall present, include/exclude domains and groups;
  - **seed-based lookalikes:** "find sites like thedefensepost.com, proactiveinvestors.com", seeded from won or hot deals by default;
  - **keyword discovery:** e.g. "independent crypto news site", "Premier League fan site";
  - uploading a **domain list** (CSV/XLSX) to measure and score.
- **SCOUT-2 (P0)** Natural-language search via Copilot. Example: "Find 50 independent UK and Irish finance or politics publishers with 1–10M monthly users that aren't in our pipeline." The Copilot translates it into structured filters, shows them for confirmation, estimates the Apify cost, then runs.
- **SCOUT-3 (P0)** Cost estimate before every run (expected results × actor cost per result), checked against user, role and monthly caps. Runs over the user's per-run limit need SVP approval.
- **SCOUT-4 (P1)** Saved and scheduled searches (weekly/monthly). New candidates only, diffed against previous runs and the CRM, are delivered in a digest.
- **SCOUT-5 (P1)** Coverage maps: for a vertical, league or country, show "known universe vs in CRM vs engaged", e.g. "NFL team sites: 32 teams, 26 covered, 9 engaged".

#### M25.3 MUU estimation and provenance
- **SCOUT-6 (P0)** Traffic is fetched per domain from a Similarweb actor: monthly visits, 3-month trend, top countries, traffic sources, global/country rank.
- **SCOUT-7 (P0)** **Visits ≠ MUU.** Estimated MUU = monthly visits ÷ **visits-per-unique factor**. The factor is admin-configurable, default 2.5, overridable per vertical, e.g. news 3.0, niche/fan sites 2.0. It is calibrated over time against actual GA or partner-reported MUU on migrated partners. Every stored value carries source = "Similarweb via Apify", type = visits, the derived MUU, the factor used, and confidence = "estimate". This fixes the current practice of importing visits as MUU (P6).
- **SCOUT-8 (P0)** Once a partner shares analytics access or reports numbers, verified MUU replaces the estimate and the calibration factor is updated.

#### M25.4 Fit Score (0–100, admin-weighted)
**SCOUT-9 (P0)** The score is a weighted sum of factors, with a plain-English explanation ("82: 3.4M MUU in core Finance vertical, independent owner, declining traffic −18% (pain), legacy CMS with 6+ ad vendors, similar to 2 won partners"). Default weights:

| Factor | Default weight | Signal |
|---|---|---|
| Audience size in the sweet spot | 25 | MUU band. Default bands: NET 250K–25M best; 10M+ routes to ENT (Q13) |
| Vertical fit | 15 | Core verticals (Finance, Crypto, Politics/News, Sports, AI/Tech, Defense) ranked by RTB's won-deal history |
| Ownership / decision speed | 15 | Independent or founder-led scores high; group-owned is flagged "group sign-off" and routed to ENT |
| Pain signals | 15 | Traffic decline, ad-heavy page, many vendors (tech-stack count), no app/video, recent layoffs or news |
| Stack displaceability | 10 | CMS/ad-stack vendors RTB replaces (the "17 vendors" list), from tech-stack detection |
| Lookalike similarity | 10 | Embedding and feature similarity to won or hot deals |
| Geography / language | 5 | Supported markets (US, UK, EU, LatAm-Spanish, India…) |
| Relationship proximity | 5 | Existing contacts, warm intros, prior RTB100 or TheStreet relationship |

- **SCOUT-10 (P1)** Score calibration. The dashboard shows conversion by score band, and the admin can re-weight factors. The agent suggests weight changes from win/loss data but never applies them automatically.
- **SCOUT-11 (P0)** Estimated opportunity value = estimated MUU × $/MUU (default $1.00), labeled "estimate". It never enters the forecast until the deal is past Outreach.

#### M25.5 Review queue
- **SCOUT-12 (P0)** Table and card view of candidates: domain, logo, name, vertical, country, est. MUU (with confidence badge), trend sparkline, Fit Score with factor bars, tech stack chips, ownership, CRM status ("New", "In CRM, no deal", "Open deal: owner, stage", "Lost 6 months ago: reason"), and est. value.
- **SCOUT-13 (P0)** Actions, single and bulk:
  - **Accept** → creates or updates the Account and a Target-stage deal in the chosen pipeline, assigned to self or to a rep (per permissions), optionally with enrichment started immediately;
  - **Reject** with a reason (too small, wrong vertical, group-owned, competitor-locked, not independent, low quality). Reasons feed calibration and suppress the domain for N months;
  - **Snooze**;
  - **Mark duplicate / merge**.
- **SCOUT-14 (P0)** Ownership protection. A candidate that already has an owner, or a commission-rep registration, can't be accepted by someone else without a manager override (ties to COM-6).
- **SCOUT-15 (P0)** Routing on accept follows the territory and assignment rules (vertical, region, league, MUU band: e.g. ≥10M → SVP Strategic Partnerships; sports → sports team).

#### M25.6 Executive enrichment ("Find executives")
**SCOUT-16 (P0)** An **"Enrich"** button appears on every account, deal card and review-queue row, and in bulk from list views. The seller picks target roles; defaults come from the motion's admin preset:
- NET/SPT: Founder, Publisher, Editor-in-Chief, CEO, GM;
- ENT: CEO, CRO, Chief Digital Officer, CTO/CPO, Head of Ad Ops, CFO;
- R100: Head of Comms/PR, CMO, IR.

The enrichment pipeline is orchestrated as a durable workflow:
1. **Website crawl.** A contact-details actor crawls the domain (about, team, masthead, contact pages) for named people, generic addresses (press@, partnerships@, ads@) and social links.
2. **People discovery.** The LinkedIn company-employees actor runs in no-cookie/public mode, filtered by title keywords and seniority, and returns names, titles and profile URLs. Google SERP is the fallback (`site:linkedin.com/in "<company>" publisher OR CEO`).
3. **Email finding.** For each target person, in fallback order:
   1. an email found on the website;
   2. a LinkedIn-profile email finder;
   3. pattern generation (first.last@, flast@…) validated by an SMTP-checking email finder;
   4. an optional B2B leads-database actor.
4. **Verification.** Every candidate email goes through a bulk email verifier: valid / invalid / catch-all (risky) / disposable / unknown.
5. **Staging and dedupe.** Results are merged against existing Contacts (by email, LinkedIn URL, or name + account). Each result records source, confidence and cost.
6. **Review and promote.** The seller sees a staged list (name, title, LinkedIn, email, verification badge, source) and promotes selected people to Contacts with a buying-committee role. Admin rules may auto-promote "valid" emails for senior titles.

- **SCOUT-17 (P0)** Enrichment runs can be scheduled to refresh (e.g. quarterly for open ENT deals) to catch job changes (feeds CON-5 and NS-35).
- **SCOUT-18 (P0)** Bounce feedback: a bounced email (Gmail DSN) marks the contact's email invalid, lowers the source actor's quality score, and suggests re-enrichment (NS-34).
- **SCOUT-19 (P0)** Every enriched field stores `source_actor`, `apify_run_id`, `found_at`, `confidence` and `cost_usd`. Contacts created by enrichment carry origin = "Lead Scout" for funnel analytics.

#### M25.7 Actor Registry (admin, no code)
**SCOUT-20 (P0)** Admins register which Apify actor serves each purpose. For each actor they set:
- the input template (JSON with placeholders such as `{{domain}}`, `{{company_linkedin_url}}`, `{{titles}}`, `{{country}}`);
- the output-to-field mapping;
- max items and timeout;
- the cost per result, for estimates;
- the fallback order.

Actors can be swapped without a deploy. The system validates actor output against the mapping schema and quarantines malformed results. The seed configuration, chosen from the Apify Store on 30 Sep 2026 (verify pricing and terms at setup), is:

| Purpose | Primary actor | Fallback | Indicative cost* |
|---|---|---|---|
| Traffic / MUU estimate | `tri_angle/fast-similarweb-scraper` | `tri_angle/similarweb-scraper` (richer: sources, competitors, similar sites) | ~$0.002–0.013 per domain |
| Lookalike discovery ("similar sites") | `radeance/similarweb-scraper` (similar-sites option) | Google SERP "sites like …" | ~$0.008–0.01 per domain |
| Keyword / SERP discovery; LinkedIn X-ray fallback | `apify/google-search-scraper` (official Apify) | `apidojo/google-search-scraper` | ~$0.0025 per results page |
| Tech stack (CMS, ad stack, vendors) | `builtwith/builtwith-official-technology-scraper` | `inovaflow/technology-lookup` (also reverse "sites using X") | ~$0.002–0.02 per domain |
| Website contacts (masthead, generic emails, socials) | `jungle_synthesizer/website-contact-details-scraper` | `caprolok/website-email-phone-finder` | ~$0.001–0.02 per record |
| Executive discovery | `harvestapi/linkedin-company-employees` (no cookies; title/seniority filters; optional email search) | `thirdwatch/linkedin-company-employees-scraper` | ~$0.003–0.012 per profile |
| Email from LinkedIn profile | `vulnv/linkedin-email-finder` | — | ~$0.028 per email found |
| Email from name + domain (pattern + SMTP) | `clearpath/email-finder-api` | `microworlds/leads-finder` (B2B leads DB) | ~$0.008 per pattern tested |
| Email verification | `bounceverify/bounceverify-email-verifier` | `michael.g/email-verifier-validator` | ~$0.001 per email |
| Ad-hoc research (Copilot `web_research`) | `apify/rag-web-browser` | `apify/google-search-scraper` | per page |

\*Apify Store list prices at the Bronze tier, seen 30 Sep 2026. A typical "enrich 5 executives for one publisher" run is estimated at **$0.10–0.40**, and scoring 100 scouted domains (traffic + tech stack) at **$0.50–3.00**.

#### M25.8 Governance, cost and compliance
- **SCOUT-21 (P0)** Budgets: org monthly cap, per-role and per-user caps, and a per-run max. **Pilot defaults (D8):** org cap **$10.00/month**; per-user $2.00/month (SVP/exec $5.00); per-run max $0.50; scouting batch capped at 50 domains per run. Spend is tracked live from Apify run usage, and every run is attributed to user, search or account, and deal.
- **SCOUT-22 (P0)** Only public-data actors that don't use personal logged-in cookies (no LinkedIn session cookies) are allowed in the Registry. Admins must tick a compliance checkbox per actor.
- **SCOUT-23 (P0)** Global suppression list (domains, emails, people who opted out). Suppressed entries are never re-enriched or contacted.
- **SCOUT-24 (P0)** Every enriched contact stores its source and date. Outreach templates include an opt-out line as good practice. (GDPR-specific handling is out of scope, D9.)
- **SCOUT-25 (P0)** Scouting and enrichment never auto-send email. Outreach is always rep-initiated (a sequence enrollment or a Copilot draft that the rep sends).
- **SCOUT-26 (P0)** The Apify token is stored encrypted at org level. Users never see it, and all calls are made server-side.

#### M25.9 Performance
- Scoring and traffic lookups for 100 domains complete in under 5 minutes. Single-account enrichment completes in under 5 minutes (P95), with progress streamed to the UI.
- Runs are async (Apify run + webhook), with retries and idempotency on run completion.


---

## 11. The Smart Agent ("Roundtable Copilot")

### 11.1 Purpose
The agent is embedded in every screen, with two faces:
1. **Interactive**: a chat panel and ⌘K commands, e.g. "What's happening with Reach?", "Draft a follow-up to Defense Post from today's call", "Which Top-10 deals have no meeting booked in 14 days?", "Build a pro forma for GB News at £120M revenue".
2. **Autonomous**: background jobs triggered by events (new email, transcript, stage change) and schedules (nightly sweep, pre-meeting prep). It produces tasks, alerts, drafts and suggestions.

### 11.2 Capabilities (tools)
All tools are permission-scoped to the acting user. "Write" tools run under the autonomy settings in §11.4.

| Tool | Description |
|---|---|
| `search_records` | Search accounts, contacts, deals, activities and documents (structured and semantic) |
| `get_record` / `get_timeline` | Full context for a record |
| `create_task`, `update_task` | With evidence links |
| `update_deal_fields`, `suggest_stage_change` | Stage changes pass through the gates and need approval unless auto-apply is allowed |
| `create_contact`, `link_email_thread`, `link_transcript` | |
| `draft_email`, `send_email` | Send always needs a human click, unless admin enables auto-send for specific templated nudges |
| `summarize_thread`, `summarize_transcript`, `extract_action_items` | |
| `meeting_prep` | Brief for an upcoming meeting |
| `build_pro_forma` | Calls the proposal engine with inputs |
| `run_report` | Queries the analytics layer; returns a table or chart |
| `enrich_account` | Runs the M25 enrichment pipeline (Apify actors) for target roles; respects budget caps; results land in staging for review |
| `scout_targets` | Runs or refines a Lead Scout search from natural language ("find independent finance publishers in the UK with 1–10M MUU, not in pipeline"); returns scored candidates |
| `score_fit` | Explains an account's Fit Score and what would raise or lower it |
| `check_claims` | Validates text against the Claim Library (§11.5) |
| `create_alert`, `escalate` | |
| `web_research` (P0) | Public web lookup via Apify (Google Search / RAG web browser actors) for account research: ownership, recent news, leadership changes. Results are labeled "research estimate" |
| `knowledge_lookup` | RTB sales knowledge: positioning doctrine, pitch flow, objection library, product catalog, approved proof points (sourced from the RTB Knowledge Base and sales skills, curated by admin) |

### 11.3 Knowledge and memory
- **Structured CRM data**: queried live and never cached across permission boundaries.
- **Unstructured memory**: per-record embeddings of emails, transcripts, notes and documents in a vector index, filtered by record ACL at query time.
- **RTB playbook corpus**: the admin-curated knowledge base (pitch flow, 15-objection library, coalition messaging, product catalog, approved claims), versioned.
- **User style profile**: tone learned from the user's sent emails (opt-in) for drafts.

### 11.4 Autonomy levels (admin-configurable per action type and per role)

| Level | Behavior | Default for |
|---|---|---|
| 0 Off | Agent does nothing | — |
| 1 Suggest | Shows a suggestion; the user must accept | Stage changes, field updates on value fields, contact creation for enterprise domains |
| 2 Auto + notify | Performs the action and tells the user; undo within 24h | Task creation from commitments, linking emails/transcripts, activity logging, next-step updates |
| 3 Auto silent | Performs the action quietly (still audit-logged) | Enrichment, dedupe suggestions queued for admin |

The agent **never** does the following without an explicit human action:
- sends external email (except whitelisted templated nudges when admin-enabled);
- marks a deal Won/Lost;
- changes probability overrides;
- changes revenue share, guarantee or commission values;
- deletes data;
- touches Restricted records outside the access list.

### 11.5 Guardrails and compliance
- **Claim guardrail.** Every AI draft and every rep-composed email or proposal passes through `check_claims`. Statements that match *banned* or *restricted* claims are flagged, with the approved alternative:
  - unverified performance multiples;
  - "audited revenue" when the figure is not audited;
  - live-product claims for beta features (e.g. real-time Coinbase payouts);
  - forward-looking financial statements.

  Admin decides whether flagged content blocks the send or only warns.
- **MNPI guardrail.** The agent refuses to share Restricted-record content or non-public company financials with roles outside the access list. Drafts to external parties are scanned for internal financial figures (pipeline totals, forecast, deal terms of other clients) and warned.
- **Grounding.** Every factual statement about a deal cites its source (email/transcript/field). If there is no source, the agent says it doesn't know.
- **Prompt-injection defense.** Email, transcript and web content are treated as untrusted data. Instructions found inside them are never executed, and tool calls triggered while processing external content are limited to Level-1 (suggest) actions.
- **Cost and rate controls.** Per-user and org monthly AI budget, model routing (a fast model for classification, a strong model for summaries and drafting), and caching.
- **Evaluation.** A golden set of about 100 anonymized RTB emails and transcripts, with expected action items and stage suggestions. Precision/recall is tracked per release (Appendix E).

### 11.6 Execution model
- Event-driven, durable jobs: email received → classify → extract → act. Transcript ingested → process → review queue.
- Scheduled sweeps: nightly deal-hygiene sweep, hourly SLA checks, pre-meeting prep 60 min before each meeting.
- Every agent run is logged with inputs, model, tool calls, outputs, cost and latency. It is viewable by admins and by the user for their own runs.
- Background runs use a service identity **impersonating the record owner's permissions**, never elevated.

---

## 12. The proactive engine ("Nothing Slips")

**Objective C.** The engine is a rules-plus-AI system. It continuously evaluates every open deal, task, commitment, meeting, invoice, registration and migration. For each, it generates **Alerts** with a severity, an owner, a suggested fix and an escalation path.

### 12.1 Alert catalog (defaults; all admin-editable: thresholds, recipients, severity, on/off)

| ID | Trigger | Default threshold | First recipient → escalation |
|---|---|---|---|
| NS-01 | Open deal without next step / due date | Immediate | Owner → manager (24h) |
| NS-02 | Next-step due date passed | Due + 0 days | Owner → manager (+2 business days) |
| NS-03 | No activity in stage beyond SLA | Stage SLA (e.g. Hot 5d, Demo 7d, Warming 14d, Contract 5d) | Owner → manager |
| NS-04 | Inbound prospect email unanswered | 24 business hours | Owner → manager (48h) |
| NS-05 | Our commitment (from email/call) due | Due date −1 day reminder; overdue +0 | Owner → manager (+2d) |
| NS-06 | Their commitment passed with no response | Due + 2 days | Owner (nudge draft ready) |
| NS-07 | Meeting with an external contact ended, no notes/transcript | +2 hours | Owner |
| NS-08 | Meeting scheduled, no prep viewed | −60 min | Owner (prep brief attached) |
| NS-09 | Close date passed, deal still open | +1 day | Owner → manager |
| NS-10 | Contract/NDA sent, not signed | +5 business days | Owner |
| NS-11 | NDA or contract expiring | −30 days | Owner, legal |
| NS-12 | Deal health dropped ≥20 pts in 7 days | — | Owner, manager |
| NS-13 | Champion or key contact went silent (no reply to last 2 touches) | 2 touches / 10 days | Owner (multi-thread suggestion) |
| NS-14 | Contact left company (bounce/enrichment) | Immediate | Owner |
| NS-15 | High-value lead unassigned | 4 business hours | Admin/SVP |
| NS-16 | Lead registration conflict or expiring | Immediate / −7 days | Rep, manager |
| NS-17 | Duplicate account detected | Immediate | Admin queue |
| NS-18 | Probability override without approval / bulk override | Immediate | Executive approver |
| NS-19 | Migration stalled in stage | Stage SLA | Onboarding owner → COO |
| NS-20 | Go-live date slipped | +0 | Onboarding owner, deal owner |
| NS-21 | RTB100 company missed monthly participation | Month end −7 days | Owner (nudge draft) |
| NS-22 | RTB100 interview filmed, not published | +14 days | Editorial |
| NS-23 | Invoice overdue | +1 / +7 / +14 days | Owner → finance → CFO |
| NS-24 | Renewal approaching | −60 / −30 / −14 days | Owner |
| NS-25 | Rep inactivity (no logged activity) | 2 business days | Manager |
| NS-26 | Task snoozed ≥3 times | — | Manager |
| NS-27 | Data quality: missing MUU on engaged deal, missing primary contact, invalid email | Nightly | Owner digest |
| NS-28 | Sequence stuck (enrollment paused/bounced) | — | Owner |
| NS-29 | Proposal awaiting approval | 1 business day | Approver → exec |
| NS-30 | Gmail/Zoom/Granola/Apify connection broken | Immediate | User → admin |
| NS-31 | Scout candidates awaiting review | > 3 business days in queue | Search owner → SVP |
| NS-32 | Accepted scout target with no owner or no first touch | Unassigned 1 business day / no outreach in 5 business days | SVP / owner |
| NS-33 | Apify spend at 50% / 80% / 100% of the monthly budget ($10 pilot) | Threshold | Admin, CFO |
| NS-34 | Enriched contact bounced | On bounce | Owner (contact marked invalid; re-enrich suggested) |
| NS-35 | High-fit account shows a trigger event (leadership change, traffic drop > 25%, CMS migration, ownership change) | Weekly re-scan | Owner (or SVP if unowned) |

### 12.2 Behavior
- Alerts are **deduplicated** (one per record per rule) and grouped in digests.
- Each alert is **actionable**: done, snooze (with reason), reassign, "draft it for me" (agent), or dismiss (with reason, audit-logged).
- The **AI layer** adds judgment-based alerts on top of the rules. Examples: "Reach asked about guarantees twice and we haven't sent terms"; "Defense Post contract sent 9/26, champion out of office until 10/6, so the next step date is unrealistic".
- A **Hygiene score** per rep and team is shown on dashboards.
- **Quiet hours** and working hours are respected. Escalations fire only on business days.

---

## 13. Integrations

| Integration | Scope | Method | Priority |
|---|---|---|---|
| **Google (Better Auth)** | Login | OAuth2/OIDC via Better Auth Google provider; `hd` domain hint plus server-side allowlist | P0 |
| **Gmail** | Read/sync, send, labels | Gmail API with incremental scopes. Push via Cloud Pub/Sub `watch` (renew every 7 days), with history-ID incremental sync fallback | P0 |
| **Google Calendar** | Meetings, prep, task blocks | Calendar API, push channels | P0 |
| **Google Drive** | Docs, Meet transcripts | Drive API (file picker plus Meet artifacts) | P1 |
| **Zoom** | Transcripts, recordings | Zoom OAuth app (account-level); `recording.transcript_completed` webhook; Cloud Recording API | P0 |
| **Granola** | Notes and transcripts | **Granola API** (D3), **one key per user** (D6); polling plus events; Zapier or paste only as fallback | P0 |
| **Speech-to-text** | Audio/video uploads | Pluggable STT provider with diarization | P0 |
| **LLM** | Agent, extraction, drafting | Claude models via Vercel AI Gateway (model routing, fallbacks, zero data retention) | P0 |
| **Slack** | Alerts, approvals, commands | Slack app (bot plus interactivity) | P1 |
| **Apify** | Lead Scout discovery, traffic/MUU estimates, tech stack, executive discovery, email finding and verification | Apify API (`run-sync` for small jobs, async runs + webhooks for large ones), org API token in the secrets vault, Actor Registry (M25) | P0 (enrichment) / P0 (scout) |
| **Other enrichment** | Company/contact | Apollo (optional second source), pluggable | P2 |
| **E-signature** | NDAs, contracts | DocuSign / Dropbox Sign webhooks | P1 |
| **Accounting** | Invoices, payments | QuickBooks / Xero | P2 |
| **Trello** | Migration import | Trello API, one-time plus transition sync | P1 |
| **Google Sheets** | Transitional two-way sync | Sheets API | P1 |
| **LinkedIn** | Touch logging | Manual log plus browser extension capture (no scraping) | P2 |
| **Public API and webhooks** | Everything | REST + webhooks, API keys scoped by role | P0 |

**Google verification note (resolved by D1).** Gmail read/modify scopes are Google **restricted scopes**. The two paths were:
1. Configure the OAuth app as **Internal** to RTB's Google Workspace. This avoids Google's security assessment, but only Workspace accounts can connect.
2. Publish as **External** and complete Google's verification and security assessment (weeks of lead time, plus annual cost).

**Two domains (D5).** An "Internal" Google OAuth app only admits users of the Workspace organization that owns it. There are two options for `blockchainff.com` users:
1. If `roundtable.io` and `blockchainff.com` are in the **same** Workspace organization (one is a secondary domain), Internal works for both.
2. If they are **separate** organizations, register the app as External, keep it in *Testing* with every user listed as a test user (up to 100 users, no verification needed), and have each Workspace admin mark it trusted.

Confirm which applies during Phase 0 setup.

**Decision:** the OAuth app is **Internal** to RTB's Workspace (or option 2 above for the second tenant), and every user (including commission-only reps and interns) gets an RTB Workspace account. No Google security assessment is needed. The Workspace admin must allow the app (and, optionally, pre-approve its scopes through domain-wide app access control) so users see a clean consent screen.

---

## 14. Analytics and reporting

### 14.1 Principles
- Every number shows **its basis**: gross vs RTB net; MUU source (verified vs estimated vs Similarweb visits); weighted vs unweighted; including or excluding manual overrides.
- Nightly **snapshots** make it possible to answer "what changed since last week and why" (stage moves, new deals, value changes, overrides). This addresses P5.
- Charts are role-scoped. Commission reps see only their own analytics.

### 14.2 Standard dashboards (P0 unless noted)

| Dashboard | Audience | Contents |
|---|---|---|
| **Executive Overview** | Exec | Pipeline by motion (MUU, gross, net, weighted); tier/stage distribution; Top-25 brands; concentration (top-5 share); new vs advanced vs slipped this week; forecast (commit/best/pipeline) by quarter; won MUU and revenue YTD; override exposure; RTB100 live vs 100; ADS annualized revenue and collections |
| **Pipeline Health** | Exec, SVP | Stage aging vs SLA, deals without next step, health distribution, stalled list, velocity by stage, conversion by stage (historical), win rate by source and motion |
| **Rep Scorecard** | SVP, rep | Activities (emails, calls, meetings), meetings held, deals advanced, won, hygiene score, response time, commitments kept %, pipeline created |
| **SDR/Intern Funnel** | SVP | Outreach → reply → meeting → qualified → handoff, by rep and source list (e.g. Erik's automated outreach vs manual) |
| **NetDev & Sports** | SVP | MUU pipeline by category, league and region; migrating/live counts; guarantee exposure ($/month committed) |
| **Enterprise** | Exec | Each ENT deal: stage, stakeholders engaged, proposal version, revenue-share and guarantee terms (permissioned), next milestone |
| **Roundtable 100** | SVP, editorial | Live accounts burn-up to 100; activation funnel; participation month 1–3 retention; posts per company; interviews pipeline |
| **Revenue (ADS)** | Exec, finance | Bookings, annualized, collections, overdue AR aging, renewals, customer concentration |
| **Onboarding** | COO | Migrations by stage, cycle time, slips, launched count |
| **Commissions** | Finance, rep | Accruals, payouts, by plan and rep; disputes |
| **AI & Automation** | Admin | Tasks created by AI, acceptance rate, time to follow-up, alerts fired/resolved, agent cost |
| **Data Quality** | Admin | Duplicates, missing MUU, missing contacts, invalid emails, unmapped statuses |
| **Lead Scout** | SVP, admin | Budget used vs the $10 pilot cap; candidates found → accepted → contacted → meeting → won, by search, vertical, country and source actor; acceptance rate; Fit Score calibration (conversion by score band); enrichment hit rate and verification rate by actor; bounce rate; Apify cost per accepted target and per meeting |

### 14.3 Report builder (P1)
Drag-and-drop over any object and field, with filters, grouping, chart types (bar, line, funnel, table, pivot), scheduled email delivery and export. The agent can create a report from natural language ("show weighted NetDev pipeline by category, net basis, excluding overrides").

### 14.4 Forecasting (P1)
- Rep-submitted forecast categories per deal (Commit / Best case / Pipeline / Omitted) with a manager roll-up.
- AI forecast: probability from historical conversion and activity signals, shown **alongside** stage-based probability, never replacing it silently.
- Forecast change log with reasons.

---

## 15. Admin customization (no code)

| Area | What admins can do |
|---|---|
| Pipelines | Create or clone pipeline types; stages (order, probability, category, SLA); stage gates; win/loss reasons; value formula per pipeline ($/MUU default, revenue-share defaults) |
| Fields | Custom fields on any object: text, number, currency, %, date, picklist (single/multi), user, lookup, URL, email, phone, formula (read-only), checkbox. Required-by-stage; help text; field-level security per role |
| Picklists | Categories/verticals, leagues/teams, regions, languages, sources, priorities, lost reasons, contact roles |
| Layouts | Record page sections and field order per pipeline and role; card fields on kanban; list default columns |
| Roles and permissions | Role templates, permission sets, module × action × scope matrix, field-level security, teams, sharing rules, restricted-record access lists |
| Automations | Rule builder: trigger (record created/updated, stage changed, field changed, email received, transcript processed, date reached, schedule) → conditions → actions (create task, send notification, update field, assign owner (round-robin, territory), enroll sequence, create onboarding project, call webhook, ask agent) |
| Alerts | Alert catalog thresholds, recipients, escalation chains, quiet hours |
| Agent | Autonomy levels per action/role; enabled tools; model routing; budget caps; follow-up tone; playbook knowledge sources; claim library; banned phrases; auto-send whitelist |
| Templates | Email templates, sequences, proposal and pro forma templates, onboarding checklists |
| Product catalog | Products, pricing models, default terms, collateral, approved claims |
| Commissions | Plans, rates, triggers, splits, clawbacks, assignments |
| Import | Mapping templates, MUU parsing rules, status mapping table, dedupe policy |
| Lead Scout | ICP and Fit Score weights; MUU bands; target verticals, countries and languages; excluded domains/groups; visits-to-MUU conversion factor; target executive roles and title keywords per motion; Actor Registry (actors, inputs, mappings, fallback order); budget caps per user, role and month; auto-scout schedules; enrichment auto-accept rules (e.g. auto-promote only "valid" emails) |
| Integrations | Connect and disconnect org-level integrations; health status |
| Branding | Logo, design tokens (§16A; grayscale UI tokens locked, chart palette editable only via the validator-checked token set), PDF templates, email footer |
| Data | Retention policies, backups export, sandbox copy (P2) |

All configuration changes are versioned, audit-logged and reversible.

---

## 16. Non-functional requirements

| Area | Requirement |
|---|---|
| Scale (v1) | 50 users; 50K accounts; 100K contacts; 20K deals; 2M emails; 10K transcripts. Design headroom 10× |
| Performance | P95 page load < 1.5s; kanban with 2.5K cards < 1.5s; search < 500ms; email-to-CRM latency < 2 min; transcript processing < 5 min (1h call) |
| Availability | 99.9% monthly for core CRM; degraded mode if AI or integrations fail (CRM still usable) |
| Security | TLS everywhere; encryption at rest; OAuth tokens encrypted with KMS-managed keys; least-privilege service accounts; OWASP ASVS L2; dependency scanning; annual pen test |
| Privacy | AI provider zero data retention; no training on RTB data; data processing agreements with subprocessors (GDPR out of scope, D9) |
| Audit | Immutable audit log retained ≥ 7 years for financial and deal fields; exports logged |
| Accessibility | WCAG 2.1 AA |
| Browser | Latest Chrome, Safari, Edge, Firefox; responsive down to 375px (read and quick actions on mobile) |
| Timezones | All timestamps UTC; displayed in user timezone; SLA timers respect business hours |
| Backups | Point-in-time recovery 7 days; daily logical backups 30 days |
| Observability | Structured logs, traces, error tracking; per-integration health dashboard |
| i18n | UI English v1. Data supports UTF-8 and accents (Spanish targets) |

---

## 16A. Visual design system (D10)

**Source of truth:** the Claude Design project "RTB Product Deck (B&W)" (`claude.ai/design/p/2d2f47dc-…`). That link needs a claude.ai login, so the tokens below were taken from RTB's own black-and-white deck files in the data room (`RTB_Product_Deck_BW.pptx`, `RTB_Investor_Deck_BW.pptx`, `RTB_One_Pager_Black.pptx`), which the design file is built from. **Build task (Phase 0):** open the Claude Design file and reconcile any differences in exact hex values, type scale or components before the tokens are frozen. The design file wins.

### 16A.1 Theme principles
- **Dark by default, and the only theme in v1:** a near-black background with white text. There is no light mode in v1. The PDF/print exports (proposals, one-pagers) keep their existing B&W templates.
- **Monochrome UI.** All chrome (navigation, buttons, cards, borders, tables, kanban) uses only the grayscale ramp. Color appears **only** in data visualization, status badges and the fit/health scores.
- **Editorial feel**, matching the RTB decks: a serif display face for headings and hero numbers, and a light geometric sans for everything else. Generous whitespace, hairline borders, no drop shadows, and restrained motion (150–200 ms).

### 16A.2 Typography

| Role | Font | Weight | Size / line-height | Use |
|---|---|---|---|---|
| Display / hero number | **Playfair Display** | 400–600 | 40/48, 32/40 | Page titles, dashboard hero KPIs (e.g. "$1.02B weighted") |
| H1–H3 | **Playfair Display** | 500 | 28/36, 22/30, 18/26 | Section headings, record names on the deal card |
| UI body | **Work Sans** | 300 (Light) | 14/22 | Default body, table cells, descriptions |
| UI emphasis | **Work Sans** | 500 (Medium) | 14/22 | Labels, buttons, tab names, column headers |
| Strong | **Work Sans** | 600 (SemiBold) | 13–14 | Kanban card titles, badges, numbers in tables |
| Small / meta | **Work Sans** | 400 | 12/18 | Timestamps, helper text, chart axes |
| Mono (IDs, code) | JetBrains Mono (or system mono) | 400 | 12/18 | Record IDs, API keys (masked), logs |

Both families come from Google Fonts. Numbers in tables use tabular figures (`font-variant-numeric: tabular-nums`).

### 16A.3 Color tokens (UI)

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#070707` | App background |
| `--surface-1` | `#0B0B0B` | Cards, panels, kanban columns, **chart surface** |
| `--surface-2` | `#1A1A1A` | Raised: popovers, modals, hovered rows, kanban cards |
| `--surface-3` | `#2E2E2E` | Inputs, selected states |
| `--border` | `#2E2E2E` | Hairline borders (1px) |
| `--border-strong` | `#3C3C3C` | Focus outlines' outer ring, dividers |
| `--text-primary` | `#FFFFFF` / `#F4F4F4` | Primary text (pure white for headings and hero numbers; `#F4F4F4` for body to reduce glare) |
| `--text-secondary` | `#B4B4B4` | Secondary text, labels |
| `--text-muted` | `#828282` | Meta, placeholders, axis labels |
| `--text-disabled` | `#6E6E6E` | Disabled |
| `--accent` | `#FFFFFF` | Primary button (white fill, black text) and focus ring (2px white) |
| `--accent-inverse` | `#0B0B0B` | Text on white buttons |

Buttons:
- **Primary:** white fill with black Work Sans 500 text.
- **Secondary:** transparent with a 1px `#3C3C3C` border and white text.
- **Ghost:** text only.
- **Destructive:** secondary style with a rose icon (color only in the icon).

Every text/background pair meets WCAG AA (body text on `#0B0B0B` is at least 7:1).

### 16A.4 Data visualization palette: pastels on black
The pastel set below is tuned for the black chart surface (`#0B0B0B`). It was **validated with the dataviz palette checker** (dark mode, adjacent pairs):
- lightness band: pass;
- chroma floor: pass;
- normal-vision separation: pass (worst ΔE 19.4);
- contrast vs surface: all ≥ 3:1;
- color-blind separation: WARN, worst pair ΔE 7.9 (mint vs peach).

Because of that last result, **2px surface gaps between adjacent fills plus direct labels or a legend are mandatory**. Very pale pastels such as `#F7E3A1` were tested and **rejected**: on black they fall outside the readable band and turn into near-identical light blobs.

**Categorical (fixed order; never cycled, never re-sorted by rank):**

| Slot | Name | Hex |
|---|---|---|
| 1 | Pastel blue | `#5C98D5` |
| 2 | Peach | `#CE7C4C` |
| 3 | Mint | `#44A781` |
| 4 | Lilac | `#AB6DBA` |
| 5 | Butter | `#A9933B` |
| 6 | Periwinkle | `#6C79C7` |
| 7 | Rose | `#CF6872` |
| 8 | Aqua | `#13A5B2` |

**Rules:**
- **Pipeline motions keep a fixed color everywhere:** NET = blue, ENT = lilac, SPT = mint, R100 = butter, ADS = peach, PAY = aqua. A 9th or later series folds into "Other" (`#828282`).
- **Scatter/bubble charts** (all points compared with all others) use at most 3 series, drawn from slots **1, 5, 7** (blue, butter, rose). That subset passes the all-pairs check; with more series, use small multiples.
- **Sequential (magnitude, heatmaps, MUU bands):** a single-hue pastel-blue ramp from `#1B2B3D` (low) to `#9CC3EA` (high). Never a rainbow.
- **Diverging (e.g. week-over-week change, forecast vs target):** peach ← neutral gray `#3C3C3C` → blue.
- **Status colors (reserved, always with an icon plus a label):**
  - good = mint `#44A781` with ✓;
  - warning = butter `#A9933B` with !;
  - serious = peach `#CE7C4C` with ▲;
  - critical = rose `#CF6872` with ✕.

  These drive health scores, SLA badges and alert severity.
- **Mark specs:** thin bars with 4px rounded data ends; 2px lines; markers ≥ 8px; 2px `#0B0B0B` gaps between stacked segments; recessive grid (`#1A1A1A`, 1px); axes and labels in `--text-muted` Work Sans 12. Text is never drawn in a series color.
- **Hover layer on every chart:** a crosshair and tooltip on line and area charts, a per-mark tooltip on bars and cells, and a "view as table" toggle for accessibility.
- **Hero KPIs** are Playfair Display numbers in white, with a Work Sans label and a small pastel sparkline.

### 16A.5 Components (shadcn/ui, themed)
All shadcn/ui primitives are themed to the tokens above: Button, Input, Select, Combobox, Dialog, Sheet, Popover, Tabs, Table (TanStack), Badge, Tooltip, Command (⌘K), Toast, Calendar.

Custom components:
- **Kanban column and card:** `surface-1` column, `surface-2` card, 1px border, and pastel left-edge tick in the motion color (the only color on the card besides status badges).
- **Stage path:** monochrome chevrons; the current stage is white-filled.
- **Timeline:** hairline rail with Work Sans meta.
- **AI summary box:** `surface-2` with a thin white left rule and a "Copilot" label in Playfair italic.
- **Fit Score and health dials:** status colors plus a number.
- **Evidence quote chip.**
- **Empty states:** a line illustration in `#3C3C3C`.

Icons: Lucide, 1.5px stroke, white or muted.

Brand assets: the "Roundtable" lockup (emblem + wordmark), **white version** on black (use the data room's "Roundtable lockup (emblem + wordmark, black)" asset, inverted, until a white asset is exported from the design file).

---

## 17. Technical architecture (recommended)

- **App:** Next.js (App Router, TypeScript) on Vercel (Node.js runtime, Fluid Compute). React Server Components for data-heavy views. shadcn/ui plus Tailwind. TanStack Table for grids. dnd-kit for kanban.
- **Auth:** **Better Auth**:
  - Google social provider;
  - the **admin** plugin (user management, bans, impersonation);
  - the **organization / access-control** plugins (custom roles and permission statements), mapped to the Module × Action × Scope model;
  - the Drizzle adapter.

  Additional Google scopes (Gmail, Calendar) are requested via Better Auth's linked-account / scope-upgrade flow. Tokens are stored encrypted.
- **Database:** Postgres (Neon or Supabase via Vercel Marketplace) with Drizzle ORM; row-level permission filters in a shared query layer; `pgvector` for embeddings; Postgres full-text plus trigram for search (Typesense/Meilisearch optional at scale).
- **Background work:**
  - Vercel **Workflow** (durable, retryable) for email and transcript pipelines and agent runs;
  - Vercel **Queues** for fan-out (per-message processing);
  - **Cron** for sweeps (hygiene, SLA, digests, Gmail watch renewal).
- **Files:** Vercel Blob (private) for transcripts, recordings and documents, with direct client upload for large files.
- **AI:** AI SDK with **Vercel AI Gateway**:
  - Claude models, routed by task: Haiku-class for classification/extraction at volume; Sonnet/Opus-class for summaries, drafting and agent reasoning;
  - structured outputs (Zod schemas, Appendix D);
  - tool calling for the Copilot;
  - evals in CI.
- **Integrations:** Gmail Pub/Sub push endpoint; Zoom webhook endpoint with signature verification; Granola API connector; **Apify client with a run-completion webhook endpoint** (Lead Scout and enrichment); Slack app; generic webhook ingestion (for BCC capture use an inbound-email service).
- **Security:**
  - all server actions go through a single `authorize(user, module, action, record)` guard;
  - agent tools call the same guard;
  - secrets in Vercel env;
  - Vercel Firewall / BotID on public endpoints.

---

## 18. Data migration from the current spreadsheets

| Source file / tab | Target | Key mapping notes |
|---|---|---|
| `RTB Global Sales Pipeline 9.29.26 [DRAFT] v7` → **Pipeline Master** (2,151 rows) | Accounts + NET/SPT/ENT deals | Tier (100/90/50/10) → stage via the status mapping; MUU → Audience Metric (source: "pipeline v7"; blue cells → "BFF research estimate"); Rep → owner/split |
| v7 → **Contacts & Notes** | Contacts + notes on deal | Priority → deal priority; Next Steps → next step (needs a due date; set to import date +7 and flag for review) |
| v7 → **Removed (off model)** (380) | Accounts, lifecycle = Disqualified | Keep the reason |
| `[DRAFT]` (unversioned) → **Pipeline Master** (2,531 rows, with granular Status and Probability override) | Deals | **Preferred source for Status** (19-status granular). Probability override → deal override with reason "Imported: per J. Heckman 29 Sep 2026", flagged for approval |
| `[DRAFT]`/v7 → **Sports** (149) | Accounts (team, league) + SPT deals | Sport/League → picklist; Team → field |
| `[DRAFT]`/v7 → **TechFinance**, **NewsPolitics**, **Strategic** | NET/ENT deals + contacts | "Met 7/1/26. Attendees: …" → meeting activity |
| `[DRAFT]`/v7 → **MigrationPrio** (24) | Migration Projects | Migration Status/Launched? → onboarding stage/flag |
| `[DRAFT]`/v7 → **RTB 100** (149) | R100 deals (activation data) | Mo. 1–3 participation, posts, profile link, SDR → owner, Extra Links → editorial links |
| `Chris & Will - Master Pipeline` → **TheStreet** | ADS deals + invoices | Category → stage (Active/Current Client/Warm); Next Payment + Annualized → billing |
| C&W → **NetDev**, **RTB 100** | Deals (dedupe against the above) | |
| C&W → **Team** | Users + employment type + commission plan placeholders | Retainers, hourly, commission-only |
| C&W → **Summary** | Validation targets | Post-migration dashboard must reproduce these counts or explain the differences |
| `RTB Sites & RTB100 Pipeline` → **RTB 100 MASTER** (≈6,300 rows) | R100 accounts/deals | Status cleaning (dates/emails → notes); Owner combos → splits; up to 4 emails/titles → contacts; ticker/token/B2C/market cap → account fields |
| → **RTB 100 Editorial Outreach** (337) | R100 deals + category + bonus | Section headers ("── Bitcoin Mining … ──") → category |
| → **RTB100 Interviews** (11) | Interviews | |
| → **NetDev CLEANED Pipeline** (3,166), **NETDEV Pipeline** (1,450), **NetDev Active Deal Tracking** (53), **New Target List** (428), **NetDev Spanish Targets** (503) | Accounts + NET deals + contacts | Monthly visits → Audience Metric (type: visits, not MUU); "outreach sent", "like/dislike" → fields; date-in-status → last contacted |

**Migration process:**
1. Dry-run import into a staging environment.
2. Reconciliation report: counts by status/owner vs source, duplicates merged, unmapped values.
3. Business review with Chris and Will.
4. Production import.
5. Freeze the spreadsheets as read-only archive.
6. Two-week parallel period with Sheets export if needed.

---

## 19. Release plan and milestones

| Phase | Weeks | Scope | Exit criteria |
|---|---|---|---|
| **0. Foundations** | 1–2 | Better Auth Google login and allowlist; roles/permissions engine; core data model; audit log; admin shell | Users can sign in; permission tests pass |
| **1. MVP CRM** | 3–6 | Accounts, contacts, deals (NET, ENT, SPT, R100, ADS); kanban; record card; list views; import wizard plus full spreadsheet migration; dedupe; tasks and reminders; basic dashboards (Executive, Pipeline Health, RTB100, ADS); notifications (in-app and email) | Spreadsheets retired; Summary tab reproduced |
| **2. Inbox, Calls and Enrichment** | 7–10 | Gmail connect/sync/send (mandatory for sales roles); email AI extraction → tasks and next steps; Calendar sync; **Granola API**, Zoom and manual transcript ingestion; post-call processing and Apply screen; **M25 enrichment** (Apify: find executives + emails + verification on any account) | ≥80% action-item recall on the golden set; <10 min call-to-CRM |
| **3. Nothing Slips, Copilot and Lead Scout** | 11–14 | **M25 Lead Scout** (searches, Fit Score, review queue, lookalikes, scheduled scouts); alert catalog NS-01…35; digests; escalations; Copilot chat with tools; meeting prep; claim guardrail; restricted records | ≥95% of open deals with a next step, sustained for 2 weeks |
| **4. Money** | 15–18 | Proposals/pro forma builder and approvals; migration module; commissions (plans, registration, statements, rep portal); invoices and collections | First commission statement run matches finance's manual calc |
| **5. Scale and polish** | 19+ | Sequences; Slack app; report builder; forecasting; Apollo as a second enrichment source; e-signature; Meet transcripts; Sheets sync; semantic search; trigger-event monitoring (NS-35) | — |

---

## 20. Risks, assumptions and open questions

### Assumptions
- **A1.** ~~"SVR" means SVP~~ **Confirmed (D2).**
- **A2.** **Confirmed (D1):** RTB uses Google Workspace and every user will have an RTB account, so the Internal OAuth app works.
- **A5.** Apify actors are third-party and change over time. RSOS treats them as swappable plugins behind the Actor Registry, and no business logic depends on a single actor.
- **A3.** $1 per MUU per year is the default pipeline yield (per the current pipeline assumptions). It is admin-editable per pipeline and per deal.
- **A4.** A single-tenant deployment for RTB, with a multi-tenant-ready schema.

### Open questions
| # | Question | Owner |
|---|---|---|
| Q1 | **Resolved (D1, D5):** all users on RTB Workspace; domains `roundtable.io` and `blockchainff.com`. | — |
| Q2 | ~~Granola integration path?~~ **Resolved (D3, D6): API, one key per person.** | — |
| Q3 | Is Zoom cloud recording with transcripts enabled on RTB's Zoom plan? | Ops |
| Q4 | Official stage definitions and probabilities per motion: keep 100/90/50/10, or a granular 19-status scheme? Who approves overrides? | CEO/SVPs |
| Q5 | Revenue-share and guarantee floors that trigger approval? | CFO |
| Q6 | Commission plans per person (rates, triggers, cash vs booking basis, clawbacks)? | CFO/SVPs |
| Q7 | Which records are Restricted/MNPI (Arena/Paradium, NY Post, other enterprise groups)? Access lists? | CFO/GC |
| Q8 | Approved-claims list: who owns it (GC plus CFO), and should it block or only warn? | GC |
| Q9 | Email body retention period, and whether managers may see reps' linked deal emails | GC/COO |
| Q10 | Should the agent be allowed to auto-send templated nudges (e.g. RTB100 monthly participation reminders)? | SVPs |
| Q11 | Hourly interns: is time tracking needed in-system for payroll? | Finance |
| Q13 | **Resolved (D7): confirmed.** Lead Scout ICP: the MUU sweet spot (proposed 250K–25M for NET; 10M+ for ENT), priority verticals and countries, and whether group-owned brands (News Corp, Sinclair, Reach) route to ENT automatically | CEO/SVPs |
| Q14 | **Resolved for the pilot (D8): $10/month total.** Revisit after the pilot with cost-per-accepted-target data. | CFO |
| Q15 | **Resolved (D9): GDPR out of scope for v1.** | — |
| Q12 | Build vs extend: build this custom product, or configure HubSpot/Attio and add the AI layer? This PRD assumes a custom build for the deep RTB-specific motions (MUU economics, RTB100, migration, pro formas, commission-only portal). | CEO/COO |

### Risks
| Risk | Mitigation |
|---|---|
| Google restricted-scope verification blocks external users | Resolved by D1: Internal app, all users on RTB Workspace |
| Scraped data is wrong (MUU from visits, stale titles, guessed emails) | Provenance and confidence on every value; SMTP verification before promotion; bounce feedback loop; human review queue |
| Third-party actor breaks, changes schema or raises price | Actor Registry with fallback order; schema validation on output; health checks; cost per result tracked |
| Platform terms (LinkedIn) | Public-data-only actors without logged-in cookies; store source and date; honor opt-outs and a global suppression list; no bulk automated sends |
| Runaway spend | Per-run, per-user and monthly caps; estimate shown before run; NS-33 |
| AI mis-extracts commitments → noise or wrong tasks | Suggest-first autonomy; evidence quotes; golden-set evals; per-user feedback ("not a task") retrains prompts |
| Adoption: reps keep working in sheets | Import everything on day 1; inbox and call capture reduce data entry; manager dashboards use CRM data only |
| Privacy/legal exposure from email monitoring | Explicit consent, relevance filter, private-thread control, retention policy, restricted records |
| Inflated pipeline figures (visits as MUU, bulk overrides) | Provenance labels, override approvals, snapshot audit, net-basis toggle |
| Integration fragility (Gmail watch expiry, webhook failures) | Health checks, auto-renewal cron, backfill on reconnect, NS-30 alerts |

---

## 21. Appendices

### Appendix A: Status dictionary (seed; admin-editable)

**NET / SPT / ENT pipelines:**

| Stage (system) | Imported statuses mapped here | Default probability (tier) | Category | SLA (days) |
|---|---|---|---|---|
| Target | Target, New, No status | 10% | Open | 30 |
| Outreach | Outreach, Reached Out, "7/20 outreach", date values | 10% | Open | 14 |
| In Comms | In comms, Met, Call set, Call done | 50% | Open | 10 |
| Warming Up | Warming up | 50% | Open | 14 |
| Hot | Hot, Verbal | 90% | Open | 5 |
| Demo / Beta Review | Demo, Beta (reviewing beta site) | 90% | Open | 7 |
| Contract | Contract, contract sent | 100% | Open | 5 |
| Migrating (Won) | Migrating | 100% | Won → onboarding | — |
| Live (Won) | Live, Launched | 100% | Won | — |
| On Hold | Hold, On Pause, Stuck | 50% / 10% (Pause) | Hold | 30 |
| Cold | Cold, Old Lead | 10% | Open (nurture) | 60 |
| Lost / Rejected | Rejected | 0% | Lost | — |

The granular 19-status scheme from the unversioned MASTER file (Contract/Migrating/Beta 95%; Hot 90%; Demo 75%; Warming up 60%; Met 45%; In comms 40%; Call set 30%; Stuck 20%; Hold 15%; Cold 10%; Outreach 8%; Target 6%; New 5%; On Pause 5%; Old Lead 3%; No status 2%; Rejected 1%) ships as an **alternative preset** that admins can switch to.

**R100 pipeline:** Target → Outreach → Warming Up → Hot → Onboarding → Profile Activated (Live) → Made First Post (Live) → Active → Lapsed. Side states: "Relationship already", "Cold – keep comms".

**ADS pipeline:** Warm Deal → Negotiation → Verbal → Signed LOI → Contract Signed (Won) → Current Client → Renewal → Churned / Lost.

### Appendix B: Default permission matrix (scope per module; V = view, C = create, E = edit, D = delete, X = export, A = approve, Cfg = configure)

| Module | Super Admin | Admin | Executive | Sales Leader (SVP) | AE | SDR | Intern | Commission Rep | Onboarding | Finance | Editorial | Viewer |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Accounts | All VCEDX | All VCEDX | All VCEX | All VCE, team X | All V, own CE | All V, own CE | All V, own CE | Own + registered VCE | All V | All V | R100 V | All V |
| Contacts | All VCEDX | All VCEDX | All VCEX | All VCE | All V, own CE | All V, own CE | Own VCE | Own VCE | All V | All V | R100 V | All V |
| Deals – NET/SPT | All | All | All VCE A | All VCE, team X, A (≤ limit) | Team VCE | Own VCE | Own VCE (no value-term fields) | Own VCE (no terms) | All V | All V | — | All V |
| Deals – ENT | All | All | All VCE A | Pipeline VCE | Assigned VCE | — | — | — | Won V | All V | — | Summary V |
| Deals – R100 | All | All | All V | All VCE | Team VCE | Own VCE | Own VCE | Own VCE | — | All V | All VCE | All V |
| Deals – ADS | All | All | All VCE A | All VCE | Team VCE | Own VC | Own V | Own VCE | — | All VE | — | All V |
| Restricted records | Access list | Access list | Access list | Access list | Access list | — | — | — | — | Access list | — | — |
| Kanban / Lists | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Own | ✓ | ✓ | R100 | ✓ |
| Email (own mailbox) | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own | Own | — |
| Email (linked threads of others) | All | All | All | Team | — | — | — | — | — | — | — | — |
| Calls/Transcripts | All | All | All | Team | Own + deal | Own + deal | Own | Own | Won deals | — | R100 | — |
| Copilot (use_ai) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (suggest-only) | ✓ (own data) | ✓ | ✓ | ✓ | ✗ |
| Proposals / Pro forma | All | All | All VCEA | VCE, A ≤ limit | VCE | — | — | — | — | V | — | — |
| Onboarding | All | All | V | V | V | — | — | — | VCE | — | — | V |
| Commissions | All | Cfg | All V, A | Team V | Own V | Own V | Own V | Own V | Own V | All VCEA | Own V | — |
| Revenue / Invoices | All | All | All V | All V | Team V | — | — | Own V | — | All VCED | — | V |
| Analytics | All | All | All | Team + pipeline | Own + team | Own | Own | Own | Onboarding | Finance + all | R100 | Assigned dashboards |
| Import | ✓ | ✓ | — | Team | — | — | — | — | — | — | — | — |
| Lead Scout: run searches | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (capped) | ✓ (own registered verticals, capped) | — | — | — | — |
| Lead Scout: accept candidates to pipeline | ✓ | ✓ | ✓ | ✓ (assign any) | ✓ (to self) | ✓ (to self) | Suggest only (SVP approves) | Via lead registration (COM-6) | — | — | — | — |
| Enrichment (run) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (capped) | ✓ own accounts (capped) | — | — | R100 (capped) | — |
| Actor Registry / budgets | Cfg | Cfg | V | V | — | — | — | — | — | Budget V | — | — |
| Export | ✓ | ✓ | ✓ | Team | Own | — | — | — | — | ✓ | — | — |
| Admin / Config | Cfg all | Cfg (no security) | — | — | — | — | — | — | — | Commissions Cfg | — | — |
| Audit log | V | V | V | — | — | — | — | — | — | V (finance) | — | — |

### Appendix C: Automation examples (seed)
1. **Deal → Won (NET/SPT/ENT):** create Migration Project from template; notify onboarding and COO; create a "kickoff call within 3 days" task.
2. **Deal → Contract:** require NDA doc = Signed; create "follow up on signature" task at +3 days.
3. **Email with intent = "pricing/terms" on ENT deal:** suggest "Proposal" stage; create a task "Send pro forma v1" (48h).
4. **New account with MUU ≥ 10M:** set priority to Top 10; route to an SVP (round-robin between Chris and Will); alert.
5. **R100 company reaches Made First Post:** mark Live; accrue intern or SDR activation bonus; schedule a month-2 participation check.
6. **ADS invoice due in 3 days:** notify owner; on Paid, accrue commission.
7. **Commission-rep registration approved:** set ownership protection for 90 days; notify the rep.

### Appendix D: AI output schemas (abbreviated)

**Email analysis**
```json
{
  "thread_id": "string",
  "linked": {"account_id": "?", "deal_id": "?", "confidence": 0.0},
  "intent": "interested|objection|scheduling|legal|pricing|not_interested|ooo|referral|other",
  "awaiting_reply_from": "us|them|none",
  "commitments": [{"by": "us|them", "person": "string", "text": "string", "due": "ISO-8601|null", "evidence": "quote"}],
  "progress_signals": [{"type": "nda_signed|demo_requested|legal_review|pricing_requested|contract_sent|other", "evidence": "quote"}],
  "suggested_stage": {"stage": "string|null", "confidence": 0.0, "reason": "string"},
  "sentiment": -1.0,
  "risk_flags": ["string"]
}
```

**Transcript analysis**
```json
{
  "summary": ["5 bullets"],
  "decisions": ["string"],
  "action_items": [{"owner": "us|them|<name>", "task": "string", "due": "ISO|null", "evidence": "quote", "timestamp": "hh:mm:ss"}],
  "objections": [{"objection": "string", "response_given": "string", "recommended_rebuttal_id": "string"}],
  "qualification": {"muu_confirmed": "number|null", "decision_maker": "string|null", "current_stack": ["string"], "pain": ["string"], "timeline": "string|null", "rev_share_appetite": "string|null", "nda_status": "string|null", "migration_complexity": "low|med|high|null"},
  "competitors": ["string"],
  "risks": ["string"],
  "sentiment": -1.0,
  "suggested_stage": {"stage": "string|null", "confidence": 0.0},
  "field_updates": [{"field": "string", "value": "any", "evidence": "quote"}],
  "follow_up_email_draft": {"subject": "string", "body": "string", "claims_check": "pass|flagged"}
}
```

### Appendix E: Key acceptance tests (samples)
- **AT-01** A user on a non-allowlisted domain without an invite cannot sign in. An invited commission rep signs in and sees only their own records and registered accounts.
- **AT-02** An intern opens an ENT deal URL directly → 403. Revenue-share fields are absent from the API response, not just hidden in the UI.
- **AT-03** Importing the v7 workbook produces 0 duplicate domains. "1.5–2M" is stored as 1,750,000 with the raw string retained. "Chris/Will" becomes a 50/50 split.
- **AT-04** Sending "I'll send the contract by Friday" from a connected Gmail creates a task due Friday within 2 minutes, with the quote as evidence.
- **AT-05** Uploading a .vtt transcript to a deal yields a summary, action items and a follow-up draft within 5 minutes. Accepting 3 of 5 action items creates exactly 3 tasks.
- **AT-06** A deal with no activity for 6 days in "Hot" (SLA 5) raises NS-03 to the owner, and escalates to the manager 2 business days later if unresolved.
- **AT-07** The Copilot, asked by an SDR "what are the NY Post deal terms?", refuses (restricted/permission), and the attempt is logged.
- **AT-08** A draft containing a banned claim is flagged with the approved alternative before send.
- **AT-09** A bulk probability change on 147 deals requires executive approval. After approval the Executive dashboard shows "includes manual overrides: $X".
- **AT-11** A scout search "Finance, US+UK, 500K–10M MUU, independent" returns scored candidates. Domains already in the CRM show their existing owner and stage, and are never duplicated on accept.
- **AT-12** Running enrichment on an account with target roles CEO/Publisher/CRO returns staged contacts with email verification status within 5 minutes. Only "valid" emails auto-promote (per admin rule), and the run cost is logged.
- **AT-13** An intern who hits their monthly Apify cap is blocked from new runs, with a message and a request-more-budget button routed to their SVP.
- **AT-10** The dashboard reproduces the C&W Summary tab counts (TheStreet active deals, current-client annualized revenue, NetDev migrating count, RTB100 live accounts), or lists reconciling items.
