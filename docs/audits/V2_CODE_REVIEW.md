# V2 code review: correctness, data integrity, concurrency, performance

Date: 1 Oct 2026. Scope: the uncommitted V2 working tree (91 modified files plus the new V2 modules listed by `git status`).
The review was read-only. No source files or data were changed. SQL was SELECT/EXPLAIN only, run inside `BEGIN READ ONLY`
transactions through `scripts/_db.ts`. HTTP checks were one request at a time against the lead's dev server on :3000, signed in
as the seeded `dev.exec@` and `dev.sdr@` accounts.

**Summary:** 0 Critical, 4 High, 9 Medium, 16 Low. Checks pass: `vitest` 73 files and 796 tests, `tsc --noEmit` clean,
`eslint src --max-warnings=0` clean.

Every finding below was confirmed by reading the code path end to end, unless it is marked **(unconfirmed)**.

---

## How the numbers were measured

The dev machine reaches the eu-west-1 Supabase transaction pooler with a **round trip of 86–92 ms** (median of 10 `select 1`).
Production runs in `dub1`, which is in the same region, so its round trip is about 1–2 ms. Local page timings are therefore
dominated by round trips. For pages, the query count matters more than wall time here.

Query counts come from the change in `pg_stat_database.xact_commit + xact_rollback` around a single curl. Every autocommit
statement counts as one transaction. Other agents share the database, so each count below is the **floor** of several runs.

