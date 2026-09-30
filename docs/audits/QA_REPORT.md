# QA Report — Roundtable Sales OS (rtb-crm, branch `main`)

**Date:** 30 Sep 2026 · **Build under test:** lead's dev server `http://localhost:3000` (Next 16.3.7 dev, real imported data) · **Tester:** QA lead (automated browser + curl + read-only SQL)
**Scope:** PRD Appendix E acceptance tests, per-role core journeys, RBAC UX, §16A design conformance, 375 px responsive, performance, console/server errors.
**Method:** Built-in browser pane (1024×768 viewport, 375×812 mobile emulation), `curl` with per-role session cookies for timings/RBAC, read-only SQL via `scripts/_db.ts` for verification. All test data used the `[test] qa` prefix and was deleted at the end (see §9).
Screenshots: `docs/audits/screens/qa-*.jpg`.

> Environment caveat: other auditors hit the same dev server and database at the same time, and source files were being hot-reloaded during the run. Timings and the intermittent DB failures (QA-01) may be worse than on an idle server, but QA-01 reproduced deterministically for several minutes and left a backend wedged in `ClientRead`, so it is a real defect, not only load.

---

## 1. Summary scorecard

| Area | Result | Notes |
|---|---|---|
| Acceptance tests (AT-01..13) | **4 pass · 4 partial · 3 fail · 2 not testable** | Fails: AT-04 degraded UX, AT-08 claim guardrail, AT-09 bulk overrides. See §2 |
| Core journeys | **Mostly working** | Deal create → gate → won → migration, notes, @mentions, splits, import/rollback, scout, proposals, R100, invoices and approvals all work end to end |
| RBAC UX | **Good** | Nav matches Appendix B; forbidden pages render clean "No access"/"Deal not found"; rev-share/guarantee stripped server-side. Pages return HTTP 200 instead of 403 |
| Design system §16A | **Good, with polish issues** | Tokens, fonts, monochrome chrome, pastel motion colors and focus rings are right. Problems: clipping at 1024 px, chart labels dropped, a few badges with the wrong status semantics |
| Responsive 375 px | **Fail on the global header** | Topbar overflows by 108 px on every page (bell and user menu are off-screen). Page bodies stack well |
| Performance | **Poor under load** | Most pages 1–2.5 s warm, but random ~31 s hangs then 500s; /analytics/quality ~7 s; server actions 5–10 s; Copilot 15–25 s |
| Console / server errors | **Needs work** | 48 server ERROR lines: 26 "Failed query", 10 stream-closed, 4 hydration mismatches, 2 SSR fallbacks, 1 TypeError; React key warning on the board |

**Bug count:** 0 Blocker · 8 Major · 18 Minor · 2 Cosmetic (28 grouped entries, §4). QA-01 (DB hangs) and QA-02 (claim guardrail bypass) are the top candidates to escalate to Blocker before production.

---

## 2. Acceptance tests (PRD Appendix E)

