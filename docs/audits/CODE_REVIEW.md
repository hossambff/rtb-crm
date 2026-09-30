# Code review: Roundtable Sales OS (rtb-crm)

- **Date:** 2026-09-30
- **Branch:** main
- **Scope:** `src/lib/**`, `src/app/**`, `src/db/**`, crons, and the AI integration.
- **Focus:** correctness, data integrity, performance and maintainability. Auth and injection belong to the security audit; security items that turned up along the way are flagged.

## How this was verified

- **Project checks:** `vitest run` passes (33 files, 390 tests). `tsc --noEmit` is clean.
- **Reproduction tests:** each bug marked "Test" was reproduced with a vitest case that fails against the current code. These are throwaway tests, run with a temporary config, and no source files were changed:
  - `/private/tmp/claude-501/audit-main/tests/` (analytics and snapshots): 3 failing.
  - `/private/tmp/claude-501/audit-math/audit.test.ts` (commissions, proposals, scout, health): 10 failing.
  - `/private/tmp/claude-501/audit-alerts/*.test.ts` (alerts, AR, R100, digest): 10 failing.
  - The key reproductions are copied into Appendix A, because `/tmp` does not persist.
- **Database:** only read-only SQL was run against the live DB, inside `BEGIN READ ONLY` transactions (`/private/tmp/claude-501/audit-main/q.ts`). Nothing was written.
  - Live data: 8,578 live accounts, 3,178 live deals, 3,652 contacts, 2,043 activities, 0 invoices, 4 alerts, 0 pipeline snapshots.
- **TS/SQL value-math parity:** checked on live data. `dealValue()` (TS) and `value-sql.ts` (SQL) agree on all 3,178 live deals, with 0 mismatches in gross, net, probability and MUU (`/private/tmp/claude-501/audit-main/parity.ts`).
- **Labels:** anything not reproduced is marked **(suspected)**.

---

## Executive summary

The core deal-value math is correct. `pipeline-math.ts` and its SQL twin agree with each other and with PRD DEAL-4/5 on live data. Units are consistent everywhere I checked: cents are bigint numbers, `revSharePct` is 0..1, and `deal_splits.pct` is 0..100 (every split set sums to exactly 100 in the DB). At today's data size the database is not a bottleneck: every heavy query I ran with EXPLAIN finishes in under 25 ms.

The risks are in the parts built around that core: money flows, scheduled jobs, and the edges between modules.

1. **Commissions can pay twice, and a key clawback never fires.**
   - An accrual's idempotency key is the rule's position in the plan's rules array (`ruleIdx|trigger|sourceId`), and there is no unique constraint behind it. Deleting or reordering a rule re-accrues every past event (CR-01).
   - Clawbacks on `deal_won` can never fire, because a deal moved to lost has its `wonAt` set to null (H-02).
   - The accrual run holds an advisory-locked transaction, but most of its queries go through the global pool. Concurrent runs can deadlock the pool, and the run commits only partly (H-03).
2. **The executive dashboard shows a wrong "vs last week" figure and a wrong trend chart.**
   - Snapshot columns are read with the override meaning swapped, and snapshots include won and lost stages (H-01).
   - Snapshots are empty today, so the bug shows up as soon as the nightly cron starts writing them.
3. **The alerts engine does not respect user decisions, and several rules drift from the UI and the PRD.**
   - Dismissed or resolved alerts are raised again on the next sweep (H-05).
   - The R100 lapsing alert fires forever after month 3 (H-06).
   - The engine and the R100 UI use different interview fields and rules (M-01).
   - Date-only due dates are stored as 00:00 UTC, so "overdue" starts the evening before in New York (M-06).
   - Escalation copies leak restricted deal names (H-07, security).
4. **Scout spend can exceed the org cap** (H-04).
   - The budget reserves the run's estimate, not its maximum, and the check-then-insert takes no lock.
   - The run lock lives in process memory (M-12).
5. **Data-integrity gaps from missing transactions, locks and deletedAt filters.** See §2.
   - Only 16 `db.transaction` call sites exist, there is no `SELECT … FOR UPDATE`, and deal updates are never conditional.
   - Import commit and rollback are not atomic (H-09).
   - Account merge runs about 17 writes with no transaction (H-10).
   - Stage moves have no concurrency guard, so a double-click on "won" can create duplicate migration projects and ADS invoices (H-11).
   - The R100 board has its own stage-change path that skips gates, approvals and won side-effects (H-12).
6. **Performance is fine at today's data size, but a few design choices will not scale.**
   - The pipeline list view ships every deal to the client (NET: 2,058 rows, about 1.9 MB of JSON before RSC overhead).
   - Two different ad-hoc concurrency limiters exist. One of them is process-wide with a limit of 2, so every analytics user waits in the same queue.
   - Transcript sync loads the whole contacts and accounts directory once per transcript.
   - AI calls have no timeouts.
7. **Maintainability.** The deal value is mapped into `dealValue()` by hand at about 8 call sites, and one of them already drops the deal-level `$/MUU` (M-22). Pipeline aggregation is written four times, and there are three LIKE-escape helpers and two concurrency limiters. See §4.

---

## 1. Findings table

Severity: **C** Critical · **H** High · **M** Medium · **L** Low.

Categories:
- **MATH**: business math
- **INT**: data integrity
- **TZ**: time and time zones
- **PERF**: performance
- **NEXT**: Next.js
- **AI**: model integration
- **MAINT**: maintainability
- **SEC**: flagged for the security audit

### Critical

| ID | Sev | Cat | Title | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|---|
| CR-01 | C | MATH/INT | Commission idempotency key = rule array index; plan edits pay the same event twice | `src/lib/commissions/calc.ts:75` (`accrualKey(ruleIdx,…)`), `:160`, `engine.ts:77` (cap key), `:115` (clawback rule lookup); `actions.ts:26-47` (savePlan replaces the array) | **Test** C1: plan `[meeting_held, deal_won]` accrues `1\|deal_won\|deal-1`; after deleting rule 0 the re-run emits a new draft `0\|deal_won\|deal-1` (expected none). `commission_accruals` has no unique constraint; the key lives only in the free-text `note` | Every past event since `effectiveFrom`, for every user on the plan, is accrued again silently. Caps and clawbacks bind to the wrong rule | Give rules a stable `id` (uuid kept across saves) and key on `ruleId\|trigger\|sourceId`. Add `accrual_key text not null` with `UNIQUE(user_id, plan_id, accrual_key)` and `INSERT … ON CONFLICT DO NOTHING`; backfill the column from `note` |

### High

