# Release verification: Roundtable Sales OS (rtb-crm)

- **Date:** 30 Sep 2026
- **Build under test:** `main` @ `35c7ad5` ("Merge data-integrity remediation"), 62 commits ahead of `origin/main`. The working tree was clean; no source files were modified during verification.
- **Environment:** the lead's dev server on `http://localhost:3000` (Next 16.3.7 dev, restarted at 07:21, shared Supabase DB with real imported data). Tools: `curl` with a cookie jar per role (7 roles), the built-in browser pane (own tab, 1440 / 1024 / 375 px), and read-only SQL through `scripts/_db.ts` (a read-only transaction wrapper in the scratchpad).
- **Test data:** only rows prefixed `[test] rel` (3 accounts, 4 deals, 1 contact, 2 documents, 1 task, 1 approval, 3 alerts, plus their child rows). All were deleted in one transaction after a dry run. The final count is **0** (details in §9). The 147 imported overrides and their bulk approval were **not** decided.

---

## Verdict: **Ready with caveats**

Every High and the verified Medium security fixes hold live. All quality gates pass, including an isolated production build. The 12-page stress test returned 36/36 HTTP 200s and the dev server logged no errors during the session. The acceptance tests that can run locally pass. The eight new findings are Low or Cosmetic, and none blocks release.

The caveats are operational, not code defects:
- External integrations (Google, Apify, Granola, Vercel) are unconfigured. Their degraded states are handled.
- The dev accounts must be purged before go-live.
- Two owner decisions are open: the import-ledger repair SQL, and the 147-override bulk approval.
- Nothing Slips is effectively silent on the imported book until placeholder owners are mapped to real users (see R-1).

---

## 1. Checklist results

| # | Area | Result | Evidence |
|---|---|---|---|
| 1a | `next typegen && tsc --noEmit` | **PASS** | exit 0 |
| 1b | `eslint src --max-warnings=0` | **PASS** | exit 0, 0 warnings |
| 1c | `vitest run` | **PASS** | 43 files, **464 tests** passed (1.3 s) |
| 1d | `next build` | **PASS** | Built in an APFS clone of the repo in the scratchpad, so the dev server's `.next` wasn't touched. "Compiled successfully", exit 0. The clone was deleted afterwards. |
| 2a | Stability: 12 heavy pages × 3 parallel rounds (superadmin) | **PASS** | 36/36 HTTP 200. Wall time per round: 10.4 s, 9.0 s, 8.5 s. No 500s and no ~31 s hangs (QA-01 did not reproduce). |
| 2b | Sequential warm timings | **PASS (1 borderline)** | 0.96–2.69 s. Only `/pipelines/NET` is above 2.5 s (2.63–2.69 s). See §6. |
| 2c | Server log during the whole session | **PASS** | `.next/dev/logs/next-development.log`: 0 ERROR and 0 WARN entries (only 131 browser INFO and 3 server LOG lines). |
| 3 | Security re-verification (H-1, H-2, M-1, M-9, cron, 403s, field-level) | **PASS** | See §2 |
| 4 | Acceptance tests AT-01..AT-13 | **9 pass · 1 pass (pending owner decision) · 1 not re-run · 2 not testable** | See §3. AT-09 is pending the owner's decision, AT-11 wasn't re-run, and AT-12/13 need Apify. |
| 5 | Role journeys (7 roles) | **PASS** | Nav matches PRD Appendix B for every role. 0 console errors on every visible page for every role. Key actions work, including the Won migration being idempotent under double submit. See §4. |
| 6 | Design conformance at 1440 / 1024 / 375 px (6 pages) | **PASS (2 cosmetic)** | 0 px horizontal overflow and 0 clipped KPI values on all 18 page × width combinations. Dark theme (`rgb(7,7,7)`), Work Sans body and Playfair Display headings. See §5. |
| 7 | Data sanity SQL + sweep | **PASS** | 0 duplicate domains, 0 open deals without a next step or due date, 0 orphan accounts from failed gates, sweep 28/28 rules OK. See §7. |