| AT | Result | Evidence / notes |
|---|---|---|
| AT-01 non-allowlisted domain / commission rep scope | **Partial pass** | Google OAuth isn't configured, so a non-invited Google sign-in can't be tested. Pre-provisioning `qa.outsider@gmail.com` is rejected ("That email isn't on an allowed sign-in domain"), but only as a toast. The commission rep sees **0 accounts** until a registration is approved, and the rep portal shows only their own accruals and registrations. |
| AT-02 intern → ENT deal URL = 403; rev-share absent from API | **Partial pass** | Intern gets an in-page "Deal not found" with no data in the RSC payload (0 matches for the deal name or MUU). **The HTTP status is 200, not 403** (QA-09). For the commission rep, `revSharePct`, `guaranteeType` and `guaranteeMonthlyCents` are serialized as `$undefined`, and RTB-net figures are not rendered. |
| AT-03 import: 0 duplicate domains, "1.5–2M" → 1,750,000 raw kept, "Chris/Will" 50/50 | **Pass** | SQL: 0 duplicate normalized domains. `audience_metrics.raw_value='1.5-2M' → value 1750000`. Chris/Will deals have 50/50 splits, and every deal's splits total 100%. The import wizard preview with my 3-row CSV shows the same parsing. |
| AT-04 Gmail promise → task (degraded UX check) | **Fail (degraded UX)** | Gmail isn't configured (expected). The "Connect inbox" CTA on My Day, Inbox and the Settings banner links to `/settings#connections`, which has **no Gmail/Google section and no "not configured" message**. The user hits a dead end (QA-05). The Inbox empty state is otherwise good. |
| AT-05 .vtt transcript → summary, action items, draft; accept 3 of 5 → 3 tasks | **Pass (with issues)** | A pasted WEBVTT on a test deal was analyzed in about 60 s (gpt-5-mini): summary with timestamps, 5 action items, follow-up draft ("Claims check passed"), stage suggestion. Applying 3 of 5 created **exactly 3 tasks** (`origin=call_ai`) and left the stage unchanged. Issues are in QA-11: the form resets to all-checked after apply, the stage suggestion is pre-checked, and a "(next week)" item got this Friday as its due date. |
| AT-06 Hot deal idle 6 days → NS-03 to owner, escalate to manager | **Partial** | I backdated a test Hot deal owned by the SDR by 6 days and ran Admin "Run sweep now" (28/35 rules, 5.8 s). **NS-03 was raised to the SDR** (plus NS-27), and it shows on the SDR's My Day. **Escalation can't happen:** no user has a manager and no team has a lead, so every "→ manager" path is a silent no-op (QA-04). |
| AT-07 SDR asks Copilot "NY Post deal terms?" → refuses + logged | **Pass (note)** | No terms leaked; the ENT deal is invisible to the SDR. `audit_log` has `copilot.access_denied` entries (tool `search_records`). The reply says "no deals visible to you" rather than stating a permission restriction. |
| AT-08 banned claim flagged with approved alternative before send | **Fail** | The Admin claims tester flags "paid in 8 seconds" and "$100M audited revenue". The Copilot, however, (a) printed an "Aggressive" draft containing both claims in plain chat with no check, and (b) its `draft_email` card showed **"Claims check passed"** for the body *"our platform pays publishers in 8 seconds, and RTB has $100M in audited revenue"*, flagging only MNPI. The regexes miss paraphrases (QA-02). Screenshot `qa-copilot-banned-claim.jpg`. |
| AT-09 147 overrides need exec approval; exec dashboard "includes manual overrides" | **Fail** | All 147 imported overrides are SPT at 100% with `override_status=pending`, but **there are no `approvals` rows**, so the exec's Approvals tab shows only my test override. NS-18 ("147 probability overrides need approval — Review in Approvals") points to an empty list (QA-03). They are correctly **excluded** from weighted totals (SPT $91.8M = stage probabilities only). The single-override flow works: SVP requested 90→40%, exec approved from Approvals, and the Executive dashboard shows "Manual override exposure +$0 · 1 deals overridden · 147 pending approval" with an Incl./Excl. overrides toggle. |
| AT-10 dashboard reproduces C&W summary or lists reconciling items | **Partial** | Matches: TheStreet current-client annualized **$1.15M / 7** ✓; R100 live **30** (vs 24, reconciled in IMPORT_REPORT) ✓; NET/ENT/SPT gross, weighted and MUU are internally consistent with SQL. Mismatches on the Revenue page (QA-08): "Active deals closing" **$300K / 2** vs C&W **$410K / 4**; "Upcoming collections 60D" **$0 / 0** vs C&W **$260K / 7**; "Warm deals in negotiation" **$1.26M / 17** vs **$1.1025M / 14**. There are no reconciling notes for these. |
| AT-11 scout search returns scored candidates; CRM domains show owner and stage; no duplicates on accept | **Pass (domain-list mode)** | A 5-domain list (1 existing, 4 new, with manual MUU) ran for $0. The existing `coindesk.com` shows "Open deal: Andres (placeholder), Cold / Nurture". Accepting one new domain created an account and a Target deal with "First outreach" due in 2 business days; rejecting one asked for a reason. Scoring issues are in QA-10. |
| AT-12 enrichment → staged contacts with verification | **Not testable** | Apify isn't configured. The Scout banner, New-search page and deal "Find executives" explain what needs Apify. |
| AT-13 intern hits Apify cap → blocked + request-budget | **Not testable** | Needs Apify. The budget line is shown ("You: $2.00 left of $2.00 · Org: $10.00 of $10.00"). |

---

## 3. Per-module results (journeys)

| Module / journey | Role(s) | Result | Notes |
|---|---|---|---|
| Sign-in (developer form), sign-out | all 7 | ✓ | Google button disabled with a clear "not configured" hint. Better Auth rate-limits to 3 sign-ins per ~10 s (429). |
| My Day | superadmin, SDR, finance | ✓ | KPI tiles, alerts with severity badges, approvals block and empty states. The SDR sees its NS-03/NS-27 alerts. |
| ⌘K search & navigate | superadmin | ✓ | Deals, accounts and contacts plus "Ask Copilot". About 2 s to populate; the "Go to" group rendered empty at first. |
| Pipelines overview | superadmin, exec | ✓ | Weighted/won/open per motion; math verified in SQL. Cold/Nurture at 10% contributes $159M of NET's $554.5M weighted (product question). |
| NET board: create deal (required next step), drag, gate, won | superadmin | ✓ with issues | Create is disabled until next step is filled. Drag Target→Outreach works. Contract gate modal asks for MUU + primary contact (inline "+ New contact"), and the gate is also enforced on create. The Won dialog requires a note, and the **migration project is created** (owner null). Issues: QA-07 orphan account, QA-18 menu unresponsive after actions, BoardToolbar key warning, board SSR failed once (QA-01). |
| Deal record | superadmin, SVP, exec | ✓ | AI summary refresh (gemini-2.5-flash, cited sources), note, comment with @mention (the exec receives a `mention` notification), splits editor (validates 130% total; 70/30 saved), stakeholders, probability override request → exec approval. |
| Accounts list | superadmin | ✓ | Sort (URL-synced), Lifecycle filter (57), pagination 2/2 and export link all work. Hydration mismatch on relative times (QA-15). |
| Account 360 / create / dedupe / merge | superadmin | ✓ | Dedupe normalizes `https://www.CoinDesk.com/markets`, shows "already belongs to CoinDesk" and disables Create. Merge dialog works, but duplicate names are indistinguishable (QA-22). |
| Import wizard + rollback | superadmin | ✓ | CSV auto-mapped 8/9 columns. Preview: "1.5-2M" → 1.75M, "Chris / Will" split, stage mapping. Commit created 3/3/3; one-click rollback soft-deleted everything. The "Recent imports" list didn't show the new batch until reload. |
| Tasks: create, snooze ×3, complete | superadmin | ✓ / ✗ | Create (no due date allowed), snooze with reason ×3 (count 3, "Snoozed 3×" warning badge) and complete all persist. **NS-26 doesn't fire** because there is no manager (QA-04). Timezone display issue (QA-12). No optimistic UI (QA-18). |
| Alerts / sweep | superadmin, SDR, exec | ✓ | "Run sweep now" toast gives stats. Alerts have done/snooze/more actions. 7 of 35 enabled rules aren't implemented (28 evaluated). |
| Inbox / Calls empty states | SDR | ✓ / ✗ | Good empty states; Connect-inbox CTA is a dead end (QA-05). Calls: "Add transcript" / "Connect Granola". |
| Calls: paste transcript → analysis → apply | SDR | ✓ | See AT-05. |
| Copilot (3 prompts) | SVP, SDR | ✓ / ✗ | Pipeline risk: tool call "deals at risk · 0" (weak for an SVP with 0 owned deals). Meeting prep: `search_records` + meeting brief with approved proof points and objections ✓. Banned-claim draft ✗ (QA-02); invented recipient (QA-13). Replies take 15–25 s. |
| Lead Scout | SDR | ✓ | See AT-11 and QA-10. |
| R100 page | superadmin | ✓ | Inline post count and M1 participation saved (`r100.postCount=3`, `participation[0]=true`). Charts are late or have dropped labels (QA-25). |
| Revenue: invoice on ADS deal | finance | ✓ | "Schedule invoice" $25K; collections tile updated to $25K / 1. |
| Onboarding board | superadmin | ✓ | 20 active; the test won deal appeared in Discovery. |
| Commissions | finance, commission rep, SVP | ✓ / ~ | Rep portal and registrations work: the rep registered a new domain ("No conflicts"), and the SVP approved it from Approvals. Finance "Run accruals" gives no feedback with 0 plan assignments (QA-24); accrual math is untested because there are no assignments in the DB. |
| Proposals: pro forma, approval trigger, print | superadmin | ✓ / ~ | NY Post scenario; 30% share triggered "Needs executive approval"; print/export is **blocked until approved** ✓; share math verified (30% × $98.0M in-scope = $29.4M). Self-approval was allowed (QA-14). The one-pager wording is QA-23. |
| Analytics | exec, intern | ✓ / ~ | KPIs, Gross/RTB-net toggle (`?basis=net`), override toggle, charts with legend and "Table" view. The intern sees "Your own records" with the gross/net toggle hidden. The exec dashboard timed out once ("Couldn't load… Ref …"), with a graceful retry (QA-01). "Slipped 984 this week" is inflated by imported rows. |
| Admin | superadmin | ✓ | Users: pre-provision (domain check), deactivate with reassign. Roles matrix loads; settings "Test model" returns in 1.7 s; claims tester works; audit log is filterable with CSV. **/admin/pipelines and /admin/teams returned 500 after ~32 s on 6/6 consecutive tries** during the DB wedge (QA-01). No config was saved. |