| ID | Sev | Cat | Title | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|---|
| H-01 | H | MATH | Executive "Weighted pipeline vs last week" and "Weighted pipeline trend" use snapshot columns with the override meaning swapped, and include won/lost stages | `src/lib/analytics/executive.ts:332,351` vs `src/lib/notifications/snapshot-core.ts:51-53`; `snapshots.ts:15-34` (all stages); `app/(app)/analytics/page.tsx:60` | **Test** (`audit-main/tests/snapshot.test.ts`, 3 failing): <br>• Snapshot `weightedCents` = stage probability (no override) and `overrideWeightedCents` = with override. Executive reads `overrides ? weightedCents : weightedCents − overrideWeightedCents`. <br>• Excl. overrides, a $1M MUU deal at 50% gives **0** (expected $500k). <br>• Incl. overrides, an approved 90% override on a 10% stage gives $100k (expected $900k). <br>• A won deal adds $2M to the snapshot "pipeline" but is not in the live open-only KPI | The WoW % compares live open weighted value (with overrides) against a snapshot that has no overrides and includes won deals, so it is wrong by default. With "excl. overrides" the trend chart plots about 0 or negative values. 147 deals have overrides today | In `executive.ts` use `overrides ? overrideWeightedCents : weightedCents`. Store the stage category in `pipeline_snapshots`, or snapshot open stages only, and filter to `category='open'` in trend, WoW and `snapshotDelta` (see also M-10) |
| H-02 | H | MATH | Clawbacks for `deal_won` and `migration_launched` accruals can never fire | `src/lib/deals/stage-service.ts:167` (`wonAt = null` unless won); `src/lib/commissions/engine.ts:118-125` (uses `c.wonAt` as `eventAt`) | **Test** C4: `clawbackDue({eventAt:null, lostAt, 90})` returns false (expected true) | PRD COM-1 "churn within 90 days" is dead for the main trigger. Reps keep commission on deals lost right after they were won | Store `event_at` on each accrual (from `ev.at`) and use it for clawbacks. Separately, keep a `firstWonAt` on the deal |
| H-03 | H | INT/PERF | Commission run holds an advisory-locked transaction but runs most queries on the global pool, so it can deadlock and commits only partly | `src/lib/commissions/engine.ts:34-37`; `db.` at 52, 66, 90, 183, 207, 234, 256, 285, 318, 333; `expireRegistrationsWith` ignores its `q` | Code trace: each run holds one pooled connection inside the transaction, and its reads need a second. With `DB_POOL_MAX=5`, five concurrent runs (button clicks plus cron) hold every connection waiting on the lock; the lock holder cannot get a connection and hangs until the 300 s `maxDuration`. Registration expiry commits even when the run rolls back | Accrual runs hang and time out; state is half-applied | Pass `q` (the transaction) through `runAccruals`, `collectEvents`, `loadDeals` and `expireRegistrationsWith`. Use `pg_try_advisory_xact_lock` and return "already running" instead of queueing |
| H-04 | H | MATH/INT | Scout org hard cap (D8, $10) can be overshot | `src/lib/scout/budget.ts:12`; `service.ts:26,34`; `actions.ts:278-289` | **Test** S2: with 950¢ spent, run A (estimate 10¢, `maxAllowed` 50) is allowed; spend then reserves only A's estimate, so run B is allowed max 40. Worst case 950+50+40 = 1040¢. The check and insert are not serialized | Real Apify spend beyond the approved cap | Reserve `maxAllowedCents`: store it on the run and use `greatest(cost, reserved)`. Wrap check and insert in a transaction with `pg_advisory_xact_lock(hashtext('scout.budget'))` (safe on the transaction pooler) |
| H-05 | H | INT | Dismissed or resolved alerts are re-raised and re-notified on every sweep while the condition holds | `src/lib/alerts/engine.ts:1022-1046` (only OPEN states loaded), partial unique `alerts_open_uq` | Code trace: `dismissAlert` (`alerts/actions.ts:71-75`) sets `dismissed`. The next sweep finds no open match and inserts a new alert. The My Day catch-up runs a sweep at most hourly | PRD §12.2 "dismiss with reason" is undone within the hour, causing alert fatigue | Keep a suppression record: `suppressed_until` or a condition fingerprint (for example `nextStepDueAt`) on the closed alert. Skip candidates whose key has a closed row with the same fingerprint |
| H-06 | H | MATH | NS-21 R100 "participation lapsing" fires every month-end forever after month 3 | `src/lib/alerts/rules.ts:213-224`; `r100/calc.ts` (`participation` is fixed at 3 slots) | **Test**: first post 2026-01-10, participation `[T,T,T]`, now 2026-06-26 → `true`, while the UI's `participationNow` says "beyond". The rules use an anniversary month index, the UI a calendar month index (a second failing test) | 10 live R100 deals already qualify and will all alert Oct 24-31. The alert can never be cleared | Share one month-index function with `r100/calc.ts`; return false when `idx > 2`, or model participation for every month (a PRD decision) |
| H-07 | H | SEC/INT | Escalated alert copies leak restricted (MNPI) deal names to managers | `src/lib/alerts/engine.ts:1117-1127` (copies `a.title`/`a.detail`); NS-01/02/03/09/27 build titles from the raw `d.name` | Code trace: `managerOf()` never checks `restricted_access` | MNPI leak through alerts and notification bodies. Hand to the security audit | Rebuild the escalated title with `dealLabel(d, mgr)`, or use a neutral title for restricted entities |
| H-08 | H | NEXT/AI | AI calls (`aiObject`/`aiText`) have no timeout, retry policy or token cap; fallbacks only run when the call throws, not when it hangs | `src/lib/ai.ts:49-54,67`; callers: `deals/summary.ts:54`, `transcripts/analyze.ts:41`, `gmail/analyze.ts:37`, `scout/actions.ts:95`, `copilot/service.ts:170` | Code: no `abortSignal`, `maxRetries` or `maxOutputTokens` (only the admin test call has `AbortSignal.timeout(20_000)`). `res.usage` is never logged, so cost can't be tracked | A slow gateway stalls server actions, the My Day `after()` sync (granola to `analyzeTranscript`) and the sync-email cron up to `maxDuration`. There is no cost visibility | Add `abortSignal: AbortSignal.timeout(tier==='fast'?20_000:45_000)`, `maxRetries: 1`, `maxOutputTokens`. Log `res.usage` (input/output tokens) in `agent_runs`, and add a per-user daily token budget next to the Copilot hourly cap |

### Medium