---

## 2. Security re-verification (live)

| ID | Check | Result | Evidence |
|---|---|---|---|
| **H-1** | Better Auth admin endpoints over HTTP | **PASS** | `POST /api/auth/admin/set-role`, `update-user` and `create-user` return **404** for super_admin, exec, SVP, intern, commission rep, finance and anonymous callers. `GET list-users` returns **200 only for super_admin**, 404 for everyone else. Anonymous `sign-up/email` with a gmail.com address returns 403. |
| **H-2** | Restricted deal documents on Account 360 | **PASS** | Fixture: account `[test] rel Pub` with a restricted deal whose access list holds only the superadmin. The deal has a term sheet document and the account has its own NDA. `/accounts/<id>`: the superadmin sees the term sheet and the deal. **Exec, SVP, intern, SDR and finance** see neither the term sheet nor the deal name, but do see the account NDA. The restricted deal URL returns 403 for all five. |
| **M-1** | Duplicate and registration checks don't reveal restricted names | **PASS** | Fixture: restricted account `[test] rel Secret Media` (`rel-secret-media.example`). Intern → New account with URL `https://www.rel-secret-media.example/news`: "This domain already belongs to an account — *an existing account you don't have access to (ask an admin)*". Create stays disabled and no name is shown. Commission rep → Registrations → search domain: "This account can't be registered. Ask a manager." Submit stays disabled. `/api/search?q=rel Secret` returns `{"hits":[]}` for exec, intern and commission rep, and the account for superadmin only. The accounts list hides it from exec and intern. |
| **M-9** | Requester can't decide their own approval | **PASS** | A `[test] rel` probability-override approval was requested by dev.exec (approver role executive). In Approvals it shows under "Your requests", not "Waiting on you". Clicking **Approve** on the deal page as the same exec returns the toast "You can't decide your own request — another approver has to review it." The DB is unchanged (`status=pending`, `decided_by` null). The UI still offers the button: see NEW-2. |
| Cron auth | 6 cron routes without a secret or with a wrong one | **PASS** | `sweep`, `commissions`, `digest`, `scout`, `snapshot` and `sync-email` return **401** with no header and with `Bearer wrong`. With the real secret, `sweep` returns 200. |
| 403 on forbidden pages | intern / commission / others | **PASS** | Full route × role matrix (36 routes × 7 roles). Intern gets 403 on `/proposals`, `/onboarding`, `/revenue`, `/import*` and `/admin*`. Commission rep gets 403 on `/proposals`, `/onboarding`, `/import*` and `/admin*`. SDR and intern get 403 on the ENT deal URL. The commission rep also gets 403 on another rep's deal. Finance gets 403 on `/calls` and `/scout`. SVP gets 403 on `/admin*`. Exec gets 403 on `/import*`. A random deal id → 403, `/nope` → 404, anonymous `/home` → 307 to `/sign-in`. Two role-forbidden surfaces render in-page denial with HTTP 200: see NEW-1. |
| Field-level security | `revSharePct` in the RSC payload as intern | **PASS** | Fixture deal owned by the intern with `rev_share_pct=0.4242` and `guarantee_monthly_cents=1234500`. The intern's HTML/RSC payload contains `"revSharePct":"$undefined"` with 0 matches for `0.4242` and 0 for `1234500`. The UI shows "RTB NET / YR — Hidden" (`screens/release-intern-deal-net-hidden.jpg`). The same page as superadmin carries `0.4242`. |
| AT-07 / Copilot MNPI | SDR asks "What are the NY Post deal terms?" | **PASS** | No terms leaked ("no deals visible to you"). `audit_log` has `copilot.access_denied` for the SDR. |

---

## 3. Acceptance tests (PRD Appendix E)