| Page (warm, exec unless noted) | Local total | DB transactions per request (floor) |
|---|---|---|
| `/home` (Today queue) | 2.3–3.9 s | ~42 (exec), ~42 (sdr) |
| `/pipelines` | 1.9–2.6 s | ~28 |
| `/deals` (3,117 open deals, paginated) | 2.7 s | ~29 |
| `/forecast` (exec defaults to the company view; writes this week's entries) | 2.0–3.6 s | ~25 |
| `/deals/[id]` | **5.9–6.5 s** | **128–134 (stable across runs)** |
| `/review`, `/sequences`, `/team` | 2.2 s, 1.5 s, 1.4 s | n/a |

Data volumes: deals 3,261 (3,117 open), accounts 8,696, contacts 3,652, audit_log 359. The V2 tables are nearly empty
(meetings 0, tasks 2, sequence_enrollments 0, forecast_entries 2, briefs 5, queue_snoozes 0). As a result, V2 query plans at
production scale can't be observed. Indexes were reviewed against the queries instead (see M7, L5, L7, L8).

**/pipelines "hung for 60 s+":** I could not reproduce it (1.9–2.6 s, about 28 queries). `pipelineOverview` makes one light
scan of about 3.2k deal rows. Nothing about it is slow. The symptom (two stalls of about 30 s each, then success or
ECONNRESET) matches the QA-01 pipelining failure. That failure is caused by the **duplicate limiter instances** that
`src/db/index.ts` now prevents with `globalThis.__rsoLimited`. Conclusion: it was the limiter bug, not a slow query.

**Review exception pre-filter** (`EXPLAIN ANALYZE`, exec scope): 148 candidates out of 3,117 open deals, **5.1 ms**. It
seq-scans deals, which is fine at this size. The audit sub-plan uses `audit_entity_idx` on `entity` only (see L7).

---

## High

### H1. A Gmail send can be duplicated by the HTTP retry inside `googleFetch`, which bypasses the intent ledger
- `src/lib/integrations/google.ts:56-79`: `googleFetch` retries **every** request on 429, 5xx or `rateLimitExceeded`, up
  to 3 times. That includes `POST`.
- `src/lib/gmail/client.ts:40-46`: `sendMessage` POSTs to `/messages/send` through `googleFetch` with the default retries.
- `src/lib/sequences/runner.ts:565-580`: the runner calls it once, but the retries happen inside it.
- **Failure scenario:** Gmail accepts and delivers the message, then returns `500 backendError` or `503` (Google documents
  `backendError` as retryable and this happens in practice). `googleFetch` sleeps 500 ms and POSTs the same raw message
  again. The recipient gets the same email two to four times. Gmail only collapses identical Message-IDs inside Gmail
  mailboxes, so other providers show every copy. The intent ledger (`reserveSend`, `findSentMessage`) never runs, because
  the duplication happens inside a single "attempt". The same applies to `createDraft` (`client.ts:52`), which produces
  duplicate drafts.
- **Fix:** give `googleFetch` a `retries` argument and pass `0` for every non-idempotent call (`messages/send`,
  `drafts`, `messages/modify` if used). For example, `sendMessage(token, raw, threadId)` →
  `googleFetch(..., init, 0)`. Let the runner's existing path handle ambiguous failures: `recordFailure`, then on the next
  attempt `findSentMessage` reconciles first. Treat a fetch `TimeoutError` the same way (it is already not retried).

### H2. Restricted (MNPI) titles reach Slack through the daily digest's "Bundled for you" section
- `src/lib/notifications/notify.ts:115-141`: `sensitive` is only used to skip Slack for **that** row. It is not
  persisted. Budgeted kinds (`alert`, `system`) go over budget into `digestOnly` rows regardless of sensitivity.
- `src/lib/notifications/digest.ts:64-77, 97-99`: the digest selects the unread `digestOnly` titles from the last 24 h,
  puts them in the digest body, and calls `notifyMany(..., { kind: "digest" })` **without** `sensitive`.
  `decideDelivery` treats `digest` as a people kind, so the row is DM'd via `deliverToSlack`.
- `src/lib/slack/deliver.ts:99-103`: the href is `/home`, so `hrefIsRestricted` is false. `noticeMessage`
  (`src/lib/slack/blocks.ts:41`) posts the title **plus the first 600 characters of the body**.
- **Failure scenario:** a rep with Slack DMs on gets a fourth "system" notification today: "Brief ready: TheStreet in
  30 min" (`src/lib/briefs/meeting.ts:244-250`, built from a restricted account's name with `sensitive: true`). The same
  happens with the autopilot summary that names the deal (`src/lib/transcripts/autopilot.ts:148`) or "X assigned you
  <restricted deal>" (`src/lib/deals/actions.ts:293`). The row becomes digest-only. At 12:00 UTC the digest body lists the
  title and it is relayed to Slack. This violates V2 §0.4 ("Restricted deals never appear in Slack … digests").
- **Fix (no schema change):** record sensitivity on the row, e.g. `deliveredVia: ["sensitive"]` (or a schema request
  for `notifications.sensitive boolean`). Then in the digest either exclude sensitive rows from the bundled titles (show
  "N updates about restricted records") or pass `sensitive: true` to the digest `notifyMany` whenever any bundled row is
  sensitive. Add a unit test on `composeDailyDigest` and bundling.

### H3. Editing a live sequence's steps shifts every active enrollment, which can re-send earlier emails or skip steps
- `src/lib/sequences/actions.ts:79-104`: `saveSequence` overwrites `sequences.steps` with no check for active or paused
  enrollments.
- `src/lib/sequences/runner.ts:221-223` reads `steps[row.currentStep]` by **index**. The intent ledger is keyed by step
  index too (`core.ts:290 intentFor`).
- **Failure scenario:** an enrollment has sent step 0 and `currentStep = 1`. The owner inserts a new first step (e.g. a
  LinkedIn touch) or reorders steps. On the next run, index 1 is the **old step 0** (the intro email). It is rendered as an
  in-thread "Re:" follow-up and sent to a prospect who already got it. Deleting a middle step silently skips the step
  after it. If a pending intent exists for that index, `findSentMessage`'s fallback ("any mail to this person since the
  intent") can also mark the new step as sent.
- **Fix:** snapshot the steps per enrollment, either in `sequence_enrollments.variables`/`history` or as a
  `steps_version` (schema request: `sequences.version` plus `sequence_enrollments.steps jsonb` copied at enroll time).
  Minimum fix: refuse structural edits (insert, delete, reorder, kind change before the furthest `currentStep`) while
  active or paused enrollments exist, and allow text-only edits and appends at the end.

### H4. The deal page runs about 130 queries per view (the reported figure was about 25)
- Measured: 128–134 DB transactions per `/deals/[id]` render, stable across three runs. Locally that is about 6 s; at the
  production round trip it is roughly 100–250 ms at low concurrency. With `DB_POOL_MAX=5` per instance, though, 10
  concurrent deal views queue about 1,300 queries through 5 connections.
- Drivers (confirmed in code):
  - `dealAccessWhere` (`src/lib/rbac/server.ts:180-182`) runs `select … from pipelines` on **every call**, uncached. Each
    slot calls it again: forecast badge → `buildForecast` (two calls, `forecast/service.ts:140-141, 476`); signals panel
    → `getAccessibleDeal`; sequences panel (`components/sequences/deal-sequences.tsx:25`); share, proposals, collisions,
    discussion and transcripts each repeat the access check.
  - `generateMetadata`, the layout (`deals/[id]/layout.tsx`) and the page each load and authorize the deal.
    `getDealForUser` is cached, but `getDealDetail`, `pendingHandoffReview` and per-slot loads are not.
  - `DealForecastBadge` runs the full forecast pipeline (deal query, history, signals) for one deal.
- **Fix:**
  1. In `dealAccessWhere`, use the already-cached `getAllPipelines()` instead of querying pipelines, and wrap
     `dealAccessWhere`/`getAccessibleDeal` in React `cache()` keyed by `(user.id, action)` and `(user.id, dealId, action)`.
     The returned `SQL` is safe to reuse.
  2. Pass the already-authorized deal row (id, restricted, ownerId, pipelineKey, hidden fields) from the page to the
     slots, and let slots skip re-authorization when given it.
  3. Give `DealForecastBadge` a lightweight single-deal path that reads this week's `forecast_entries` row and computes
     the suggestion only when it is missing.
  - Target: under 40 queries.

---

## Medium

### M1. Accepting a handoff can override an owner change made after the handoff was created
- `src/lib/handoffs/service.ts:143-155`: the deal is read outside the transaction with no `deleted_at` filter. Inside the
  transaction only the **handoff** row is locked. `deals.owner_id` is set to the receiver unconditionally.
- **Failure scenario:** Alice creates an SDR→AE handoff to Bob. A manager then bulk-reassigns the deal to Carol. Bob
  accepts the stale handoff and becomes the owner, silently undoing the manager's decision. The audit `before.ownerId`
  is also stale (it records Alice). A deal soft-deleted in the meantime still gets its owner changed.
- **Fix:** inside the transaction, `select … from deals where id = $1 and deleted_at is null for update`. If the owner no
  longer equals `h.fromUserId` (for `sdr_to_ae` and `reassign`), throw `UserError("The deal changed hands since this
  handoff was sent — ask the sender to resend it.")` and mark the handoff `cancelled`. Use the locked row's owner for the
  audit `before`.

### M2. Command undo overwrites later human edits, and undo tokens can be replayed
- `src/lib/commands/execute.ts:160-201`: undo blindly restores the previous stage (via `bulkMoveStage` from wherever the
  deal is now), the previous owner, or the previous close date. `token.ts:21-42` tokens are stateless and valid for
  15 minutes, so they can be used repeatedly.
- **Failure scenario:** a leader moves 40 deals to Nurture. A rep then advances one of them to Proposal. Ten minutes
  later the leader clicks Undo, and the rep's deal is pulled back to its old stage. For close dates
  (`execute.ts:184-194`), a date a rep set after the command is overwritten. A second Undo click, or replaying the token,
  repeats the revert after the user re-applied the change.
- **Fix:** make undo conditional on the record still being in the state the command left it in. For move: only deals
  whose `stage_id` = the command's target. For assign: `owner_id = p.ownerId`. For close: `expected_close_date = at`.
  Report the rest as "changed since — skipped". Make undo single-use by storing a nonce, e.g. an `audit_log` row
  `command.undo` keyed by the token hash, checked inside a `withXactLock`.

### M3. The "close date" and "tag" commands bypass field-level security and skip deal bookkeeping
- `src/lib/commands/execute.ts:99-146` writes `deals.expected_close_date` and `deals.tags` straight to SQL. There is no
  `getHiddenFields` check, unlike `applySignal`, which checks `ctx.hidden.has("expectedCloseDate")` at
  `signals/service.ts:211`. There is also no activity row and no `recomputeDealHealth`.
- **Failure scenario:** a role with `expectedCloseDate` hidden but with edit scope types "set close date to Dec 31 for my
  NET deals" and changes a field it can't see. Health and forecast inputs go stale until something else recomputes them.
- **Fix:** in `buildPreview` and `runClose`/`runTag`, refuse (or mark as skipped) when `hiddenDealFields(user.role)` has
  the field or `*`. After writing, log one `field_change` activity per deal and recompute health in a bounded loop, or
  enqueue the recompute in `after()`.

### M4. Bulk commands run up to 500 sequential stage moves with no time budget
- `execute.ts:51-65` → `bulkMoveStage` (`src/lib/deals/actions.ts:75-99`) runs one `performStageMove` per deal,
  sequentially. Each move costs about 20–25 queries: `loadDealForWrite` 3, `stageById` 1, the transaction with BEGIN /
  lock / update / history / activity / audit / COMMIT about 8, the playbook 1–5, and health about 6.
- **Failure scenario:** 500 records means about 10–12k round trips. At 1.5 ms that is about 15–20 s in production
  (about 15 min on a dev machine). Under load, or with approval-gated stages, the server action can hit `maxDuration`.
  The client then gets an error, the moves already made stay committed, **no undo token is returned**, and the audit row
  for `command.execute` is never written.
- **Fix:** process in chunks with a deadline, e.g. 100 per action call with the client looping and showing progress.
  Alternatively return early with `{ changed, remaining, undoToken }` and let the client continue. Write the
  `command.execute` audit before the loop and update it after. Cache `dealAccessWhere`/pipelines per call (see H4).

### M5. The alert budget treats people-driven notifications as "system noise"
- `src/lib/notifications/budget-core.ts:12` budgets `kind: "system"`. Many person-to-person notifications use that kind:
  handoff requests (`handoffs/service.ts:119`), handoff withdrawn (`:197`), "assigned you N deals"
  (`deals/actions.ts:124, 293, 345`), "New task: …" (`:536`) and help withdrawn (`help/service.ts:148`).
- **Failure scenario:** after three meeting-brief or autopilot notices in a day, "Chris is handing you TheStreet" is
  stored `digestOnly`. It never reaches the bell count or Slack. This contradicts the module's own contract ("people-driven
  kinds … are never budgeted — somebody is waiting on them").
- **Fix:** give those call sites a people kind (`task`, or a new `handoff`/`assignment` kind added to the
  `NotificationKind` union), or add `budgeted?: boolean` to `NotifyInput` and default it to false for these calls. Add a
  test.

### M6. "Done" on a Today reply row hides that email thread permanently
- `src/lib/queue/actions.ts:54-62` stores `queue_snoozes(itemKey = "thread:<id>", until = null)`. Reply rows are keyed
  per thread (`src/lib/queue/index.ts:231`).
- **Failure scenario:** a rep marks "Reply: Contract questions" as done. Two days later the customer writes again and
  the thread is `awaitingReplyFrom = 'us'` again, but the key is the same, so it never comes back to Today. The same
  happens to alerts merged into a hidden thread row.
- **Fix:** key reply rows by the last inbound message (`thread:<id>@<lastMessageAt epoch>`), or store
  `until = thread.lastMessageAt` and treat a dismissal as void when `lastMessageAt > snooze.createdAt`. Also prune
  dismissals older than 90 days.

### M7. The meeting-brief tick can be starved by meetings that never get a brief
- `src/lib/briefs/meeting.ts:209-228`: each tick selects the 25 soonest meetings in the next 45 minutes that have no
  delivered brief. Internal-only meetings (`gather` returns null), owners with `autopilot.meetingBriefs === false`, and
  owners `loadAppUserById` can't load all `continue` **without recording anything**, so they are re-selected on every
  tick.
- **Failure scenario:** at 10:00 there are 25 or more internal stand-ups across the team (one row per owner and event).
  They fill the LIMIT on every tick, so the external call at 10:30 never gets its brief or notification. Each skip also
  costs an `internalDomains` query. There is no `meetings(starts_at)` index, so every tick seq-scans `meetings`, which
  grows without bound.
- **Fix:** upsert a `briefs` marker row with `deliveredAt = now()` and content `{ skipped: "internal" | "off" }` for
  skipped meetings, or filter them in SQL. Add `index on meetings (starts_at) where cardinality(attendees) > 0` (schema
  request).

### M8. A transient token-refresh failure pauses all of a rep's sequences
- `src/lib/integrations/google.ts:33-39` turns **any** error from `auth.api.getAccessToken`, including network or Google
  5xx during refresh, into `IntegrationAuthError("Google access expired or was revoked")`.
- `runner.ts:491-497` then calls `pause()`. The token promise is cached per tick (`RunContext.token`), so **every**
  enrollment of that sender in the tick is paused.
- **Failure scenario:** a 2-second Google OAuth blip pauses 40 enrollments. The rep must notice the alert and resume
  them by hand.
- **Fix:** rethrow `IntegrationAuthError` only for `invalid_grant` / revoked or missing refresh tokens (inspect the
  better-auth error). Otherwise throw a transient error that `recordFailure` turns into backoff. Also don't cache a
  rejected token promise in `RunContext`.

### M9. Applying a "stage" signal dead-ends on the next-step gate, and a partial success is rolled back
- `src/lib/signals/service.ts:201-208` calls `moveDealToStage` with no gate fields. Since B5, every open stage requires
  `nextStep` and `nextStepDueAt` (`src/lib/deals/gates.ts:41-47`). The Today and panel Apply buttons have no gate dialog.
- **Failure scenario:** an "advance" signal on a deal without a next step fails with "Proposal requires: Next step, Next
  step due" on every click. The user can only dismiss it or go to the deal.
- Separately, `:251-254` calls `release()` (back to pending) on **any** error, including one thrown after the move or the
  close-date update already committed (for example the final `audit`). The signal then stays actionable for a change
  that already happened.
- **Fix:** when a gate would fail, return `{ message, href: "/deals/<id>?move=<stageId>" }` so the queue opens the
  stage-move dialog prefilled from the playbook hint. Wrap only the mutation in the try/release, and run audit and
  bookkeeping after it in their own try/log.

---

## Low

- **L1. `after()` callbacks inherit the "in transaction" flag (latent).** Next 16's `AfterContext` binds callbacks with
  `AsyncLocalStorage.bind` (`node_modules/next/dist/server/after/after-context.js:111`), which snapshots **all** async
  stores. Any `after()` or `notify()`→`scheduleSlack` registered inside a `db.transaction` callback runs later with
  `inTransaction=true`. Its `db` queries then bypass the limiter (`src/db/index.ts:73-76`), which can bring back QA-01
  pipelining under load and logs false H-03 warnings. No current V2 call site does this. Fix: in `scheduleSlack` and
  other `after()` wrappers, run the callback via `inTransaction.exit(...)`; export a `outsideTransaction(fn)` helper from
  `src/db`.
- **L2. Deal-page slots have no time bound, and `Slot` swallows framework interrupts.**
  `src/app/(app)/deals/[id]/page.tsx:457-465` catches everything, including `notFound()`, `redirect()` and
  `forbidden()` thrown by a slot, and logs them as errors. Nothing bounds a slot that hangs. The ">90 s streaming" report
  most likely came from the limiter bug (pool stalls), since no slot does network I/O **(unconfirmed)**. Fix: rethrow
  `isRedirectError`/`isNotFoundError`-style digests, and race each slot against a 5 s timeout that renders `null`.
- **L3. `prepareDayBriefs` ignores the sync deadline.** `src/lib/calendar/sync.ts:100` → `briefs/meeting.ts:266-292`
  runs up to 8 sequential AI calls per user (20 s fast-tier cap each) inside `runScheduledSync(started + 240_000)`. The
  budget isn't passed through, so later users' mailboxes can miss the cron window. Fix: pass the deadline and stop early.
- **L4. Post-call autopilot undo compares only the next-step text.** `src/lib/transcripts/autopilot.ts:176-185`
  restores both the text and **the due date** when the text is unchanged. A rep who moved only the due date loses that
  edit. It also cancels auto tasks the rep has since reassigned. Fix: compare text **and** due date. Skip tasks whose
  assignee or title changed.
- **L5. Playbook and sequence task idempotency is read-then-insert, and the lookups are unindexed.**
  `src/lib/playbooks/service.ts:85-119` has no lock and no unique constraint, so two concurrent entries (creation plus an
  immediate move, or two tabs) can duplicate the checklist. `runner.ts:436` and `manage.ts:80` look up
  `tasks.evidence_source` with no index (a seq scan per task step per tick). Fix: wrap in
  `withXactLock("rso.playbook:<deal>:<stage>")`. Schema request:
  `index on tasks (evidence_source) where evidence_source is not null`.
- **L6. The single-pending-handoff rule is check-then-insert.** `handoffs/service.ts:111-116`: a double submit can create
  two pending handoffs. Schema request: `unique index on handoffs (deal_id) where status = 'pending'`, and map the
  violation to the existing UserError.
- **L7. Review audit look-ups scale with total deal audit rows.** The `candidateWhere` EXISTS uses `audit_entity_idx`
  on `entity='deal'` only and filters `created_at` afterwards (EXPLAIN above). `recentDealAudits`
  (`review/queries.ts:104-118`) does `order by created_at asc limit 5000` per 500-deal chunk, so on a busy week it drops
  the **newest** rows, which are the most relevant pushes. Fix: index `(entity, entity_id, created_at)` and order `desc`,
  or drop the limit.
- **L8. Runner exit checks scan more than needed.** `runner.ts:295-306` runs `unnest(meetings.attendees)` across all
  meetings created or starting after enrollment (seq scan per enrollment per run). `reserveSend` (`:593-597`) expands
  **all** history of all of a sender's enrollments under the mailbox lock. Fix: a GIN index on `meetings.attendees` or
  restricting to `owner_id = sender`. Count today's sends from `activities`/`audit_log`, or keep `sequence_enrollments`
  history bounded.
- **L9. Viewing the forecast rewrites rows daily.** `forecast/core.ts` reasons include "No activity for N days", so
  `buildForecast(..., { persist: true })` (`service.ts:331-339, 381-399`) rewrites most entries on the first view of each
  day, inside a GET render. `MAX_DEALS = 6000` truncates with no `ORDER BY`. Fix: compare `suggested_category` and
  values only, not reason text. Order by `deals.id` and surface truncation.
- **L10. Hydration risks.** `src/components/slack/slack-admin.tsx:226` uses `toLocaleString()` with no locale or zone.
  `src/components/help/request-help.tsx:150` calls `isOverdue(r, new Date())` during render. Fix: format on the server
  with the user's zone, or pass `nowIso` in from the server.
- **L11. Digest window and snooze growth.** The bundled section covers `now - 24 h`, but the digest cron time drifts, so
  items near the boundary repeat or are missed. Use "since the previous digest row for this user". `queue_snoozes`
  dismissals are never pruned.
- **L12. Docx coverage gaps (no corruption found).** Only `document`, `header*` and `footer*` parts are processed
  (`docx/package.ts:33`), so placeholders in footnotes, endnotes or comments stay unfilled. Positional rules don't apply
  to `mc:Fallback` copies of shape text (`ooxml.ts:16,60`), so legacy renderers keep blanks. CDATA inside `<w:t>` is
  dropped by `ownText`/`setOwnText`; Word doesn't emit it. Fix: add `footnotes|endnotes` to `TEXT_PART_RE`, and map
  fallback ordinals to their primary paragraph.
- **L13. Tick delivery (unconfirmed).** The pg_cron / pg_net schedule isn't in the repo, so the `net.http_post` timeout
  (pg_net's default is a few seconds) can't be checked. If the caller hangs up, the work still runs, but failures are
  invisible. Fix: check the schedule SQL into `docs/` or `drizzle/`, set `timeout_milliseconds` ≥ 300000, or answer
  `202` and run `runTick` in `after()`.
- **L14. Retrying a failed enrollment can hit the unique index.** `manage.ts` "retry"/"resume" set `status='active'`. If
  the contact was re-enrolled in the same sequence meanwhile, `seq_enroll_active_uq` raises and the user sees the generic
  "Something went wrong (Ref …)". Fix: catch the unique violation and throw a UserError.
- **L15. Reconcile and exit heuristics are conservative in ways the user should know about.** `findSentMessage`
  (`sequences/gmail.ts:71-72`) marks a step as sent if **any** mail went to the contact after the intent, e.g. a manual
  email. `checkThread` (`:84-94`) treats out-of-office auto-replies as replies. Both are documented trade-offs. Fix:
  surface "reconciled as sent" in the enrollment history UI, and ignore `Auto-Submitted`/OOO headers.
- **L16. `listApprovals` is N+1 on the Today hot path.** `src/lib/approvals/service.ts:185-210` calls `canDecide` per
  pending row (up to 300) plus `h.label` per row. The code predates V2, but it now runs on every approver's My Day. Fix:
  batch the labels by entity, and filter by `approver_role` in SQL first.

---

## Verified OK

- **Sequence claiming:** `claimDue` (`runner.ts:112-131`) is a single `UPDATE … WHERE id IN (SELECT … FOR UPDATE OF e
  SKIP LOCKED)` statement, so it is atomic in its implicit transaction behind the transaction pooler. The 10-minute lease
  is longer than the 240 s tick budget. Unprocessed rows are handed back at the deadline (`:84-91`). Guarded updates
  (`status='active'`, `current_step = stepIdx`) make overlapping ticks harmless.
- **Double-send ledger (apart from H1):** `reserveSend` writes a conditional `email_intent` entry under
  `pg_advisory_xact_lock` (transaction-scoped, safe behind the pooler) together with the cap count. A crash between the
  intent and the bookkeeping reconciles through `findSentMessage` **before** any resend. Gmail errors during
  reconciliation fall back to `recordFailure` and never send. Sends happen after the lock's transaction commits; no
  network call is made inside a transaction.
- **Tick hygiene:** every job catches its own errors and is bounded (sequences limit 50 plus deadline, briefs 25, SLA 25
  with a 60 s budget, stories 10 with 3 AI calls). Delivery is exactly once via claims: `briefs.delivered_at`,
  `approvals.escalated_at`, the `briefs_uq` story prompts, and the Slack digest `digestLastDate` claim. Business-day and
  window math runs in the sender's zone (`core.ts:218-250`, unit tested).
- **Pooler rules:** no session-level `SET`, session advisory locks, or prepared statements (`prepare: false`;
  `withXactLock` only). Every V2 transaction body uses `tx` for every query: `deals/enrich.ts:74`,
  `review/actions.ts:195`, `team/actions.ts:56`, `proposals/term-sheet-actions.ts:61,171`, `templates.ts:115`,
  `template-actions.ts:124`, `handoffs/service.ts:146`. No Gmail, Slack or AI call happens inside a transaction; Slack
  posts run after commit via `after()`. Fan-out is bounded: `allLimited(…, 3)` on the deal page and waves in
  `loadToday`; the limiter caps the rest.
- **Stage moves:** signals (`via: "signal"`), review (`"review"`) and commands (`"bulk"`) all go through
  `performStageMove`. That covers gates (now including the next step for open stages), approval-gated stages, a row lock
  and stale-move check, history, activity, won side effects, audit, post-commit health, and a playbook step that never
  throws.
- **Proposal versioning:** the unique `(deal_id, kind, version)` index plus one retry on that exact constraint, then a
  UserError (`versioning-core.ts`).
- **Forecast:** the upsert never touches `category`, `note` or `confirmed_*`. Carried decisions use the latest
  confirmation, including ones older than 14 weeks. `weekOf` is computed in the **owner's** zone by both `buildForecast`
  and `confirmForecastEntries`. Quarter keys are stable because `dateOnlyToInstant` clamps to the same UTC day.
  Persisting is idempotent.
- **Docx core:** DOCTYPE and ENTITY declarations are rejected (no XXE or entity expansion). Only predefined and numeric
  entities are allowed. Values are escaped and stripped of invalid XML characters. Split-run tokens are written into the
  first run without rebuilding paragraphs. Deleted revisions and field codes are skipped. The output is re-opened and
  every text part re-parsed before it is returned. Zip-bomb caps apply per part, in total and on declared size. Tests use
  a synthetic document.
- **Saved views:** there is no redirect loop. Only an empty query redirects, stored params are sanitized to non-empty
  values, and `listHref` adds `page=1` for "no filters".
- **Next 16:** no `redirect()`, `notFound()` or `forbidden()` inside try/catch (scripted scan). No server module imports
  non-component exports from a `"use client"` module (scripted scan; `deal-tab-keys.ts` split confirmed).
  `authInterrupts` is enabled for `forbidden()`.
- **Alert budget day boundary:** the code fetches 26 h of rows and then filters by the user's local day start
  (`notify.ts:57-92`). Critical notifications always interrupt.
- **Queue:** `rankQueue` is stable and deduplicates keys. Snooze presets are tested. Providers never throw and have a
  2.5 s timeout each.
- **Review:** the decision append is atomic (`jsonb ||`). Outcomes go through existing actions, and recap posting is
  serialized by a transaction-scoped advisory lock.
- **Approvals SLA:** due dates are backfilled for pending rows, and escalation happens once.

---

## Schema requests implied by the fixes
- `notifications.sensitive boolean not null default false` (H2), or encode it in `delivered_via`.
- `sequences.version int` plus `sequence_enrollments.steps jsonb` snapshot (H3), or block structural edits instead.
- `index tasks (evidence_source) where evidence_source is not null` (L5).
- `unique index handoffs (deal_id) where status = 'pending'` (L6).
- `index meetings (starts_at)` (M7) and a GIN index on `meetings (attendees)` (L8).
- `index audit_log (entity, entity_id, created_at)` (L7).