| ID | Sev | Cat | Title | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|---|
| M-01 | M | MATH | NS-22 (interview not published) disagrees with the R100 UI | `alerts/rules.ts:238-240` vs `r100/calc.ts interviewOverdue`, `r100/actions.ts saveInterview` | **Test** (2 failing): <br>• The engine reads `publishedAt\|publishDate\|publish_date`, but the save action writes `publishAt`. <br>• The engine alerts on `scheduled`/`rescheduling`; the UI only on `filmed` | False alerts | Use `parseInterviews` + `interviewOverdue` from `r100/calc.ts` in the rule |
| M-02 | M | MATH | Commission split payouts don't add up to the gross | `commissions/calc.ts:164` | **Test** C2: splits 33.33/33.33/33.34 on 1000¢ pay 999¢ | Cents drift on statements | Compute the gross once per event and allocate with largest remainder across all recipients |
| M-03 | M | TZ | Commission periods and clawback periods use UTC month boundaries | `commissions/calc.ts:71`, `engine.ts:141` | **Test** C3: a deal won 2026-09-30 22:00 ET is booked to `2026-10` | Month-end deals land on the wrong statement; risks the go-live check "matches finance's manual calc" | Compute the period in an org timezone setting (`America/New_York`) with `Intl.DateTimeFormat` |
| M-04 | M | MATH | Refund and write-off clawbacks are not implemented | `commissions/engine.ts:90-105`; `schema.ts:114` (no refund status) | Code: clawback candidates are only accruals on `status='lost'` deals | PRD COM-1 gap | Add a `refunded` status or event and reverse the accruals keyed to that invoice |
| M-05 | M | MATH | Duplicate revenue lines double-count in-scope revenue in proposals | `proposals/actions.ts:18`; `proposals/calc.ts normalizeInputs` | **Test** P1: NY Post fixture with `["display","display","commerce"]` gives in-scope $164M (expected $98M). The base NY Post fixture itself matches PRO-1 | Inflated pro forma | Dedupe in `normalizeInputs` and add `.refine(unique)` to the zod array |
| M-06 | M | TZ | Date-only due dates are stored as 00:00 UTC, so "Next step overdue" fires at 8 pm ET the evening before | `deals/actions.ts:31-41,161` (`new Date("YYYY-MM-DD")`); `alerts/rules.ts:44`; same pattern in `tasks/home.ts:58` and `notifications/digest.ts` | **Test**: due "2026-10-01", now 2026-10-01T00:30Z (Sep 30 20:30 EDT) → overdue | NS-02 serious alerts and escalation timers start a day early | Store end-of-day in the owner's time zone, or use a `date` column and compare `localDateKey(now,tz) > due` |
| M-07 | M | TZ | NS-23 invoice overdue tiers lag the revenue page by a day; AR "overdue" flips at 00:00 UTC | `alerts/rules.ts:254-260`; `revenue/calc.ts startOfDay` | **Test** (2 failing): due Oct 1, 06:00Z sweep on Oct 2 → no tier while the page says "1 day overdue". Due Oct 1 is already overdue at 8 pm ET Oct 1 | The PRD +1/+7/+14 alerts land on days 2/8/15; the finance view is inconsistent | Use day-based `daysOverdue` in the org time zone in both places |
| M-08 | M | INT | Entity-level alert dedupe pins alerts to the previous owner after a reassignment | `alerts/engine.ts:1040`; `bulkReassign`/`updateDealQuick` never touch alerts | Code trace: a candidate for the new owner is skipped because the triple exists under the old owner, and the old alert never auto-resolves | The new owner never sees NS-01/02/03/09/27; escalation goes to the wrong manager | Move the open alert (`recipientId = new`) when the triple matches but the recipient changed and the alert wasn't manually reassigned |
| M-09 | M | TZ | "N business days" is counted as elapsed midnights, so it can pass up to a day early | `alerts/time.ts:76-89` (escalation `rules.ts:309`, NS-10/25/29/31/32) | **Test** (2 failing): created Mon 23:30 ET escalates Tue 00:30 under the 24 h rule; sent Fri 23:59 flags "5 business days" at the next Fri 00:01 | Premature escalations | Compare `addBusinessDays(from, n, tz) <= now` (keeps wall-clock time) |
| M-10 | M | MATH | Weekly digest counts won and lost deals as "pipeline" | `notifications/snapshot-core.ts:59-68` | **Test** `snap.test.ts`: open 5 + lost 40 + won 10 counts 55 (expected 5) | Misleading manager digest | Same fix as H-01 (stage category in the snapshot) |
| M-11 | M | MATH | ADS revenue categories deviate from PRD ADS-1 | `revenue/calc.ts:62-65` | Code: `negotiation` (alias "hot") maps to warm; `won` counts as "active deals closing"; `concentration()` includes unsigned "active" deals | Wrong ADS dashboard | Map negotiation to active and won to current; exclude active from concentration |
| M-12 | M | INT | Scout run lock is in-process memory | `scout/runs.ts:91-99` (`withRunLock` on a module `Set`) | Code: a resume, the webhook and the cron on different Fluid instances can advance the same run; `saveSteps` replaces the whole array | Apify actors started twice (real spend); lost step updates | Use a DB lease: `UPDATE scout_runs SET lock_until=now()+'5 min' WHERE id=$1 AND (lock_until IS NULL OR lock_until<now()) RETURNING id` |
| M-13 | M | INT | Proposal version numbers race | `proposals/actions.ts:69,102`; no `UNIQUE(deal_id, version)` | Code: `max(version)+1` outside a transaction | Duplicate versions | Add the unique index and retry on conflict |
| M-14 | M | INT | Account creation (`createAccount`) and lead registration create duplicate accounts when the domain is another account's alternate domain (e.g. after a merge) | `accounts/actions.ts:36-39`, `commissions/actions.ts:175,197` | Code: matches only `accounts.domain`; `accounts_domain_uq` covers only the primary domain. Scout's `crm-match` does check `altDomains` | Duplicate accounts; ownership protection bypassed | Reuse the `crm-match` lookup (`domain = $1 OR $1 = ANY(alt_domains)`) |
| M-20 | M | PERF | Pipeline list view ships every deal; the board trims per column | `app/(app)/pipelines/[key]/page.tsx:58` (`view === "list" ? deals`); `deals/queries.ts:197-208` (`select s.deals` full row, `limit(5000)`) | SQL estimate: NET list = 2,058 BoardDeals ≈ **1.9 MB JSON** before RSC encoding, and the HTML flight payload roughly doubles it. The query also fetches every deal column (avg 429 B/row: `healthExplanation`, `aiSummary`, `customFields`, `r100`) | Slow first paint on mobile (PRD: responsive to 375 px); silent truncation at 5,000 rows | Paginate or virtualize the list server-side (`limit/offset` + `count`), select only BoardDeal columns, and send `customFields` only for the gate keys |
| M-21 | M | PERF/MAINT | Two ad-hoc DB concurrency limiters; the analytics one is process-wide with MAX=2 | `analytics/limit.ts:7` (global semaphore shared by all requests); `deals/concurrency.ts` (per-call, 2-3) | Code: every analytics loader in the process shares 2 slots, so user B's dashboard waits behind user A's (the executive page fires about 14 queries). The root cause (pipelining on Supavisor) is fixed by `max_pipeline: 1` in `src/db/index.ts:18` | Head-of-line blocking under load; two contradictory patterns ("sequential on purpose" comments) | With `max_pipeline:1` and `max: DB_POOL_MAX`, postgres-js already queues per connection. Remove both limiters (or keep one per-request limiter) and load-test the executive page with about 5 concurrent users |
| M-22 | M | MATH/MAINT | Account 360 deal values ignore the deal-level `$/MUU` and rev share | `app/(app)/accounts/[id]/page.tsx:37-46` (`pipelineUsdPerMuu: d.usdPerMuu` where `d.usdPerMuu` is `pipelines.usdPerMuu`; no `usdPerMuu`/`revSharePct` passed); `accounts/queries.ts:222` | Code trace. Latent today (0 deals have a deal-level `usd_per_muu`), but the Account page will disagree with board and analytics as soon as one is set | Inconsistent gross/weighted per account | Add a `dealValueFromRow(deal, pipeline, stage)` helper in `pipeline-math.ts` and use it at all 8 call sites (see §4) |
| M-23 | M | PERF | Transcript sync reloads the whole contact and account directory once per transcript | `transcripts/ingest.ts:93` (`loadDirectory()` inside `ingestTranscript`), called in a loop from `granola.ts:73-97` (up to 25 per sync) | Code: `loadDirectory` selects every live contact and account with an email or domain (about 12k rows). Gmail ingest loads it once per run (`gmail/ingest.ts:26`) | Up to 25 full-table loads per Granola sync (runs in the My Day `after()`) | Pass a preloaded `Directory` into `ingestTranscript` (as Gmail does), or match with a targeted `WHERE email = ANY($1) OR domain = ANY($2)` query |
| M-24 | M | AI/NEXT | Copilot web-research tool can use the route's entire time budget | `copilot/service.ts:229` (`AbortSignal.timeout(60_000)`, Apify `timeout=45`) inside `api/copilot/route.ts:19` (`maxDuration = 60`) | Code: one web-research step can take 45-60 s, and there are up to 8 steps | The stream is killed mid-answer and `finalize` never logs | Cap web research at about 25 s, raise `maxDuration` to 120-300, and set a per-request deadline that stops further tool steps |
| M-25 | M | AI | Copilot hourly cap is counted from rows written when a stream ends | `api/copilot/route.ts:96-103,119-136` | Code: `agent_runs` is inserted in `finalize` (on end, error or abort). N parallel requests all see `n < cap`. The token bucket is per instance (`rate-limit.ts`) | The cap can be exceeded by concurrent requests or across instances | Insert a "started" `agent_runs` row before streaming and update it in `finalize` |
| M-26 | M | NEXT | Only `/analytics` and `/admin` have `error.tsx`; there is no `(app)/error.tsx` or `global-error.tsx` | `find src/app -name error.tsx` → 2 files | Any DB or pooler error on the other 15 modules renders Next's generic error page and loses the app shell | Poor failure UX | Add `(app)/error.tsx` with a retry (`reset()`) and a `global-error.tsx` |

(The integrity and Next.js findings H-09..H-13, M-15..M-19, M-27..M-28, L-17..L-25 and S-01..S-02 are in §2.)

### Low

| ID | Sev | Cat | Title | Location | Evidence / impact | Fix |
|---|---|---|---|---|---|---|
| L-01 | L | MATH | `computeFit` returns NaN for NaN inputs | `scout/fit.ts:189,194` | **Test** S1/S1b. Inputs are zod-validated today; an insert would fail | `Number.isFinite` guards |
| L-02 | L | MATH | `computeHealth` returns a perfect "100 On track" for invalid dates; hold deals are penalized like open ones | `deals/health.ts` | **Test** H1/H2. The hold case needs a product decision | Guard with `isNaN`; skip or neutral-score hold deals |
| L-03 | L | MATH | Commission cap of 0 means "uncapped", while the UI accepts 0 | `commissions/calc.ts:115` | Ambiguous | Treat `null` as uncapped; validate cap > 0 |
| L-04 | L | MATH | `pct_net` equals `pct_contract` on `invoice_paid` events | `commissions/engine.ts:273` (`netCents = amount`) | (suspected spec mismatch) | Confirm with finance |
| L-05 | L | TZ | Digest runs at 12:00 UTC, which is 07:00 EST after Nov 1 and wrong outside New York | `vercel.json`, `cron/digest` | PRD: users' local 08:00 | Run hourly and send when the user's local hour is 8 |
| L-06 | L | PERF | SLA rules (NS-04/07/15) only evaluate once a day (06:00Z) or on a My Day visit; a worst-case sweep (7 groups × 60 s × 2 attempts) can exceed `maxDuration` | `vercel.json`; `alerts/engine.ts:999-1010` | Documented Hobby-plan limit | Hourly cron on Pro; overall sweep deadline; no retry after a timeout |
| L-07 | L | PERF | NS-07 `exists(… a.meeting_id = m.id OR …)` does a seq scan of activities per meeting; NS-32 joins on `accounts.id::text = crm_match->>'accountId'` (not sargable) | `alerts/engine.ts` | EXPLAIN: SubPlan → Seq Scan on activities | Split into two EXISTS and add an index (§3); cast the other side instead |
| L-08 | L | MATH | NS-02/NS-09 fire on hold and "cold" stages (only NS-01 checks `category==='open'`) | `alerts/rules.ts` | Noise | Filter `stageCategory === 'open'` |
| L-09 | L | INT | Digest dedupe is check-then-insert with no unique key | `notifications/digest.ts:130-135` | Possible duplicates if runs overlap (none in the DB today) | Unique `(user_id, kind, date)` or `claim()` |
| L-10 | L | MAINT | Global search returns the first 8 matches in arbitrary order, and the LIKE escape doesn't escape `\` | `app/api/search/route.ts:14,29,39,44` | Exact and prefix matches can be missing from the 8 | `ORDER BY (lower(name)=q) desc, (name ilike q\|\|'%') desc, length(name)`; use one shared `likeEscape` |
| L-11 | L | MATH | `wonYtd`, `r100Live` and AR bucket months in UTC; YTD starts at 00:00 UTC Jan 1 | `analytics/executive.ts:231-233,267`; `filters.ts:29` | Month-end deals land in the next month for ET users | Bucket in the org time zone (`at time zone 'America/New_York'`) |
| L-12 | L | MATH | Rep scorecard attributes won and created value only to `deals.owner_id`; split partners get nothing, and "created value" is always gross whatever the basis | `analytics/reps.ts:84-94` | Commission reps with splits show 0 | Attribute through `deal_splits` weighted by pct, and respect the basis |
| L-13 | L | MATH | "Open pipeline MUU" KPI sums `deals.muu` across every motion | `executive.ts:48-57` | Not a problem today (R100 and ADS have no MUU) | Restrict to `unit='muu'` |
| L-14 | L | MAINT | Dead code: `muuPipelineValue` duplicates `dealValue` with no callers | `src/lib/domain.ts:73-76` | grep: 1 occurrence | Delete |
| L-15 | L | INT | Import artifacts became account names ("All operated by Oliver:" ×4, "Follow up 6/1" ×2) and there are 19 duplicate normalized names | read-only SQL on `rso.accounts` | Data-quality debt | Add to the Data Quality dashboard and fix the import heuristics that promote note rows to accounts |
| L-16 | L | PERF | `dealAccessWhere` queries `pipelines` on every call (not `cache()`d outside analytics); `getCurrentUser` does 4-5 sequential queries on every request | `rbac/server.ts:34-64,145` | About 6 extra round trips per page to eu-west-1 | `cache()` the pipeline list; fold team and reports into one query |