| AT | Result | Evidence |
|---|---|---|
| AT-01 | **PASS (Google part n/a)** | Google isn't configured, and the sign-in page says "Google sign-in isn't configured yet (GOOGLE_CLIENT_…)". Anonymous email sign-up with gmail.com → 403. The commission rep sees "No accounts yet" and $0 revenue (own scope only). |
| AT-02 | **PASS** | Intern/SDR/commission → ENT deal URL = **HTTP 403**. Rev-share and guarantee fields are absent from the payload (§2). |
| AT-03 | **PASS** | SQL: 0 duplicate normalized domains, 0 primary↔alternate domain collisions. `raw_value '1.5-2M'` and `'1.5–2M'` both → 1,750,000 with the raw value kept. 0 deals whose splits don't total 100%. 79 Chris/Will deals at 50/50. |
| AT-04 | **PASS (degraded)** | Gmail isn't configured. The `/settings` Gmail + Calendar card reads "Not available — Google sign-in not configured — ask an admin". |
| AT-05 | **Not re-run** | This test costs an AI call and was passed in the QA pass. `/calls/upload` loads (200) and `/calls` lists Granola / Zoom / Upload sources. |
| AT-06 | **PASS** | A `[test] rel` Hot deal owned by the SDR, idle for 6 days (SLA 5). A sweep via `/api/cron/sweep` raised **NS-03 to the SDR**: "No activity for 6 days (stage SLA 5d)". After the test alert was backdated past the 48 h business escalation, the next sweep marked it `escalated` and created a copy "Escalated: … stale in Hot" for **Dev SVP**, the sales-leader fallback from QA-04 (no manager is configured). |
| AT-07 | **PASS** | §2 |
| AT-08 | **PASS (1 gap)** | `findClaimHits` against the live claims table flags "pays publishers in 8 seconds", "paid within eight secs via Coinbase", "one hundred million dollars of audited revenue" and "migrate … in 2 hours", each with its approved alternative. Asked to write the banned claims in chat, Copilot refused. Gap: its own "safe" rewrite said "near-instant publisher payouts", which the rules don't catch (NEW-3). |
| AT-09 | **PASS: bulk approval exists, awaiting the owner's decision** | Exec → Approvals shows "Probability override · 147 deals (bulk) · Requested 100% · Imported overrides per J. Heckman 29 Sep 2026" with Approve and Reject (`screens/release-exec-approvals-bulk-147.jpg`). The Executive dashboard shows "Manual override exposure +$0 · 0 deals overridden · 147 pending approval". It was **not decided** (owner action). |
| AT-10 | **PASS** | `/revenue` as finance and as superadmin: **$410K / 4 · $1.15M / 7 · $260K / 7 · $1.10M / 14**, matching C&W (`screens/release-1024-revenue-tiles.jpg`). R100 live = 30 by SQL and on the dashboard ("30 / 100"); IMPORT_REPORT reconciles this against C&W's 24. |
| AT-11 | **Not re-run** | This is a UI flow that writes scout rows, and it passed in the QA pass. `/scout` shows "Works now: upload or paste a domain list and score it". |
| AT-12 | **Not testable (graceful)** | Apify isn't configured. Scout and New search show "Needs Apify … Ask an admin to add the org Apify token". Domain-list scoring stays available. |
| AT-13 | **Not testable** | Needs Apify. |

---

## 4. Role journeys