---

## 4. Bug list (severity-ordered)

| ID | Sev | Page / role | Steps to reproduce | Expected | Actual | Evidence | Suspected file(s) |
|---|---|---|---|---|---|---|---|
| **QA-01** | Major | Any page, any role (seen on /home, /analytics, /analytics/scout, /analytics/ai, /admin/pipelines, /admin/teams, NET board) | Load pages while other sessions are active; e.g. `curl -b superadmin /admin/teams` repeatedly | Pages render in <2.5 s | Random requests hang **31–33 s**, then HTTP 500 or "Switched to client rendering". The server log shows 26× `Failed query: select … from rso.pipelines/stages/approvals/email_threads…` with the cause swallowed. `/admin/pipelines` and `/admin/teams` failed 6/6 consecutively. `pg_stat_activity` showed an `rso_app` backend **`active` / `ClientRead` for 3 min 25 s** on a picklists query (protocol desync / half-sent statement behind the pooler) | `.next/dev/logs/next-development.log`, console on NET board | `src/db/index.ts` (Supavisor transaction pooler, `max: 5`, `max_pipeline: 1`, no query/idle timeouts, errors not logged with cause); `dealAccessWhere` loads pipelines on every call |
| **QA-02** | Major | Copilot (any role) | Ask "Draft a short follow-up email to CoinDesk telling them publishers get paid in 8 seconds and we have $100M audited revenue", then reply "B" | Banned claims flagged with the approved alternative; no unchecked draft text | 1st reply prints an "Aggressive" draft with both claims in plain chat. 2nd reply's `draft_email` card says **"Claims check passed"** for "pays publishers in 8 seconds … $100M in audited revenue". The patterns `paid in \d+ seconds` and `\$?100\s?m… audited` don't match those paraphrases (verified with node) | `screens/qa-copilot-banned-claim.jpg` | claim patterns seeded in `scripts/seed.ts` / `claims` table; Copilot `draft_email` tool and the chat response path (no post-generation claim filter) in `src/lib/copilot/*` |
| **QA-03** | Major | Tasks → Approvals (exec); NS-18 alert | Sign in as exec → Tasks → Alerts ("147 probability overrides need approval — Review in Approvals") → Approvals | The 147 pending overrides are listed and can be approved or rejected in bulk (AT-09) | Approvals lists only newly requested overrides. `approvals` has **0 rows** for the 147 imported overrides (`deals.override_status='pending'` only), so they can never be approved from the UI | `screens/qa-exec-approvals-missing-147.jpg`, `qa-ns18-alert-points-to-approvals.jpg` | `scripts/import-spreadsheets.ts` (no approval rows written); approvals query / NS-18 target in `src/lib/approvals*`, `src/lib/alerts/engine.ts` |
| **QA-04** | Major | Alerts engine, Admin → Users/Teams | Snooze a task 3× (dialog says "a 3rd snooze notifies your manager"); or run a sweep for an overdue deal | Manager or fallback approver notified (NS-26, NS-01/02/03 escalations) | Nothing happens: `user.manager_id` is null for all users and every team's `lead_id` is null. `managerOf()` returns null and `ns26Candidate` silently returns null. No admin warning that escalation is unconfigured | SQL on `rso.user`, `rso.teams` | `src/lib/alerts/engine.ts` (`managerOf`, `ns26Candidate`, escalation step); Admin Users/Teams (no required manager/lead); `scripts/seed.ts` (dev users have no manager) |
| **QA-05** | Major | My Day / Inbox / Settings (SDR) | Click "Connect inbox" | Gmail connect flow, or a clear "Gmail isn't configured — ask an admin" state | Goes to `/settings#connections`, which lists only Granola and a Zoom note. There is no Gmail/Google entry and no explanation (AT-04 degraded UX) | page text of /settings | `src/app/(app)/settings/page.tsx` (connections section), `src/components/shell/*` onboarding banner |
| **QA-06** | Major | Every page at 375 px | Emulate 375×812; open /home | Header fits; bell and user menu reachable | The topbar search trigger (`w-full max-w-md`, doesn't shrink) pushes the bell and account menu to x=399–483. `scrollWidth` is 483, so every page has 108 px of horizontal overflow and sign-out/notifications are off-screen | `screens/qa-mobile-myday-header-overflow.jpg` | `src/components/shell/topbar.tsx` (search button ~L50, `ml-auto flex` group L61) |
| **QA-07** | Major | Pipelines → New deal (superadmin) | New deal → type a new account name ("Create account …") → pick stage Contract with no MUU → Create (rejected: "Contract requires MUU…") → switch stage to Hot → Create | One account, one deal | **Two accounts named "[test] qa Hotdeal"** (one orphan, 0 deals). The account is inserted before the gate check with no transaction, and domain-less accounts aren't name-deduped | SQL (2 rows, created 9 s apart) | `src/lib/deals/actions.ts` (createDeal / inline account creation) |
| **QA-08** | Major | Revenue (finance) — AT-10 | Open /revenue and compare with the IMPORT_REPORT C&W summary | $410K / 4 active closing; $260K / 7 upcoming collections; $1.1025M / 14 warm | $300K / 2 active closing (Negotiation excluded), **$0 / 0 upcoming collections** (ignores imported `next_payment_*`, counts invoices only), $1.26M / 17 warm (includes Negotiation). No reconciling items shown | `screens/qa-revenue.jpg` | `src/lib/revenue/queries.ts` (tile definitions) |
| **QA-09** | Minor | Direct URLs (intern/SDR/commission) | `curl -b intern /deals/<ENT id>`, `/revenue`, `/admin` | 403 (AT-02) / 404 status | HTTP **200** with an in-page "Deal not found" / "No access". `/import` shows the unbranded Next default 404 page | curl output | `src/app/(app)/**/page.tsx` (use `forbidden()` / `notFound()` status; add a branded `not-found.tsx`) |
| **QA-10** | Minor | Lead Scout (SDR) | Domain list with MUU 0.8M, 3.5M, 12M; expand rows | Audience score varies with MUU; explanation matches routing | All three score **45** with Audience=25. 12M says "in the NET sweet spot" while routing to ENT. Run summary says "5 new domains" though coindesk.com is in the CRM | `screens/qa-scout-review-queue.jpg` | `src/lib/scout/scoring*.ts`, run summary in scout service |
| **QA-11** | Minor | Call detail → Apply selected (SDR) | Uncheck 2 of 5 items and the stage change → Apply | Items marked applied / removed; stage change opt-in | Toast "Applied: 3 tasks" ✓, but the list re-renders with **all 6 re-checked** (incl. stage) and no applied state, so a second click duplicates tasks or moves the stage. The stage suggestion is pre-checked. "(next week)" item due this Friday | `screens/qa-call-analysis.jpg` | `src/components/calls/*` apply form, `src/lib/calls/actions.ts` |
| **QA-12** | Minor | Tasks snooze / Import history / My Day | Snooze → "Tomorrow 9:00" (browser in EEST, profile ET) | 9:00 in the user's timezone | Stored 06:00Z and shown "Oct 1, 2:00 AM". Import batch header shows machine-local "05:20" while the rest of the app shows ET. Deal "Created 30 Sep" while My Day says "Tuesday, Sep 29" | screenshots | snooze presets in `src/components/tasks/task-list.tsx`; `src/lib/format.ts` usage on import pages |
| **QA-13** | Minor | Copilot draft_email | Same as QA-02 | Recipient chosen from CRM contacts or left blank | To: `editor@coindesk.com`, which isn't in the CRM (CoinDesk contacts are advertising@, jennifer.sanasie@, …) | page text | Copilot `draft_email` tool |
| **QA-14** | Minor | Proposals (superadmin) | Create a pro forma below the 40% floor → Approve as the same user | Requester can't approve own request (SoD) | `requested_by = decided_by` → approved | SQL | `src/lib/proposals/actions.ts` / approvals decide |
| **QA-15** | Minor | /accounts; NET board | Load /accounts; open board console | No hydration errors or React warnings | Hydration mismatch "13 minutes ago" vs "12 minutes ago" (`src/components/accounts/server-table.tsx:95`). React "unique key" warning in `BoardToolbar` (PipelineBoardPage). 10× "destination stream closed early" | log | `src/components/accounts/server-table.tsx`, `src/components/deals/board/*toolbar*` |
| **QA-16** | Minor | Deal page, Account 360, Admin tables @1024 px | Open a won deal with values | Values fit | KPI tiles clip "$2.50l", "2.50M", "WEIGHTEI"; account MUU "ESTI…" badge clipped; Admin Users/Alert-rules tables clip right columns, and codes wrap "NS-/01" | `screens/qa-deal-kpi-clipping.jpg`, `qa-admin-alert-rules-clipped.jpg` | deal header KPI grid (`src/components/deals/*header*`), admin tables |
| **QA-17** | Minor | Deal health | Open any imported deal never touched | Low or neutral health for no activity / no DM | 92 "Healthy" (all imported deals), 85 for a brand-new empty deal | board | `src/lib/deals/health*.ts` |
| **QA-18** | Minor | Board "…" move menu, task snooze, task complete | Perform a server action, then immediately use another control | Controls stay responsive; optimistic feedback | For several seconds ("Rendering…" badge) clicks on the move menu and snooze button did nothing (reload fixed it). Complete/snooze/approve have no optimistic state (5–10 s lag) | session notes | router refresh after actions; kanban card drag listeners on the menu trigger (`src/components/deals/board/kanban.tsx`) |
| **QA-19** | Minor | Board / Accounts (finance) | Finance opens NET board | "Export" available (Appendix B: Finance Export ✓) | CSV button hidden for finance | screenshot | board toolbar permission check |
| **QA-20** | Minor | Owner filters, data | Open the owner filter on Accounts/Analytics | Real reps only | Includes junk placeholders "News", "Politics", "Zed", "Ben", "Will" (0 owned records) and deactivated users. Account "9F Inc." has domain `facebook.com`, which blocks a real Facebook/Meta account via dedupe | filter options, SQL | `scripts/import-spreadsheets.ts` (owner parsing, domain source); filter queries |
| **QA-21** | Minor | Admin → Pre-provision | Enter a gmail.com address → Pre-provision | Inline field error (ENGINEERING UI rule) | Toast only; the field isn't marked | screenshot | admin users form |
| **QA-22** | Minor | Scout accept, Merge dialog, gate hint | Accept a target; open Merge with duplicate names; pick Contract in New deal | Clear copy | Dialog title "Accept 0 targets" after success. Merge picker shows two identical "[test] qa Hotdeal" rows (no domain/owner/id). Hint "Requires: muu, primaryContactId" (raw keys) | screenshots | scout accept dialog, merge dialog, new-deal dialog |
| **QA-23** | Minor | Proposal one-pager print | Print an approved pro forma with a profit-floor guarantee | Guarantee copy uses the approved claim wording ("…subject to contract terms") | Prints "100% of today's profit — baseline guaranteed" with no qualifier; collateral text isn't claim-checked | `screens/qa-proposal-print.jpg` | `src/app/(app)/proposals/[id]/print/page.tsx` |
| **QA-24** | Minor | Commissions (finance) | "Run accruals" with no plan assignments | Result toast / guidance ("0 assignments — assign plans first") | Button spins, then nothing | — | commissions run action |
| **QA-25** | Minor | R100, Revenue charts | Open /r100 and /revenue | Charts render with every category labeled | Chart cards blank for 6–10 s. Funnel and customer-concentration bars label every other category. `/r100?q=` ignored. Burn-up y-ticks 0/30/60/108 | `screens/qa-r100-charts-before-hydration.jpg`, `qa-r100.jpg` | `src/components/r100/*`, revenue charts (YAxis `interval={0}`) |
| **QA-26** | Minor | Won deal / onboarding | Mark a deal won | Next step closed or replaced; onboarding owner assigned | Won deal keeps "QA intro call" as next step and Copilot recommends it. Migration project `owner_id` is null | SQL | won handler in `src/lib/deals/actions.ts` |
| **QA-27** | Cosmetic | Various | — | — | Avatar initials "D(", "A(", "E(" from "(placeholder)" names. "1 deals overridden". Admin Settings labels "Email backfill (days) (days)", "(hours) (hours)", "(pts) (pts)". "Info" alert badge uses the green ✓ *good* style; "Analyzing" uses the warning "!" style. Truncated "Collaborato" select. Tab titles "Account · Roundtable" / "Deal · Roundtable" instead of the record name | screenshots | `src/components/ui/*` avatar/badge, admin settings labels |
| **QA-28** | Cosmetic | Long pages (e.g. /commissions scrolled) | Scroll to the bottom | Shell (sidebar + border) spans full height | Sidebar border stops mid-page; content extends past the shell container | screenshot during registration | `src/app/(app)/layout.tsx` shell height |

---

## 5. Design-system conformance (§16A)

**Conforms**
- Background `rgb(7,7,7)` (#070707); cards #0B0B0B; raised #1A1A1A; hairline borders; **0 box-shadows** in `main`.
- Fonts: Work Sans 300 body (1,260 text nodes), 500 labels, 600 strong; Playfair Display for headings and hero numbers; all weights configured in `layout.tsx`.
- Primary buttons are white with black text; secondary is outlined; ghost is text only.
- Visible **2 px white focus outline** on keyboard focus.
- Motion colors are correct and fixed: NET blue, ENT lilac, SPT mint, R100 butter, ADS peach, as ticks on boards, cards and charts. Status badges use icon + label.
- Charts: thin bars, legends, tooltips, "View as table"/"Table" toggles, notes on gross vs net / estimate basis.
- Empty states on every list tested, and skeleton loaders on deal, board and My Day. No light-mode leaks: the only white surfaces are primary buttons.
- The Copilot box uses the Playfair italic "Copilot" label and a surface-2 panel with a left rule, per spec.

**Deviations**
- Clipping at 1024 px on deal KPIs, the account MUU tile and admin tables (QA-16). Mobile header overflow (QA-06).
- Status semantics: "Info" rendered as *good* (green ✓); "Analyzing" rendered as *warning* (QA-27).
- Charts drop alternate category labels and render late (QA-25). The Burn-up axis ends at 108 instead of the goal of 100.
- Empty states use an icon, not the "line illustration in #3C3C3C" from the spec (acceptable).
- Error text is set in rose, e.g. the splits validation (spec: color only in icons for destructive; minor).
- Several inputs lack accessible labels: Scout MUU min/max, search name, ownership checkboxes. R100 inline controls are labeled.

---

## 6. Responsive (375 × 812)

| Page | Result |
|---|---|
| My Day | Body stacks well (2-column KPI tiles). **Header overflows by 108 px**: bell and user menu are off-screen (QA-06) |
| NET board | Header stats wrap acceptably; filters wrap; columns scroll horizontally inside the board (OK); same header overflow |
| Deal page | Good: KPI tiles fit in 2 columns (better than at 1024 px), stage path scrolls, actions wrap |
| Accounts list | Filters stack; table scrolls horizontally inside its card (acceptable), only the name column visible |
| Copilot | Usable; chat panel then quick actions stacked; the chat opens scrolled past its intro |

---

## 7. Performance (`curl -w %{time_total}`, superadmin cookie; cold / warm1 / warm2, seconds)

| Page | Status | Cold | Warm 1 | Warm 2 | Flag |
|---|---|---|---|---|---|
| /home | 200 | 2.37 | **32.15** | **3.20** | ⚠ hang + >2.5 s |
| /pipelines | 200 | 2.10 | 1.79 | 1.91 | |
| /pipelines/NET | 200 | 3.26 | **2.71** | **2.57** | ⚠ >2.5 s |
| /pipelines/ENT | 200 | 1.69 | 1.62 | 1.64 | |
| /pipelines/R100 | 200 | 2.27 | 2.28 | 2.30 | |
| /pipelines/ADS | 200 | 1.63 | 1.65 | 1.73 | |
| /accounts | 200 | 1.09 | 1.03 | 0.96 | |
| /contacts | 200 | 0.93 | 0.90 | 0.93 | |
| /tasks | 200 | 1.07 | 1.03 | 1.01 | |
| /inbox | 200 | 0.97 | 0.96 | 0.89 | |
| /calls | 200 | 0.98 | 0.97 | 0.92 | |
| /proposals | 200 | 1.15 | 1.07 | 1.11 | |
| /onboarding | 200 | 1.36 | 1.33 | 1.33 | |
| /r100 | 200 | 2.29 | 2.19 | 2.22 | (charts +6–10 s client) |
| /revenue | 200 | 1.44 | 1.28 | 1.36 | |
| /commissions | 200 | 1.29 | 1.28 | 1.29 | |
| /analytics | **500** | **31.9** | **31.8** | **31.1** | ⚠ later 200 in 3.7–4.6 s |
| /analytics/funnel | 200 | 3.59 | 1.76 | 1.69 | |
| /analytics/reps | 200 | 2.20 | 2.14 | 2.17 | |
| /analytics/health | 200 | 2.48 | 2.45 | 2.42 | borderline |
| /analytics/netdev | 200 | 1.79 | 1.74 | 1.71 | |
| /analytics/quality | 200 | **6.91** | **7.36** | **6.92** | ⚠ consistently slow |
| /analytics/scout | 200 | 1.89 | **31.3** | **32.7** | ⚠ hang |
| /analytics/ai | 200 | 1.81 | **32.3** | **3.42** | ⚠ |
| /copilot | 200 | 1.34 | 1.23 | 1.21 | replies 15–25 s |
| /scout | 200 | 2.55 | 1.63 | 1.65 | |
| /import, /import/history | 200 | 1.40 / 1.37 | 1.26 / 1.30 | 1.25 / 1.34 | |
| /admin/users, /roles, /settings, /alerts, /claims, /fields, /products | 200 | 1.2–1.6 | 1.1–1.5 | 1.1–1.4 | |
| /admin/audit | 200 | 2.14 | 2.10 | 2.05 | |
| /admin/pipelines | **500** | **31.8** | 2.23 | 1.31 | ⚠ later 500 ×3 (~32 s) |
| /admin/teams | **500** | **31.4** | **32.1** | 1.14 | ⚠ later 500 ×3 (~32 s) |
| /settings | 200 | 2.33 | 2.02 | 2.01 | |
| /api/search?q=… | 200 | — | ~0.5–2 | | |

Other roles' warm /home: exec 3.5 s, SVP/SDR/intern/commission/finance ~1.7 s. Server actions (create deal, move stage, snooze, approve) took **5–10 s** to reflect. One NET board render took ~30 s (SSR failed, then client re-render).

---

## 8. Console & server errors

- Server log (`.next/dev/logs/next-development.log`, 117 lines during the session): **48 ERROR**
  - 26× "Failed query" (QA-01)
  - 10× "The destination stream closed early"
  - 4× hydration mismatch (accounts relative time, QA-15)
  - 2× "Switched to client rendering because the server rendering errored" (board / `dealAccessWhere`)
  - 1× `TypeError: Cannot read properties of undefined (reading 'map')` right after a failed `user` query (a page doesn't guard a failed load)
  - Plus entries from the parallel security auditor (Invalid origin / Invalid Server Actions request, expected)
- Browser console: the same Failed-query errors surface as uncaught errors (My Day `loadMyDay`, Tasks `listApprovals`), React duplicate-key warning in `BoardToolbar`, HMR websocket noise (dev only).

---

## 9. Test data cleanup

Created and then removed (all via the UI, plus a scratchpad tsx script built on `scripts/_db.ts`, dry-run first, single transaction):
- 12 accounts (incl. merged/rolled-back soft-deleted ones), 9 deals, 4 contacts, 4 tasks, 1 transcript, 1 proposal, 1 invoice (cascade), 1 lead registration, 1 migration project, 1 scout search (+ 5 candidates) and its run row, 1 pre-provisioned user, 1 comment, 3 approvals, 2 alerts, 9 import_records and 7 notifications tied to those records.
- The deal created by Scout accept was named after its domain (`qa-scout-one.example`); I renamed its account to "[test] qa scout one" in the UI, and the deal was deleted as a child of that test account.

**Verification after cleanup:** 0 rows with `[test] qa` in accounts, deals, contacts, tasks, transcripts, scout_searches, migration_projects, user and notifications. 0 `qa-*` domains or candidates. The **147 real pending overrides are untouched**. No real records were modified.
**Left in place intentionally:** append-only `audit_log` and `agent_runs` entries, and the rolled-back import batch header `qa_import.csv` (0 records; its file name has no `[test] qa` prefix). The browser session was restored to Dev Super Admin.

---

## 10. What works well

- The **gate and won flow** is solid: required next step on create, server-enforced stage gates (including on create), inline contact creation in the gate modal, mandatory win note, and an automatic migration project.
- **RBAC** is well implemented: nav filtering matches Appendix B, forbidden pages degrade cleanly, restricted and ENT data never appears in payloads or Copilot answers, field-level stripping works server-side, and Copilot access denials are audit-logged.
- **Import wizard** quality: header auto-mapping, MUU range parsing with the raw value kept, owner splits, merge-policy preview, and true one-click rollback.
- **Call intelligence**: fast, well-cited summaries, we-owe/they-owe items with timestamps, a claim-checked follow-up draft, and exact task creation.
- **Pro forma**: correct math, approval thresholds enforced, and export blocked until approved.
- **Analytics** labels its basis consistently (gross/net, estimate share, override exposure). Intern scoping works. Charts have "view as table".
- **Degraded states** for Google, Apify and Granola are mostly clear (Scout banner, sign-in page, Calls). AI features show engine and model provenance.
- The visual system is consistent and on-brand: dark editorial look, correct typography and motion colors, no shadows, visible focus.

---

## 11. Remediation status — UX / product fixes (30 Sep 2026)

Branch `worktree-agent-a8ee5944ad0ad651e` (UX/product fix engineer). QA-01, QA-02, QA-04, QA-12, QA-13 and QA-14 belong to the
security and data-integrity fix branches and aren't covered here. Verified on a dev server (`127.0.0.1:3013`) against the shared
database with the browser pane, `curl` per role, and SQL. Quality gates: `tsc`, `eslint --max-warnings=0` and `vitest` (399 tests) all pass.

| ID | Status | What changed | Verification |
|---|---|---|---|
| QA-03 | **Fixed** | `scripts/backfill-override-approvals.ts` (idempotent) created **one bulk** `probability_override` approval for all 147 pending imported overrides: approver executive, requested by `system:import`, note “Imported overrides per J. Heckman 29 Sep 2026”. Bulk apply skips deals already decided elsewhere. A system requester is labelled “the spreadsheet import (system)”. | Signed in as dev.exec → Tasks → Approvals shows “147 deals (bulk) · Requested 100%” with Approve / Reject (not decided). `fixed-exec-approvals-bulk-147.jpg`. Re-run → “up to date”. |
| QA-05 | **Fixed** | The Gmail + Calendar card always renders (only the OAuth-return handler is in Suspense). When Google isn’t configured it says “Google sign-in not configured — ask an admin (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)” and the button reads “Not available”. The mailbox banner copy matches. | `/settings#connections` scrolls to the card (scrollY 531, card top 80 px). `fixed-1024-settings-google-not-configured.jpg`. |
| QA-06 | **Fixed** | Below `sm` the search collapses to an icon button that opens ⌘K; bell and avatar can’t shrink. The shell clips stray x-overflow and `main` is `min-w-0`. My Day grid items are `min-w-0`. | 375 px scan on 20 routes (home, pipelines, NET board, accounts, contacts, tasks, inbox, calls, r100, revenue, proposals, onboarding, commissions, analytics, quality, settings, scout, copilot, deal, account): `scrollWidth` 375 and no element past the viewport. `fixed-375-home-header.jpg`, `fixed-375-net-board.jpg`. |
| QA-07 | **Fixed** | `createDeal` resolves the account without writing, runs the stage gate, then inserts account + deal in **one transaction**. Domain-less new accounts reuse a visible exact-name match. The dialog pre-checks the gate and keeps Create disabled. | Code path + typecheck. The client now blocks the rejected create, and the server can’t write before the gate. |
| QA-08 | **Fixed** | Active closing = Negotiation + Verbal + LOI. Warm = Warm stage only. Upcoming collections = open invoices in 60 days, plus the scheduled next payment of current clients that have no open invoice. | Live `/revenue` as finance: **$410K / 4 · $1.15M / 7 · $260K / 7 · $1.10M / 14**, matching C&W. Unit test builds the imported book. |
| QA-09 | **Fixed** | `experimental.authInterrupts`. `(app)/forbidden.tsx` plus branded `not-found` pages. Thin guard layouts run `forbidden()` before `loading.tsx` streams (revenue, commissions, calls, inbox, onboarding, proposals, accounts, contacts, import, copilot, scout, admin, analytics). `/deals/[id]` returns 403 for invisible *and* missing deals, so the status can’t be used to probe whether a deal exists. | `curl` as intern: ENT deal **403**, `/revenue` 403, `/admin` 403, `/import` 403, random deal id 403, `/nope` 404. The page renders “No access” inside the shell. |
| QA-10 | **Fixed** | The audience signal is log-graded: 25K→0, 250K→0.5, 1M→0.9, ≥10M→1. A shared `audienceBand()` means a ≥10M site reads “Enterprise-sized”, never “NET sweet spot”. The run note says “N domains to score”. | Tests: 0.8M, 3.5M and 12M give three different scores; 12M routes to ENT and the explanation agrees. |
| QA-11 | **Fixed** | Apply records item ids and field keys. Applied items show “Applied” and stay unchecked (immediately and after reload). The stage suggestion is never pre-checked. A relative phrase (“next week”) beats the model’s date guess. | Unit test (“next week” → Monday 5 Oct). |
| QA-15 | **Fixed** | `RelativeTime` (with `suppressHydrationWarning` and an absolute-date tooltip) is used in the accounts and contacts tables. BoardToolbar dedupes owners and categories. | No hydration or key warnings on /accounts or the NET board in this session’s console. |
| QA-16 | **Fixed** | Deal value tiles, Account 360 KPIs, `KpiTile` truncation with tooltips, and the admin nav are vertical only at `xl`. Headers and codes no longer wrap. | `fixed-1024-deal-kpis.jpg`, `fixed-1024-account-muu.jpg`, `fixed-1024-admin-alert-rules.jpg`. |
| QA-17 | **Fixed** | With no activity, the deal’s age counts against the stage SLA. Imported deals with no activity are capped at 60 (“needs review”). `scripts/backfill-health.ts` was re-run. | 3,073 deals changed. Distribution: **healthy 29 · watch 3,105 · at-risk 0 · critical 0 · unscored 44** (before: 3,085 of 3,117 open imported deals “Healthy”). A new empty deal scores 75. |
| QA-18 | **Partly fixed** | Task complete, reopen, cancel and snooze are optimistic, with per-row disabling instead of a global one. Deal comments are optimistic (`useOptimistic`). Stage moves were already optimistic. The board “…” menu being unresponsive during a slow refresh was not reproduced after the fixes; the remaining lag is server time (see QA-01). | Manual. |
| QA-19 | **Fixed** | Board CSV uses the wider of the pipeline export grant and the global Export grant (Appendix B: Finance ✓). Rows stay view-scoped and restricted deals are never exported. | `curl` as finance: the NET board renders “Export CSV”. |
| QA-20 | **Fixed** | `src/lib/users.ts`: pickers list active people only; filters list active people plus owners who still hold records. Used by Accounts, Account 360, Contacts, Contact and the Analytics owner filter. `scripts/cleanup-placeholders.ts` handled News, Politics and Zed, plus 9F Inc.’s facebook.com domain. | See IMPORT_REPORT “Post-import cleanup”. |
| QA-21 | **Fixed** | Pre-provision email: inline domain check on blur and submit; server email errors are mapped to the field (`aria-invalid` / `aria-describedby`). | Browser: `…@gmail.com` → “Use a @blockchainff.com or @roundtable.io address…” under the field (nothing submitted). |
| QA-22 | **Fixed** | The Scout accept dialog says “Accepted N of M targets” after the run. The merge picker shows domain · owner · created date. Gate hints use human labels. | Code + typecheck. |
| QA-23 | **Fixed** | The one-pager uses “Profit floor guarantee subject to contract terms” (card, P&L note, closing line). There are no dashes in client copy. | Code review of the print page. |
| QA-24 | **Fixed** | “Run accruals” explains *no plans assigned* (with a link to Assignments) and *up to date*, and toasts network failures. | Code + typecheck. |
| QA-25 | **Partly fixed** | Every category label is kept (`interval 0` with shortened names). Crowded vertical bars use angled labels. Burn-up axis 0/25/50/75/100. `/r100?q=&stage=` works. Charts show a skeleton until hydration: Recharts renders nothing server-side, so the first-paint delay is hydration time (mostly dev-mode overhead). | `fixed-1024-r100-charts-q-filter.jpg` (“coin” → 23 of 930). |
| QA-26 | **Fixed (won)** / **Deferred (lost)** | `onDealWon` clears next step, due date and waiting reason. The migration owner defaults to the deal owner. Clearing on *lost* belongs in `stage-service.ts` (data-integrity scope) and is listed for integration. | Code + typecheck. |
| QA-27 | **Fixed** | `initials()` ignores “(placeholder)”. Neutral `info` / `progress` badge states (Info and Analyzing). No “(days) (days)”. “1 deal overridden”. Split role select is wide enough for “Collaborator”. Tab titles use the record name for accounts, contacts, calls and pro formas (deals already did). | Unit test for `initials()`. |
| QA-28 | **Fixed** | The sidebar is sticky and full viewport height. | Screenshots above (border runs full height). |
| Perf | **Partly fixed** | `/analytics/quality`: the alt-domain duplicate check went from O(n²) to a semi-join (query 6.9 s → 0.1 s; page ~7–10 s → ~2–2.8 s). Added loading skeletons for analytics, admin, import, copilot and the record pages. | See the note below on My Day and the NET board. |

**Performance note.** I tried one parallel wave on My Day and concurrency 4 on the board loader. Both **reproduced QA-01**: 32 s hangs and `ECONNRESET` from the Supabase pooler once more than about 5 queries were in flight, even with `max_pipeline: 1`. I reverted both. My Day stays at ~1–3 s, and `/pipelines/NET` at ~2.4 s, dominated by `listDealsForBoard` selecting full deal rows (including `ai_summary` and JSON) for ~2,000 deals. That query is in data-integrity scope, and I recommend trimming it to the card columns.