---

## 2. Data integrity, concurrency and Next.js

Baseline: there are 16 `db.transaction` call sites. The only serialization primitive is the commissions advisory lock. There is no `FOR UPDATE` and no optimistic `WHERE stage_id = $old` guard anywhere.

What checked out clean:
- No client component imports `server-only`, `@/db` or `next/headers` modules, directly or transitively (import-graph scan).
- Every `params` and `searchParams` is awaited.
- Cron routes set `maxDuration`.
- `after()` usage is sound.
- `dealAccessWhere`, `accountVisibilityWhere` and `contactVisibilityWhere` all include `deleted_at is null`.
- `normalizeDomain` is used by every creation path.
- Live DB: 0 duplicate domains, 0 split sets not summing to 100, 0 live deals or contacts on deleted accounts, and `deals.status` equals the stage category for all live deals.

### High

| ID | Sev | Cat | Title | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|---|
| H-09 | H | INT | Import commit is not atomic; a failure mid-flush leaves rows that rollback can't undo | `src/lib/import/engine.ts:968-1043` (`flush`), `app/api/import/commit/route.ts:33` | Code trace: <br>• `import_batches` is inserted as "running", then each entity chunk autocommits and updates run through `pool(updates,3)`. <br>• `import_records` (the rollback ledger) is written **last**. <br>• The catch only sets status "failed". <br>• The route has no `maxDuration`, and the engine never opens a transaction | An ECONNRESET, timeout or 23505 halfway through leaves real rows with no ledger; `rollbackBatch` removes nothing. Two concurrent commits of one file both `load()` before writing, so accounts matched only by name are duplicated | Run `flush` in `db.transaction(tx => …)` with the engine bound to `tx` (chunked inserts are fine inside a tx on the pooler). Take `pg_advisory_xact_lock(hashtext('rso.import'))`. Add `maxDuration = 300`, and an idempotency key (file hash + mapping) on `import_batches` |
| H-10 | H | INT | Account merge runs about 17 writes with no transaction and misses polymorphic references | `accounts/actions.ts:147` → `mergeAccounts(db, …)` in `accounts/merge.ts:65-113` | Code trace: <br>• 13 child re-points, then the brand re-point, source soft-delete and target patch, each separate. <br>• The source and target reads take no lock. <br>• Not moved: `restricted_access` (entity='account'), `comments`, open `alerts`, `approvals.entity_id`. <br>• `mergeDeals` (merge.ts:140-161) doesn't move `invoices`, `email_threads`, `meetings`, `migration_projects` or `proposals` | A partial failure splits children across both accounts. Concurrent A→B and B→A merges can soft-delete both. Access lists are lost when the target becomes restricted. Invoices on merged deals vanish from AR (hidden by the deal's `deletedAt`) while NS-23 keeps alerting | `db.transaction(async tx => { select … where id in ($a,$b) for update; mergeAccounts(tx, …) })` (the function already takes a client). Re-point the missing tables, merging `restricted_access` on conflict |
| H-11 | H | INT | Stage moves have no concurrency guard; a double submit on "won" runs won side-effects twice | `deals/stage-service.ts:186-190` (`update … where id = $1` only), `deals/service.ts:212-231` (`onDealWon`), `onboarding/service.ts:23-35` | Code trace: <br>• Validation uses the `ctx.deal` snapshot. <br>• `ensureMigrationProject` and the ADS invoice seeding are select-then-insert under READ COMMITTED. <br>• There is no unique index on `migration_projects.deal_id` or `invoices(deal_id, due_at)`. <br>• The update rebuilds `customFields`/`r100` from the stale snapshot | Duplicate stage history, activities, migration projects and **ADS invoices** (revenue error). Last writer wins on the JSON fields | `.where(and(eq(deals.id,id), eq(deals.stageId, ctx.deal.stageId), isNull(deals.deletedAt))).returning()`; 0 rows → `UserError("Deal changed, reload")`. Add a partial unique index on `migration_projects(deal_id)` and a unique index on `invoices(deal_id, due_at)` with `onConflictDoNothing` |
| H-12 | H | INT/MAINT | The R100 board's stage change bypasses the canonical stage-change path | `r100/actions.ts:58-99` (`setR100Stage`) | Code: writes `deals`, history and activity directly. It skips `requiredFields` gates, lost/hold reasons (`lostAt` set, `lostReason` null), `requiresApproval`, `onDealWon`, `recomputeDealHealth` and the lastActivityAt bump. It keeps `wonAt` on reopen, whereas stage-service nulls it | Approval-gated stages can be bypassed from the R100 board, and won analytics disagree between the two paths | Replace the body with `moveDealToStage(user, dealId, {id: stageId}, {}, {via:"board"})` |
| H-13 | H | INT | A failed approval handler reverts the approval to pending after the deal already moved, and it stays stuck | `approvals/service.ts:61-72`, `approvals/registry.ts:128-145` | Code trace: <br>• `decide` claims the row conditionally (good), then runs `handler.apply`; on a throw it resets to pending. <br>• `stage_gate` → `moveDealToStage` commits, then `audit()` and `recomputeDealHealth()` can throw. <br>• A re-approval throws "already in that stage". <br>• The same pattern applies to the bulk `probability_override` and `scout_accept` handlers (partially applied) | Approvals stuck pending forever; partial bulk overrides | Make handlers idempotent ("already in target" = success). Pass `tx` to `apply` so the claim and the writes commit together, and run audit and health after commit without throwing |

### Medium