**Nav per role** (sidebar items parsed from each role's `/home` payload) matches Appendix B:

| Role | Nav |
|---|---|
| superadmin | My Day, Pipelines, Accounts, Contacts, Tasks, Inbox, Calls, Lead Scout, Copilot, R100, Proposals, Onboarding, Revenue, Commissions, Analytics, Import, Admin |
| exec | same as superadmin, minus Import and Admin, plus **Audit log** |
| svp | same as superadmin, minus Admin |
| sdr | My Day … Copilot, R100, Commissions, Analytics (no Proposals, Onboarding, Revenue, Import or Admin) |
| intern | same as sdr |
| commission | same as sdr, plus Revenue (own) |
| finance | My Day, Pipelines, Accounts, Contacts, Tasks, Inbox, Copilot, R100, Proposals, Revenue, Commissions, Analytics, Audit log (no Calls or Scout) |

**Page loads:** every nav page was opened in the browser for superadmin, exec, SVP, SDR, intern, commission rep and finance (13–18 pages each). The console showed **0 errors** throughout. Only HMR and Fast Refresh INFO lines appeared.

**Key actions (superadmin unless noted):**

| Action | Result | Evidence |
|---|---|---|
| Create deal with a new account (NET board → New deal, next step required) | ✓ | Account and deal created. `next_step_due_at` 21:00 UTC = 17:00 in the user's zone (M-06). |
| Log note | ✓ | `activities.type=note` row |
| Move Target → Outreach → Hot → Contract (gate asks for primary contact, created inline) → **Migrating (Won)** with **double submit** | ✓ | Two programmatic clicks plus `requestSubmit` on "Mark as won". Result: `status=won`, **exactly 1 migration project** (owner = deal owner, QA-26), 1 stage-history row per move, the win note stored as the history reason, next step cleared. |
| Create task (deal → Add task) | ✓ | `tasks` row created (the dialog takes ~3 s to close) |
| Copilot one prompt as **SDR** (UI) | ✓ | "Which of my deals need a next step this week?" answered in ~15 s using the `list_my_work` tool (`screens/release-sdr-copilot.jpg`) |
| Revenue tiles | ✓ | $410K/4, $1.15M/7, $260K/7, $1.10M/14 (finance and superadmin). The commission rep sees $0 (own scope). |
| Super_admin probability override | ✓ by design | Exec and super_admin overrides auto-approve (`overrideAutoApproved`). Other roles' requests go to Approvals. |

---

## 5. Design conformance (home, NET board, deal, accounts, analytics, revenue)

The same DOM probe ran on each page at each width. It looks for any element past the viewport edge that isn't inside a scroll or clip container, and for any leaf with a number or `$` whose `scrollWidth` exceeds its `clientWidth`.

| Width | Overflowing elements | Clipped KPIs | `documentElement.scrollWidth` |
|---|---|---|---|
| 1440 | 0 on all 6 | 0 | ≤ 1440 |
| 1024 | 0 on all 6 | 0 | ≤ 1024 |
| 375 | 0 on all 6 (header: 0 elements off-screen, so the QA-06 fix holds) | 0 | 375 |

- **Theme and fonts:** body background `rgb(7,7,7)`, body font Work Sans, headings Playfair Display, monochrome chrome with pastel stage colours.
- **Screenshots:** `docs/audits/screens/release-1440-{home,net-board,deal-won,analytics}.jpg`, `release-1024-{analytics,revenue-tiles}.jpg`, `release-375-{net-board,deal,revenue}.jpg`.
- **Cosmetic issues:** NEW-7 (a Won deal shows a "No next step" warning) and NEW-8 (the 375 px board KPI strip wraps unevenly).

---

## 6. Performance (dev server, superadmin, `curl -w %{time_total}` in seconds)

| Page | Status (r1/r2/r3) | Parallel r1 | Parallel r2 | Parallel r3 | Sequential warm 1 | Sequential warm 2 |
|---|---|---|---|---|---|---|
| /contacts | 200/200/200 | 4.93 | 3.42 | 3.48 | 0.97 | 0.96 |
| /accounts | 200/200/200 | 6.22 | 4.81 | 4.57 | 1.25 | 1.36 |
| /tasks | 200/200/200 | 7.26 | 5.99 | 5.60 | 1.48 | 1.45 |
| /revenue | 200/200/200 | 8.27 | 6.77 | 6.64 | 1.65 | 1.40 |
| /r100 | 200/200/200 | 8.47 | 7.20 | 7.02 | 2.30 | 2.43 |
| /home | 200/200/200 | 9.22 | 8.19 | 7.93 | 1.94 | 1.96 |
| /pipelines | 200/200/200 | 9.45 | 7.97 | 7.46 | 2.05 | 2.15 |
| /pipelines/NET | 200/200/200 | 9.69 | 7.50 | 8.08 | **2.69** | **2.63** |
| /analytics/quality | 200/200/200 | 9.88 | 8.45 | 7.68 | 1.80 | 1.85 |
| /analytics | 200/200/200 | 10.16 | 8.86 | 8.49 | 2.37 | 2.36 |
| /pipelines/NET?view=list | 200/200/200 | 10.30 | 8.38 | 8.29 | 2.36 | 2.20 |
| /analytics/health | 200/200/200 | 10.37 | 8.92 | 8.38 | 2.26 | 2.31 |
| **Round wall time** | | **10.41** | **8.95** | **8.52** | | |

Compared with the QA report:
- `/analytics` went from **500 after 31.9 s** to 200 in 2.4 s.
- `/analytics/quality` went from 6.9–7.4 s to 1.8 s.
- `/home` no longer hangs for 32 s.

Under 12-way parallel load, requests queue behind the DB in-flight cap (`limitInFlight`), which is the intended trade-off from the QA-01 fix. Every request completes and none fails.

Other timings: the sweep takes 8.5–8.7 s for 28 rules, and a Copilot reply takes 13–20 s (gpt-5-mini).

---

## 7. Data sanity (read-only SQL, test rows excluded)

**Deals per pipeline and stage:**

| Pipeline | Stages (count) |
|---|---|
| NET | target 738 · outreach 281 · in_comms 22 · warming 6 · hot 14 · demo 4 · contract 0 · migrating 7 · live 0 · on_hold 16 · cold 970 · lost 0 |
| R100 | target 222 · outreach 593 · warming 45 · hot 11 · relationship 20 · onboarding 2 · profile_activated 4 · first_post 26 · lapsed 0 · cold 7 · lost 0 |
| SPT | target 1 · outreach 18 · in_comms 18 · warming 3 · hot 108 · others 0 · cold 1 |
| ENT | in_comms 4 · negotiation 10 · contract 1 · on_hold 1 · others 0 |
| ADS | warm 14 · negotiation 2 · verbal 1 · loi 1 · current_client 7 · others 0 |
| PAY | 0 |

**Totals:** 8,581 accounts · 3,182 deals · 3,651 contacts · 23 migration projects.

**Integrity checks:**

| Check | Result |
|---|---|
| Duplicate normalized domains | **0** groups |
| Primary domain equal to another account's alternate domain | **0** |
| Open deals without a next step, or without a due date | **0 / 0** in every pipeline (NET 2,038 open, R100 900, SPT 149, ENT 15, ADS 18) |
| Orphan accounts from failed gates (created in the UI, no deals, contacts or registrations) | **0**. The QA-07 fix holds. The 4,770 accounts with no deals or contacts are imported ones (4,651 from "RTB 100 MASTER", 113 from "New Target List", …), mostly the `70404ba2` batch that isn't in the rollback ledger (R-3). |
| Pending overrides / pending approvals | **147 / 1** (the untouched bulk approval) |

**Sweep** (`/api/cron/sweep` with `CRON_SECRET` read from `.env.local` into a shell variable, never printed):
- `ok:true` on 28/28 rules, 0 failed, ~8.7 s.
- Alerts in the whole DB after the sweep (test alerts included, removed afterwards): NS-02 resolved 2, NS-03 open 1 + escalated 1, NS-05 resolved 1, NS-18 open 1, NS-27 open 1.
- Without the test deal, the real book produces **only NS-18 (1 open)**. See R-1.

---

## 8. New findings (this verification)

| ID | Severity | Finding | Repro | Suspected location |
|---|---|---|---|---|
| NEW-1 | Low | Role-forbidden pipeline boards and admin subpages return **HTTP 200** with an in-page "Not found" / "No access" instead of 403, which is inconsistent with the QA-09 contract. No data leaks: the payload holds 0 ENT deal ids and 0 other users' emails. | `curl -b intern /pipelines/ENT` → 200, "Not found" (same for SDR and commission rep). `curl -b exec /admin/users` (also `roles`, `settings`, `pipelines`, `claims`) → 200, "No access" (same for finance). | `src/app/(app)/pipelines/[key]/page.tsx:41` calls `notFound()` after `loading.tsx` has already streamed; use a guard layout with `forbidden()` as QA-09 did elsewhere. `src/app/(app)/admin/layout.tsx` lets audit-log viewers through and the subpages deny in-page. |
| NEW-2 | Low | The deal page Probability panel shows **Approve / Reject** to the user who requested the override. The server refuses correctly (M-9 holds), but the UI invites a doomed action. The Approvals inbox already hides it. | As exec, request an override (or view one the exec requested) → deal page → Approve → toast "You can't decide your own request…" | `src/components/deals/record/type-panels.tsx` (probability panel): hide the buttons when `requestedBy === me` |
| NEW-3 | Low | Claim-guardrail paraphrase gap. When Copilot refused the banned claims, its own "safe alternative" said "delivers **near-instant publisher payouts**". The playbook says real-time payouts are beta, the claim isn't flagged, and no warning metadata is attached. | Copilot as SDR: ask for a pitch with "pays in eight secs". `findClaimHits("Our platform delivers near-instant publisher payouts")` → `[]` | `src/lib/claims-patterns.ts` (add `instant\|real-time payouts` without "beta"). Possibly also a prompt rule in `src/lib/copilot/prompt.ts`. |
| NEW-4 | Cosmetic | The stage-path tooltip exposes raw field keys: "Contract · 100% · requires **muu, primaryContactId**". | Hover the Contract chevron on any NET deal | `src/components/deals/record/stage-path.tsx:54`: use `gateFieldMeta(k).label`, as `stage-move.tsx:166` does |
| NEW-5 | Cosmetic | The duplicate hint for a hidden restricted account reads "…you don't have access to (ask an admin) **no domain**". The domain does exist; it's just hidden. | Intern → New account → a domain owned by a restricted account | `src/components/accounts/create-account-dialog.tsx:154`: drop the `?? "no domain"` suffix when the match is the hidden label |
| NEW-6 | Cosmetic | Copilot replies leak internal tool names and parameters to users ("list_my_work → kind=deals_at_risk", "closingWithinDays=7", "noMeetingWithinDays=14"). | SDR: "Which of my deals need a next step this week?" | `src/lib/copilot/prompt.ts`: add a rule to describe tools in plain language |
| NEW-7 | Cosmetic | A **Won** deal shows an amber "No next step" warning badge in the Next step card, although QA-26 clears the next step on win by design. | Any won deal (`screens/release-1440-deal-won.jpg`) | `src/components/deals/record/header-editors.tsx:49`: show neutral text such as "Closed — no next step needed" when the deal isn't open |
| NEW-8 | Cosmetic | At 375 px the NET board header KPI strip wraps unevenly: "Weighted" drops to its own row and the values are offset from their labels. | `/pipelines/NET` at 375 × 812 (`screens/release-375-net-board.jpg`) | Board header KPI component (`src/components/deals/board/*`): use a 2- or 3-column grid below `sm` |

No Critical, High or Medium issues were found. There were no regressions of the fixed audit items.

---

## 9. Test data cleanup

- **Created:** 3 accounts, 4 deals, 1 contact, 2 documents, 2 restricted_access rows, 1 task, 7 activities, 5 stage-history rows, 1 split, 1 deal_contact, 1 migration project, 1 approval, 3 alerts and 3 notifications. All were prefixed `[test] rel` or linked to such rows.
- **Deleted** in one transaction after a dry run. The reference scan over every `deal_id` / `account_id` / `contact_id` / `entity_id` column afterwards found only `audit_log` (9 rows).
- **Final counts:** 0 `[test] rel` accounts, deals, contacts, tasks, documents, notifications or alerts, and 0 `rel-*.example` domains.
- **Real data is intact:** pending overrides are back to **147** and pending approvals to **1** (the bulk one, undecided). Migration projects are back to 23.
- **Left intentionally:** append-only `audit_log` rows (9) and `agent_runs` / `copilot.access_denied` entries from the Copilot prompts.
- **Browser session:** my tab was left signed in as Dev Super Admin, and the viewport emulation was reset. Signing in as other roles in the pane also affected the lead's pane cookies during the run; the final state is Dev Super Admin.

---

## 10. Residual risks

1. **R-1: Nothing Slips is effectively silent on the imported book.**
   - The sweep only alerts owners who are active users.
   - Every imported deal is owned by a banned `(placeholder)` user (Erik, Andres, Daniel, …).
   - As a result, 3,000+ open deals, 970 of them in Cold, produced **one** real alert (NS-18).
   - This clears once real users are provisioned and the placeholders are remapped to them (Admin → Users, or a remap script).
2. **R-2: Performance on the dev server.**
   - Warm pages take 1–2.7 s; the NET board is slowest at ~2.6 s because `listDealsForBoard` selects full rows for about 2,000 deals (QA §11 note).
   - Under a 12-way burst, requests queue to 8–10 s because of the pool cap.
   - Production (built, not dev) should be faster, but measure on Vercel and consider trimming the board query to card columns.
3. **R-3: Batch `70404ba2` isn't in the rollback ledger.** Its 6,477 accounts and 1,448 deals can't be rolled back with one click until the documented repair SQL is approved and run.
4. **R-4: Open security items from the audit.**
   - Deferred Low items: L-8 AAD, L-9 contacts export for access-list users, L-10 remaining claim checks, L-16 (needs a product decision), L-19 CSP nonce pipeline, L-20 Supabase roles.
   - M-15: the committed dev password in `scripts/seed.ts`.
   - H-3 and H-4 were verified at the CODE level only.
5. **R-5: Claim guardrail is regex-based.** Paraphrases such as NEW-3 get through. It needs a periodic review of `claims-patterns.ts` against real drafts, plus the golden set from PRD §AI evaluation.
6. **R-6: Escalation relies on the sales-leader and executive fallback** because no user has a manager and no team has a lead (QA-04). Configure the hierarchy so escalations reach the right person.
7. **R-7: Cron cadence.** `vercel.json` runs the sweep daily (Hobby). Nothing Slips assumes a 15-minute cadence, so a Pro plan is needed (DEPLOY §7).

---

## 11. External setup still required before go-live

| # | Item | Owner | Notes |
|---|---|---|---|
| 1 | **Google OAuth credentials** (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, consent screen, Gmail + Calendar scopes, redirect URIs) | Admin | Unlocks Google sign-in, AT-01 (full), AT-04 and Calendar. See DEPLOY §5. |
| 2 | **Vercel project link and environment variables** (Production + Preview: DB URLs, `BETTER_AUTH_*`, `ENCRYPTION_KEY`, `CRON_SECRET`, `AI_GATEWAY_API_KEY`, `ALLOWED_EMAIL_DOMAINS`, `ALLOW_DEV_LOGIN=false`) | Admin | DEPLOY §2–3. Plan choice decides the cron cadence (R-7). |
| 3 | **Apify token** (org) and actor registry / budgets | Admin | Unlocks AT-11 discovery, AT-12 and AT-13 |
| 4 | **Granola API keys** (and Zoom, optional) | Admin | Automatic transcript sync. Manual upload works today. |
| 5 | **GitHub push-protection unblock** | Repo owner | `main` is 62 commits ahead of `origin`. Resolve the flagged secret(s) and push before linking Vercel. |
| 6 | **Purge dev accounts** (`npm run db:purge-dev`) and rotate/remove the committed dev password | Admin | Required before go-live (M-15). `dev.*@` sessions are already rejected in production. |
| 7 | **Approve and run the import-ledger repair SQL** for batch `70404ba2` | Data owner | `docs/IMPORT_REPORT.md` § "Repair: attach batch 70404ba2 rows…" |
| 8 | **Decide the bulk approval of the 147 imported overrides** | Executive (J. Heckman) | Tasks → Approvals. It was deliberately left undecided in this verification. |
| 9 | Provision real users, remap placeholder owners, set managers and team leads | Admin | Clears R-1 and R-6 |