| ID | Sev | Cat | Title | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|---|
| M-15 | M | INT | Two decision paths for the same approvals | `deals/actions.ts:661-680` (`decideProbabilityOverride`), `proposals/actions.ts:116-146` (`decideProposal`) vs `approvals/service.ts decide()` | Code: <br>• Snapshot check, then an unconditional deal update. <br>• A rejected override keeps `probabilityOverride` (the registry path nulls it). <br>• No NS-18/NS-29 alert resolution. <br>• `decideProposal` lets the requester approve their own proposal, which `canDecide` (`registry.ts:49`) forbids | Deal "approved" while the approval is "rejected"; separation of duties bypassed | Route both UIs through `decide()` |
| M-16 | M | INT | Transcript "Apply" inserts tasks before validation and is not idempotent | `transcripts/apply.ts:56-77` vs checks at 81-94 | Code: `ForbiddenError`/`UserError` can throw after the tasks exist; a retry or double-click duplicates them; there's no `appliedAt` guard | Duplicate tasks; the user sees an error but the side effects happened | Validate first, then do every write in one transaction; dedupe on `(evidence_source, title)` |
| M-17 | M | INT | Import rollback overwrites later edits and orphans children; several readers lack `deletedAt` filters | `import/engine.ts:1069-1123`; `tasks/queries.ts:114`; `alerts/engine.ts:522-526` (NS-20), `:596-600` (NS-23), NS-05/06/16/19/26 and `openCommitments`; `deals/queries.ts:373-376` (account loaded without `deletedAt`) | Code: `before` snapshots restored unconditionally, not transactional; accounts/contacts/deals soft-deleted with user-created children still attached | Rolling back an old batch loses later edits; alerts and tasks keep firing on deleted deals; deal page links to a 404 account | Wrap in a transaction. Refuse or warn when `updated_at > batch.created_at` or a later batch touched the row. Block or re-point non-batch children. Add `isNull(deals.deletedAt)` (via left join) to the listed rules and task queries |
| M-18 | M | INT | Other multi-step writes outside a transaction | `deals/actions.ts:186-204` (account created before the deal tx at 214); `stage-service.ts:181` (inline contact before the move tx); `deals/actions.ts:506-513` (`addStakeholder`, 3 statements); `:648-657` (`clearProbabilityOverride`); `commissions/actions.ts:199-225` (`registerLead`: account, registration, approval, notifications); `onboarding/service.ts:36` (`audit()` on global `db` inside a caller's tx, so it survives rollback and takes a second pool connection) | Code trace | Orphan accounts and contacts; audit rows for rolled-back work; pool pressure (same class as H-03) | One transaction per action; pass `tx` into `audit()` and `logActivity()` |
| M-19 | M | INT | The deals-module `notify` throws after the business write commits | `deals/service.ts:191-195` (no try/catch, unlike `notifications/notify.ts:21-32`), called after commit at `deals/actions.ts:241,291,474,602` | Code trace | "Something went wrong" after the deal or comment was created; a retry creates a **duplicate deal** | Delete the deals-module `notify`; use `notifyMany` (swallows and logs) |
| M-27 | M | TZ/NEXT | Date-only fields render a day early in US browsers and cause hydration mismatches; `fmtRelative` used in client lists | `deals/actions.ts:32-43` (`optDate` → UTC midnight); `lib/format.ts:26-30` (`fmtDate` in process TZ); client components `header-editors.tsx:52,127`, `deals-table.tsx:189`, `side-panels.tsx:282`, `type-panels.tsx:275`, `r100-table.tsx`, `invoices.tsx`, `onboarding-view.tsx`; `fmtRelative` in `notification-list.tsx:71`, `contacts-list.tsx:56`, `accounts-list.tsx:78`, `users-admin.tsx:219`, `searches-table.tsx:81` | Code trace: the server (UTC) renders "1 Oct" and a New York browser renders "30 Sep". Onboarding uses `T12:00:00Z` instead (a different convention) | Visible off-by-one dates; React hydration warnings | Format date-only values in UTC (`toISOString().slice(0,10)` or `formatInTimeZone(d,'UTC',…)`); use the existing `RelativeTime` component everywhere; one date-only storage convention (see M-06) |
| M-28 | M | MAINT/INT | Two `setTaskStatus` actions with different behaviour | `deals/actions.ts:482-495` vs `tasks/actions.ts:127-148` | Code: the deal-page version doesn't resolve NS-05/06/26 alerts, clear `snoozedUntil` or notify the creator; it has different permissions and a read-modify-write on status | Stale task alerts; inconsistent permissions | One task service function |

### Low

| ID | Title | Location | Fix |
|---|---|---|---|
| L-17 | Read-modify-write toggles and JSON blobs: `toggleActivityPin` (`!a.pinned`), `addDocument` version = max+1 with no unique index, `updateChecklist`, both `updateR100` actions, `saveImportTemplate` | `deals/actions.ts:429,554-567,350`; `r100/actions.ts:46`; `import/actions.ts:23-35` | `set pinned = not pinned`; unique `(deal_id, name, version)`; `jsonb_set`/`||` patches |
| L-18 | Stage-gate approval request is check-then-insert | `stage-service.ts:127-151` | Partial unique `approvals(kind, entity_id) where status='pending'` |
| L-19 | Escalation update is `where id` from a stale snapshot, so it can re-escalate an alert the user just resolved; the cron sweep and "Run sweep now" skip `claim()` | `alerts/engine.ts:1111-1115`; `api/cron/sweep` vs `background/index.ts:88` | Add `inArray(state, OPEN_STATES)` to the update; claim in the cron route |
| L-20 | Gmail ingest inserts the message and then the activity separately; if the activity fails, the retry sees "duplicate" and the activity is lost | `gmail/ingest.ts:134-165` | One transaction |
| L-21 | Contact creation from the stage dialog skips the email-duplicate check; `emailTaken` ignores `altEmails`; no unique index on `lower(email)` | `stage-service.ts:52-61`, `contacts/actions.ts:45-68` | A shared `createContact` service; partial unique index on `lower(email)` |
| L-22 | `linkContactToDeal` doesn't enforce contact.account = deal.account (`assertContactUsable` does) | `contacts/actions.ts:110-124` | Reuse `assertContactUsable` |
| L-23 | CSV builders disagree on negative numbers: two of them prefix `'` to "-5", which corrupts the value | `admin/audit-core.ts:~40`, `api/import/export/route.ts:14` vs `deals/csv.ts:6` | Use `deals/csv.ts` everywhere |
| L-24 | `revalidatePath` gaps: `decideApproval` and `applyCallReview` change deals without revalidating `/deals/[id]` or `/pipelines/*` (pages are dynamic, so only the client router cache is affected) | `approvals/*`, `transcripts/*` | Add `revalidateDeal()` |
| L-25 | `Date.now()` / `new Date()` in client render | `users-admin.tsx:56`, `r100-table.tsx:337` | Pass `nowIso` from the server |

### Flagged for the security audit

| ID | Title | Location | Note |
|---|---|---|---|
| S-01 | `bulkMoveStage` error path returns the names of deals the caller can't see, restricted ones included | `deals/actions.ts:74-76` (`select name from deals where id` with no access filter) | Verified. Return a generic reason |
| S-02 | (suspected) Accounts export includes restricted accounts | `api/import/export/route.ts:38-60` (no `!restricted` filter, unlike the deals export at `deals/actions.ts:730`) | Breaks ENGINEERING.md rule 3 |
| S-03 | Restricted deal names in escalation copies | = H-07 | |
| S-04 | Copilot trusts the client-supplied message history, including prior assistant and tool turns (`api/copilot/route.ts:112`) | | (suspected) forged tool results can steer the model; persist the conversation server-side |

---

## 3. Performance

### 3.1 Scale and EXPLAIN highlights (live DB, read-only, `EXPLAIN (ANALYZE, BUFFERS)`)

| # | Query (as issued by the app) | Plan | Time | Notes |
|---|---|---|---|---|
| 1 | **Board load**, NET (`deals/queries.ts listDealsForBoard`): `deals ⋈ accounts ⋈ user`, access predicate, `order by updated_at desc limit 5000` | Index Scan `deals_pipeline_stage_idx` (2,058 rows) → Hash Right Join with a **Seq Scan on accounts (8,695)** → Memoize on user → in-memory quicksort (1.4 MB) | **10.2 ms** | The DB is cheap; the cost is the ≈1.9 MB payload (M-20). The accounts seq scan is chosen because 2k of 8.7k rows are needed; fine |
| 2 | **Accounts list** (`accounts/queries.ts listAccounts`), `q=news`, page 1, sort by name | **Seq Scan on accounts** + ILIKE filter (8,523 rows removed) → top-N heapsort on `lower(name)` → two correlated subplans per row via `deals_account_idx` | **24.8 ms** | `accounts_name_idx` is on `name`, not `lower(name)`, so it can't serve the sort. Deep page (`offset 8000`) = 21.8 ms (full sort of 8,050 rows) |
| 3 | **Executive** `pipelineByMotion` (group by motion over deals ⋈ stages ⋈ pipelines) | Seq Scan deals (3,178) → Hash Joins → HashAggregate | **3.8 ms** | Fine. The value-sql approach is the right pattern |
| 4 | **Search** (`api/search`): three ILIKE queries | Seq Scan accounts 21.9 ms (no hit), deals 4.8 ms, contacts 3.5 ms | ≤ **22 ms** | Grows linearly; `pg_trgm` is available but not installed |
| 5 | **Alert sweep**: one full sweep ≈ **5.5 s** end-to-end (sub-audit measurement) | Rule queries are sub-ms to low-ms; the time goes to about 35 rules × round trips to eu-west-1 plus per-group timeouts. NS-07 has a per-meeting seq scan of activities (L-07) | — | Round-trip bound, not index bound |
| — | Overdue next-step count | Index Scan `deals_next_step_idx` | 0.06 ms | Good |

Conclusion: at 8.5k accounts and 3.2k deals the database is not the bottleneck. Latency comes from:

- sequential round trips (auth plus RBAC plus loaders, about 15-20 per page, throttled to 2-3 in flight by the limiters in M-21);
- RSC payload size (M-20);
- external calls with no timeouts (H-08).

The indexes below are cheap insurance for 10× growth and for the hot filters that currently rely on seq scans.

### 3.2 Index recommendations

```sql
-- Fuzzy search on accounts/contacts/deals (global search, accounts list q=, board q=, Copilot lookups)
create extension if not exists pg_trgm with schema extensions;
create index concurrently accounts_name_trgm   on rso.accounts using gin (name extensions.gin_trgm_ops)   where deleted_at is null;
create index concurrently accounts_domain_trgm on rso.accounts using gin (domain extensions.gin_trgm_ops) where deleted_at is null;
create index concurrently contacts_name_trgm   on rso.contacts using gin (full_name extensions.gin_trgm_ops) where deleted_at is null;
create index concurrently contacts_email_trgm  on rso.contacts using gin (email extensions.gin_trgm_ops) where deleted_at is null;
create index concurrently deals_name_trgm      on rso.deals    using gin (name extensions.gin_trgm_ops)   where deleted_at is null;

-- Accounts list default sort (lower(name)) + keyset pagination; alt-domain lookups (crm-match, deal create, directory)
create index concurrently accounts_lower_name_idx on rso.accounts (lower(name), id) where deleted_at is null;
create index concurrently accounts_alt_domains_gin on rso.accounts using gin (alt_domains) where deleted_at is null;
create index concurrently contacts_alt_emails_gin  on rso.contacts using gin (alt_emails)  where deleted_at is null;

-- Board ordering and per-account open-deal subqueries (accounts list openDeals / pipelines columns)
create index concurrently deals_pipeline_updated_idx on rso.deals (pipeline_id, updated_at desc) where deleted_at is null;
create index concurrently deals_account_status_idx   on rso.deals (account_id, status) where deleted_at is null;
create index concurrently deals_won_at_idx           on rso.deals (won_at) where status = 'won' and deleted_at is null;
create index concurrently deals_created_at_idx       on rso.deals (created_at) where deleted_at is null;
create index concurrently stage_hist_changed_idx     on rso.deal_stage_history (changed_at);  -- weeklyMovement, reps "advanced"

-- Alerts / revenue / commissions (sub-audit)
create index concurrently invoices_deal_idx        on rso.invoices (deal_id);
create index concurrently invoices_open_due_idx    on rso.invoices (due_at) where paid_at is null and status in ('scheduled','sent','overdue');
create index concurrently activities_meeting_idx   on rso.activities (meeting_id) where meeting_id is not null;
create index concurrently email_threads_awaiting_idx on rso.email_threads (awaiting_reply_from, last_message_at);
create index concurrently tasks_open_commit_idx    on rso.tasks (owed_by, due_at) where status = 'open';
create index concurrently meetings_ends_idx        on rso.meetings (ends_at) where transcript_id is null;
create index concurrently notifications_digest_idx on rso.notifications (kind, created_at);
create index concurrently commission_accruals_user_period_idx on rso.commission_accruals (user_id, period);

-- Integrity constraints that double as indexes (CR-01, M-13)
alter table rso.commission_accruals add column accrual_key text;       -- backfill from note '[k:…]', then set not null
create unique index concurrently commission_accruals_key_uq on rso.commission_accruals (user_id, plan_id, accrual_key);
create unique index concurrently proposals_deal_version_uq on rso.proposals (deal_id, version);
```

Per ENGINEERING.md, the lead should apply these through a central Drizzle migration, not ad hoc. `create index concurrently` can't run inside a transaction, so run those statements outside the migration transaction or on the session pooler (port 5432).

### 3.3 Supabase transaction pooler (port 6543) check

- **Correct:**
  - `prepare: false` and `max_pipeline: 1` are set (`src/db/index.ts`).
  - The commissions lock uses `pg_advisory_xact_lock` inside a transaction, which is safe on the pooler.
  - Background claims use a conditional upsert on `app_settings` (`lib/background/index.ts:22-31`), which is also safe.
- **Nothing found that uses session state:** no session-level `SET`, `pg_advisory_lock` (non-xact), `LISTEN`, or temp tables in `src/`.
- **Not correct:**
  - H-03: the commissions transaction needs a second pooled connection for its reads.
  - H-04 / M-12: locks that should exist don't.
- `scripts/_db.ts` correctly uses the session pooler for migrations.

### 3.4 Other performance items

- M-20: list-view payload.
- M-21: limiters.
- M-23: per-transcript directory reload.
- L-16: auth/RBAC round trips.
- `pipelineOverview` (`deals/queries.ts:88-150`) loads every visible deal row into JS to compute per-pipeline totals. The same numbers are one `GROUP BY` with `value-sql.ts` (3.8 ms, plan #3); switch to it.

---

## 4. Duplication and consolidation

| Concern | Implementations found | Consolidate into |
|---|---|---|
| **Deal value input mapping** (row → `dealValue()`) | `deals/queries.ts:129,228,490`; `deals/summary.ts:91`; `copilot/queries.ts:80,654`; `copilot/report.ts:40`; `commissions/engine.ts:214`; `notifications/snapshot-core.ts:47`; `app/(app)/accounts/[id]/page.tsx:38` (already wrong: M-22) | `dealValueFromRow({deal, pipeline, stage}, {hideRevShare, includeOverrides})` in `pipeline-math.ts`, plus a parity test that runs `value-sql` and `dealValue` over fixtures (a pglite or DB-backed test, like `audit-main/parity.ts`) |
| **Pipeline aggregation** (sum gross/net/weighted by group) | SQL: `analytics/executive.ts`. JS: `deals/queries.ts pipelineOverview`, `copilot/report.ts aggregatePipeline`, `notifications/snapshot-core.ts aggregateSnapshot`, board `columnTotals` | One SQL aggregate builder on `value-sql.ts` (for dashboards, overview, snapshots, Copilot); keep the JS path only for the client board |
| **"Open" definition** | `stages.category='open'` (executive, snapshots), `deals.status='open'` (reps, copilot report, board KPIs), status in (open, hold) (crm-match) | A `OPEN_DEAL` SQL fragment and an `isOpen()` helper; they agree today (status = category for all 3,178 deals), but the invariant is enforced only by `stage-service.ts` |
| **Month / period / day bucketing** | `commissions/calc.ts periodOf` (UTC), `alerts/rules.ts monthIndexSince` (anniversary), `r100/calc.ts participationMonthIndex` (calendar), `revenue/calc.ts startOfDay` (UTC), `analytics` `to_char(... 'UTC')`, `alerts/time.ts` (TZ-aware) | One `src/lib/time.ts` with an org-TZ `periodKey`, `localDateKey`, `monthIndex`, `addBusinessDays`, all driven by an `org.timezone` setting |
| **DB concurrency limiters** | `analytics/limit.ts` (process-wide, 2), `deals/concurrency.ts allLimited` (per call, 2-3), `import/engine.ts:145` serial runner, `alerts/engine.ts` chunked `Promise.all` | Remove them after the `max_pipeline:1` fix (M-21), or keep one per-request helper |
| **LIKE escaping** | `deals/queries.ts likeEscape`, `accounts/queries.ts:88` inline, `api/search/route.ts:14` (doesn't escape `\`), plus the copilot guards | `src/lib/sql.ts likePattern(q)` |
| **In-process "locks"** | `scout/runs.ts withRunLock`, `background/index.ts running` Set, Copilot `TokenBucket` | A DB lease helper (`claim(key, ttl)` already exists in `background/index.ts`; generalize it) |
| **Interview / participation rules** | `alerts/rules.ts` (NS-21/22) vs `r100/calc.ts` | Rules import from `r100/calc.ts` (H-06, M-01) |
| **Overdue / aging** | `alerts/rules.ts invoiceOverdueTier` (ms) vs `revenue/calc.ts daysOverdue` (days) | `revenue/calc.ts` as the single source (M-07) |

| **Stage change** | `deals/stage-service.ts performStageMove` (canonical) vs `r100/actions.ts setR100Stage` (bypass, H-12); deal-creation history and activity written separately in `deals/actions.ts:214-238`, `scout/accept.ts:196-197`, `import/engine.ts` | Route all moves through `moveDealToStage`; extract `createDealWithHistory(tx, …)` |
| **Notifications** | `deals/service.ts:191 notify` (throws, tx-aware) vs `notifications/notify.ts notify/notifyMany` (swallows); raw inserts in `commissions/actions.ts:223`, `commissions/registration-service.ts:44`, `scout/budget.ts:101`, `gmail/analyze.ts:136`, `proposals/actions.ts:50,140` | `notifications/notify.ts` only, with an optional `tx` |
| **Approvals** | Create: `approvals/service.ts requestApproval` vs direct inserts in `deals/actions.ts:627`, `commissions/actions.ts:213`, `scout/actions.ts:155,235`, `proposals/actions.ts:47`. Decide: `decide()` vs `decideProbabilityOverride`, `decideProposal` (M-15) | `approvals/service.ts` only |
| **Activity logging** | `deals/service.ts:96 logActivity` vs raw inserts in `transcripts/apply.ts:108`, `transcripts/ingest.ts:137`, `scout/accept.ts:197`, `r100/actions.ts:79`, `gmail/ingest.ts:152`; the raw ones skip the `lastActivityAt`/`lastContactedAt` bump | `logActivity(tx?, …)` everywhere |
| **Placeholder claim** | `accounts/placeholders.ts:15` (**dead**, non-transactional, no importers) vs `admin/claim.ts:23` (transactional); `isPlaceholderEmail` in both `import/owners.ts` and `admin/claim-plan.ts` | Delete `accounts/placeholders.ts`; one `isPlaceholderEmail` |
| **Task status** | `deals/actions.ts:482` vs `tasks/actions.ts:127` (M-28) | Tasks service |
| **R100 JSON patch** | `deals/actions.ts:350 updateR100` vs `r100/actions.ts:46 updateR100` (same name, different merge semantics) | One `r100/service.ts` |
| **Contact creation** | `stage-service.ts:52 createContactForDeal` vs `contacts/actions.ts:54 createContact` | Contacts service |
| **Account-by-domain lookup** | `accounts/actions.ts:36`, `deals/actions.ts:187`, `commissions/actions.ts:175,197`, scout `matchDomains`, import `accByDomain`, with inconsistent `altDomains` handling (M-14) | `findAccountByDomain(domain)` (domain OR alt_domains); map 23505 to `UserError` |
| **CSV export** | `deals/csv.ts`, `admin/audit-core.ts`, `api/import/export/route.ts:10`, `commissions/export/route.ts:16` | `deals/csv.ts` (moved to `lib/csv.ts`) |
| **Money formatting** | `lib/format fmtUsd` vs `scout/bits.tsx:121 usd()`, `scout/budget-core.ts:68`, `approvals/registry.ts:213`, `alerts/engine.ts:619`, `notifications/digest.ts:147`, `proposals/calc.ts:295 usdK`, `proposal-controls.tsx:95` | `lib/format` |
| **Date formatting and date-only storage** | `lib/format fmtDate/fmtRelative` (process TZ) vs `tasks/core.ts:52 fmtInTz` vs `copilot/service.ts:249 fmtInZone` vs `alerts/time.ts`. Storage: UTC midnight (`optDate`) vs `T12:00Z` (onboarding `toDate`) vs `YYYY-MM-DD` strings (r100 JSON) | `lib/time.ts` + one date-only convention (`date` column or `YYYY-MM-DD`) |

**Large files to split:**
- `alerts/engine.ts` (1,165 lines): split into a rule registry, runner and upsert/escalate.
- `import/engine.ts` (1,125 lines): split into load/match, plan and flush/rollback.
- `deals/actions.ts` (779 lines): split per concern (value, override, tasks, docs, comments).
- `copilot/queries.ts` (743 lines).

**Dead code:**
- `domain.ts muuPipelineValue`
- `accounts/placeholders.ts`

**Missing tests for critical pure logic:**
- `dealValue` has only 3 tests and no SQL-parity test.
- Commission plan-edit idempotency, clawback from engine-shaped data, split rounding, the period timezone boundary, and caps across months and splits.
- `checkBudget` with concurrent reservations.
- `computeFit` with NaN inputs; `computeHealth` for hold deals and invalid dates.
- Pro forma with duplicate lines, fractional terms and long ramps.
- Business-day and escalation boundaries.
- `snapshotDelta` and the executive snapshot readers.

---

## 5. Prioritized fix plan (top 15)

| # | Fix | Findings | Effort |
|---|---|---|---|
| 1 | **Stable commission rule IDs + `accrual_key` unique constraint.** Backfill keys from `note`, then `ON CONFLICT DO NOTHING`. Freeze plan edits until shipped | CR-01 | M |
| 2 | **Route every commission-engine query through the transaction.** Use `pg_try_advisory_xact_lock` and return "already running" | H-03 | S |
| 3 | **Store `event_at` on accruals; clawback from it.** Add the refund/write-off reversal | H-02, M-04 | S-M |
| 4 | **Optimistic stage-move guard** (`WHERE stage_id = old`). Unique `migration_projects(deal_id)` and `invoices(deal_id, due_at)`; send R100 board moves through `moveDealToStage` | H-11, H-12 | S |
| 5 | **Transactional import commit and rollback.** Advisory lock, `maxDuration=300`, idempotency key, rollback conflict checks | H-09, M-17 | M |
| 6 | **Transactional account merge with row locks.** Re-point polymorphic references (restricted_access, comments, alerts, approvals) and all deal children in `mergeDeals` | H-10 | S-M |
| 7 | **Fix executive snapshot semantics.** Swap the override columns; store the stage category; filter to open stages in trend, WoW and digest | H-01, M-10 | S |
| 8 | **Alert lifecycle.** Suppression fingerprint for dismissed/resolved alerts; move alerts on owner change; guard escalation updates by state; `claim()` in the cron sweep | H-05, M-08, L-19 | M |
| 9 | **MNPI leaks** (with the security audit): escalation titles via `dealLabel`, the `bulkMoveStage` error path, the accounts export filter | H-07, S-01, S-02 | S |
| 10 | **Scout spend control.** Reserve `maxAllowedCents` under an advisory lock; DB lease for the run lock | H-04, M-12 | S-M |
| 11 | **One org-timezone time module.** Date-only convention for due dates; business days by wall-clock time; UTC formatting of date-only values in the UI | M-03, M-06, M-07, M-09, M-27, L-05, L-11 | M |
| 12 | **R100 rules from `r100/calc.ts`.** Month index and interview rules shared with the UI | H-06, M-01 | S |
| 13 | **Approvals: one decision path, idempotent handlers, claim and apply in one transaction** | H-13, M-15 | M |
| 14 | **AI hardening.** Timeouts, `maxRetries:1`, `maxOutputTokens`, usage logging, a pre-inserted `agent_runs` row for the Copilot cap, a shorter web-research timeout and a higher `maxDuration` | H-08, M-24, M-25 | S |
| 15 | **Performance and resilience.** Paginate the list view and slim the board select; remove the two ad-hoc limiters (keep `max_pipeline:1`); preload the Directory for transcript sync; add `pg_trgm` + `lower(name)` and the other indexes in §3.2; add `(app)/error.tsx` + `global-error.tsx` | M-20, M-21, M-23, M-26, §3.2 | M |

Next in line:
- `dealValueFromRow` consolidation (M-22).
- The notify, activity and CSV consolidation (§4).
- Proposal line dedupe and version unique index (M-05, M-13).
- Split rounding (M-02).
- Non-transactional multi-step writes (M-16, M-18, M-19).

---

## Appendix A: key reproductions

Run with `vitest run --config <tmp config>`, where the tmp config sets `root` to the repo, `alias @ → src`, and `include` to the tmp test path.

```ts
// H-01 snapshot semantics (audit-main/tests/snapshot.test.ts) — FAILS on main
const execWeighted = (r, overrides) => overrides ? r.weightedCents : r.weightedCents - r.overrideWeightedCents; // executive.ts:332/351
const [row] = aggregateSnapshot([{ pipelineKey: "NET", stageKey: "demo", unit: "muu", muu: 1_000_000, usdPerMuu: null, pipelineUsdPerMuu: 1,
  revSharePct: null, pipelineRevSharePct: 0.5, contractValueCents: null, annualizedValueCents: null, stageProbability: 0.5,
  probabilityOverride: null, overrideStatus: null }], [{ pipelineKey: "NET", stageKey: "demo" }]);
expect(execWeighted(row, false)).toBe(50_000_000);   // actual: 0

// CR-01 (audit-math/audit.test.ts) — FAILS on main
const run1 = planAccruals({ ...base, rules: [ruleA_meeting, ruleB_won], events: [wonEvent], existingKeys: new Set(), periodTotals: new Map() });
const run2 = planAccruals({ ...base, rules: [ruleB_won], events: [wonEvent], existingKeys: new Set(run1.map(d => d.key)), periodTotals: new Map() });
expect(run2).toEqual([]);                           // actual: one new draft keyed "0|deal_won|deal-1"

// H-02 — FAILS on main
expect(clawbackDue({ eventAt: null /* wonAt nulled by stage-service on lost */, lostAt: new Date("2026-09-20"), clawbackDays: 90 })).toBe(true); // actual false

// M-06 — FAILS on main
expect(nextStepOverdue(new Date("2026-10-01") /* stored 00:00Z */, new Date("2026-10-01T00:30:00Z") /* 20:30 EDT Sep 30 */)).toBe(false); // actual true
```

Value-math parity (read-only, live DB): `tsx --conditions=react-server audit-main/parity.ts` → `{"rows":3178,"mismatches":0}`.

---

## Remediation status (data-integrity fix pass, 2026-09-30)

Branch `worktree-agent-a5cfc46d215e93cba` (from `main` @ `09eff2f`). Schema used as hardened by migration 0003; no
schema or migration files were edited. Gates: `next typegen && tsc --noEmit`, `eslint src --max-warnings=0`,
`vitest run` (37 files, 419 tests) all pass. Appendix A reproductions are now regression tests:
`src/lib/commissions/__tests__/regressions.test.ts` (CR-01, H-02), `src/lib/notifications/__tests__/snapshot-regressions.test.ts`
(H-01, M-10), `src/lib/alerts/__tests__/regressions.test.ts` (H-05, H-06, M-06, M-09, QA-04, QA-12),
`src/lib/scout/__tests__/budget-reservation.test.ts` (H-04).

Live verification (shared DB, rows prefixed `[test] fixdata`, all removed afterwards): a transactional suite ran the
real service functions — double won move, concurrent accrual runs, plan edit, loss clawback, account + deal merge,
bulk override approval, failing stage-gate approval, concurrent scout reservations, dismiss → sweep → clear → re-occur,
NS-26 escalation without a manager, import commit through `/api/import/commit` + rollback — all PASS, including while
10 heavy pages were loading in parallel.

| ID | Status | What changed (where) |
|---|---|---|
| QA-01 | **Fixed (root cause)** | postgres-js still pipelines with `max_pipeline: 1` (the active query isn't counted, verified against the pooler); pipelined statements through Supavisor caused the ClientRead stalls / 30 s ECONNRESET. The drizzle client now caps in-flight queries + transactions at `DB_POOL_MAX`, so nothing is pipelined (`src/db/index.ts` `limitInFlight`). (`max_pipeline: 0` also stops pipelining but breaks `sql.begin` → UNSAFE_TRANSACTION; don't use it.) Every transaction was audited for global-`db` use: fixed in commissions, onboarding, scout accept, audit(), stage moves, approvals, merge, import; any remaining one now bypasses the limiter and logs a warning. `onRequestError` + action errors log a ref + driver cause without params (`src/instrumentation.ts`, `src/lib/errors.ts`). Before: 3 of 4 parallel pages failed after 38–90 s. After: 10 heavy pages × 3 rounds in parallel, all 200 in 7.2–7.4 s wall (dev server). |
| CR-01 | Fixed | Stable rule ids (uuid kept by the editor/`savePlan`; content hash for legacy rules); `source_key = <trigger>:<ruleId>:<eventId>:<userId>` + `ON CONFLICT DO NOTHING` on the unique index (`commissions/calc.ts`, `engine.ts`, `actions.ts`, `components/commissions/plans.tsx`). 0 accrual rows existed, so no key migration was needed. |
| H-02 | Fixed | Clawback event time = last entry into a won stage from `deal_stage_history` (stage-service keeps clearing `won_at` on reopen/loss so won analytics stay right), go-live for `migration_launched`, accrual time as a never-early fallback (`clawbackEventAt`). |
| H-03 | Fixed | Whole run in ONE transaction with `pg_try_advisory_xact_lock` (`withXactLock`); every query on `tx`; a concurrent run returns "already running". |
| H-04 | Fixed | `reserveRun`: budget check + run insert under `pg_advisory_xact_lock('rso.scout.budget')`; a queued/running run reserves its full cap (plan `maxAllowedCents`), reconciled to actual cost when it finishes (stale > 1 day counts actual only). M-12: run lock is a DB lease on `enrichment_runs.lease_until`. |
| H-01 | Fixed | Snapshots are open stages only; executive trend / "vs last week" read `override_weighted_cents` for incl. overrides and `weighted_cents` for excl. (was swapped) and ignore legacy non-open rows (`analytics/executive.ts` snapshot functions only, `notifications/snapshot-core.ts`, `snapshots.ts`). M-10 fixed with it. |
| H-05 | Fixed | Dismissed alerts stay suppressed until the condition clears (then re-occurrence alerts again); user-resolved alerts get a 24 h cool-down (rule param `cooldownHours`), then re-raise quietly without a second notification (`alerts/suppression.ts`, `engine.ts`). Stored without a new column: on a closed alert `snoozed_until` = "suppression lifted at". |
| H-06 | Fixed | NS-21 uses the R100 page's calendar month index and only months 1..`months` (default 3); clears when ticked. M-01 (interview fields) not in this pass. |
| QA-04 | Fixed | Escalation (NS-12/25/26 and the escalation step) → manager → team lead → all active sales leaders → executives; escalation update guarded by state (L-19). Snooze dialog copy updated. Admin "escalation unconfigured" warning left to UX. |
| H-07 | Not touched (security pass owns the escalation text) | |
| H-08 | Fixed | `AbortSignal.timeout` 20 s fast / 60 s strong covering retries, `maxRetries: 1`, `maxOutputTokens` caps, token usage (+ gateway cost when reported) logged to `agent_runs`; all callers already fall back on throw. Copilot streaming route (M-24/M-25) not changed. |
| H-09 | Fixed | Each flush chunk writes its rows and their `import_records` in one transaction; concurrent-commit guard; rollback is one transaction with the batch row locked; route `maxDuration = 300`. Batch `70404ba2` repair SQL documented (not applied) in `docs/IMPORT_REPORT.md`. |
| H-10 | Fixed | Merge in one transaction (savepoint when nested) after locking both rows in id order; re-points restricted_access (merged), comments, approvals, alerts (colliding open ones resolved), scout `crm_match`; merged deals move invoices, email threads, meetings, transcripts, proposals, accruals, enrichment runs and the migration project when free. The merge action audits inside the transaction. |
| H-11 | Fixed | Deal row `SELECT … FOR UPDATE`; already in target = no-op; moved by someone else = reload error; JSON columns merged onto the locked row; inline contact, audit and won side-effects in the same transaction; migration project guarded by the unique index, ADS won invoice by `source_key = won:<dealId>`. |
| H-12 | Fixed | `setR100Stage` delegates to `moveDealToStage` (optional gate fields / reason pass through). |
| H-13 | Fixed | `decide()` claims + applies in one transaction (handler modes `apply` / `applyWithClaim` / `applyAfter`); bulk overrides all-or-nothing with row locks; failures → status `failed` + reason; stage_gate "already there" = success; post-commit work never throws. |
| M-06 / QA-12 | Fixed in owned modules | `src/lib/time.ts`: date-only inputs stored at 17:00 in the user's zone (clamped to the same UTC date); deal next step / close date / renewal / payment / documents / tasks / gate dates; snooze presets and pickers in the profile zone. Commission periods stay UTC months (accepted, documented in `calc.ts`). |
| M-07 | Fixed (alerts side) | NS-23 counts calendar days in the org zone. |
| M-09 | Fixed | "N business days" keep the wall-clock time (`businessDaysPassed`). |
| M-20 | Fixed | List view: SQL filter/sort/pagination (100/page), SQL KPI totals (match the board exactly), URL-driven pager. |
| M-21 | Fixed | Analytics limiter is per request (React `cache()`), 3 in flight; the global pool cap lives in `src/db`. |
| M-23 | Fixed | One memoized directory load per transcript sync. |
| M-26 | Fixed | `(app)/error.tsx`, `global-error.tsx`, `not-found.tsx` (404 status, branded). |
| M-19 / §4 notify | Fixed | One `notify`/`notifyMany` (never throws; savepoint when given a tx); the deals-module notify and raw inserts in commissions, proposals, gmail, scout budget replaced. |
| M-18 (partial) | Improved | audit() takes a tx; stage-move inline contact and onboarding audit now inside their transactions. `createDeal` orphan account (QA-07) left to the UX/QA pass. |
| Others (M-01..M-05, M-08, M-11, M-13..M-17, M-22, M-24, M-25, M-27, M-28, L-*) | Deferred | Out of this pass's scope; unchanged. |

Remaining time-zone call sites for the UX pass (format with `formatInTz(d, user.timezone)` on the server, or pass the
zone / use `RelativeTime` on the client): `components/deals/record/{header-editors,side-panels,type-panels,timeline}.tsx`,
`components/deals/{deal-bits,board/deals-table}.tsx` (`fmtDate(… "d MMM")`), `components/r100/r100-table.tsx`,
`components/revenue/{invoices,billing}.tsx`, `components/onboarding/onboarding-view.tsx`,
`components/{accounts/accounts-list,contacts/contacts-list,admin/users-admin,scout/searches-table,tasks/notification-list}.tsx`
(`fmtRelative` → hydration mismatch, QA-15), `components/import/batch-table.tsx` and `app/(app)/import/history/[id]/page.tsx`
(machine-local time, QA-12), `components/inbox/*`, `app/(app)/{deals/[id],accounts/[id],contacts/[id],calls/*,proposals/*,revenue,scout/*}/page.tsx`.
Date-only parsers outside this pass: `revenue/actions.ts` and `onboarding/actions.ts` (`T12:00Z`), `commissions/actions.ts`
`assignPlan` (UTC midnight), `admin/users-actions.ts` `accessExpiresAt`, `admin/audit-queries.ts` filters — switch to
`parseUserDate(v, user.timezone)`.
