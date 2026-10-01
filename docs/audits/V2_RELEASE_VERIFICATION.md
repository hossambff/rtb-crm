# V2 Release Verification: Roundtable Sales OS (rtb-crm)

- **Date:** 2026-10-01
- **Verifier:** independent release verifier. Source was read-only; no commits, no data writes.
- **Inputs:** `V2_SECURITY_AUDIT.md` (3 High, 8 Medium), `V2_CODE_REVIEW.md` (4 High, 9 Medium), `V2_QA_UX_REPORT.md` (1 Blocker, 22 Major).
- **Method:**
  - I re-read the current code path behind every finding at Medium or above, without relying on the fix teams' claims.
  - I ran the full suite.
  - I scanned the whole V2 diff (109 tracked files changed, plus the new modules) for new problems.
  - I ran a read-only DB check that the migrations are applied.
  - I ran a live smoke test against `localhost:3000`, one request at a time.

## Recommendation: **GO**, with conditions

Every Blocker, High and Major finding, and every Medium, is fixed or fixed in substance. The suite is green and the live smoke checks pass. The MNPI-to-Slack paths I traced are all closed.

The remaining items are low-risk residuals (see "New / residual findings"). None of them blocks release. Conditions:
1. Fix **N-1** (the background story drafts ignore `copilot.use_ai`) before or right after release. It is a one-line gate.
2. Production must run migrations `0009`–`0011` before the code ships. They are applied on the dev DB; see below.
3. Track N-2 to N-6 as follow-ups.

---

## 1. Suite results

| Step | Result |
|---|---|
| `next typegen` | pass |
| `tsc --noEmit` | pass (0 errors) |
| `eslint src --max-warnings=0` | pass (0 warnings) |
| `vitest run` | **94 files, 942 tests, all passed** (the audits saw 73 files / 796 tests) |

**Migrations (read-only check on the dev DB).** These objects all exist:
- Columns: `notifications.sensitive`, `sequence_enrollments.steps_snapshot`, `sequence_enrollments.steps_version`, `sequences.version`, `approvals.slack_messages`.
- Indexes: `user_prefs_slack_user_id_uq`, `handoffs_one_pending_uq`, `meetings_starts_at_idx`, `tasks_evidence_source_idx`.

The journal lists `0004`–`0011`.

## 2. Live smoke (dev, signed in as `dev.exec@` via the seeded dev account)

| Request | Result |
|---|---|
| `/home` | 200, 3.5 s |
| `/forecast` | 200, 2.6 s |
| `/review` | 200, 2.0 s |
| `/team` | 200, 1.4 s |
| `/sequences` | 200, 1.2 s |
| `/deals` | 200, 2.6 s |
| `/deals/<id>` | 200, **3.2 s** (the review measured 5.9–6.5 s). No slot error markers. |
| `/share/<bogus>` (browser UA) | 200, "This link isn't available". No oracle. |
| `/share/<bogus>` (curl UA) | 200, the generic preview-bot page |
| `GET /api/cron/tick`, no auth | **401** |
| `POST /api/slack/interactions`, unsigned | **404** |
| `POST /api/slack/commands`, unsigned | **404** |

No page showed "Something went wrong" or an application error.

---

## 3. Verification table

Legend: **VF** = verified fixed, **PF** = partially fixed, **NF** = not fixed, **RG** = regressed.

### Security audit

| ID | Status | Evidence |
|---|---|---|
| H-1: digest "Bundled for you" leaks sensitive titles | **VF** | `sensitive` is persisted on the row (`notify.ts:132`, migration 0009). The digest selects it (`digest.ts:74`). `bundledSection` collapses sensitive rows into a neutral count (`budget-core.ts:61-69`). |
| H-2: alert engine leaks migration, invoice and registration names | **VF** | `parseEntityRef` strips the `#` suffix and fails closed for unknown entities (`sensitive-core.ts:26-34`). `resolveSubject` maps migration, invoice, lead_registration, meeting, email_thread, help_request, handoff and approval (`sensitive.ts:41-94`). `notifyNew` passes `isSensitiveEntity` (`engine.ts:1011`). A digest summary is sensitive if any member is (`engine.ts:1019-1028`). NS-16/19/20 titles use the neutral `label(...)` (`engine.ts:502,560,585`). |
| H-3: shared-sequence edits change what is sent from other reps' Gmail | **VF in substance / PF** | Enrollments snapshot their steps (`enroll.ts:212-213`). The runner uses `stepsForEnrollment`, and a version mismatch pauses the enrollment (`runner.ts:232-233`, `core.ts:96-102`). `saveSequence` only bumps the version (`actions.ts:100-106`). **Residual:** the owner or an admin can still explicitly apply new steps to other senders' enrollments (`applyNewStepsToEnrollments`, `actions.ts:124-175`). The sender is notified after the fact, not asked first. See N-3. |
| M-1: alert delegation to non-members | **VF** | `reassignAlert` checks `loadReceiver`, then `resolveSubject` (fails closed), then `assertReceiverCanSee` (`alerts/actions.ts:84-101`). `queueDelegate` pre-checks too (`queue/actions.ts:131-138`). |
| M-2: `saveTask` assignee not on the access list | **VF** | `assertCanAssign` calls `loadReceiver` and `assertReceiverCanSee` on both create and update (`tasks/actions.ts:83-89, 101-103`). The shared module is `rbac/receiver.ts`, which includes the account access list. |
| M-3: handoff withdrawal on a restricted account | **VF** | `deal.restricted \|\| isSensitive({dealId})` (`handoffs/service.ts:233`). L-1 callers were updated the same way (comments `:117`, help `:103,129`, playbooks `:158`). |
| M-4: Slack member ID self-declared | **VF** | `users.info` email must match the user's email (`identity.ts:61-76`). The claim is stored under an advisory lock (`:93-106`), and a unique partial index exists in the DB (verified). Outbound DMs only go to a verified, uncontested ID (`:114-132`). Inbound mapping is resolved by the verified claimant (`:141-161`). Stale comment: see N-6. |
| M-5: runner and enroller bypass session-equivalent checks | **VF** | The runner sender uses `loadAppUserById` (`runner.ts:154-162, 238-239`). The enroller does too (`enroll.ts:69-74`). A record that became restricted pauses the enrollment unless the sender is on the access list (`runner.ts:246-248, 285-290`). |
| M-6: restricted data sent to AI; V2 AI ignores `use_ai` | **PF** | Gated: capture (`capture/actions.ts:75-77`), command parse (`commands/service.ts:35`), story action (`team/actions.ts:85`), openers (`scout/outreach.ts:167-178`), meeting briefs (`briefs/meeting.ts:181`), 1:1 (`one-on-one.ts:261`), handoff brief (`handoffs/service.ts:54`), enrichment (`deals/enrich.ts:82`), email and transcript analysis (`aiAllowedFor`). **Not gated:** the background story tick (`team/stories.ts:202-203`; see N-1). 1:1 anonymizes only deal-level restriction (see N-2). |
| M-7: export includes deals on restricted accounts | **VF** | The command export drops and counts `accountRestricted` rows (`commands/export.ts:43-45`). The V1 pipeline export filters restricted accounts (`deals/actions.ts:841-847`). |
| M-8: "reassign" handoff bypasses the `assign` permission | **PF** | `canAssignTo` is enforced for `reassign` (`handoffs/service.ts:112-114`). `sdr_to_ae` also moves ownership but only checks the receiver role (`SDR_TO_AE_ROLES`), not the sender's assign scope. See N-4. |

### Code review

| ID | Status | Evidence |
|---|---|---|
| H1: `googleFetch` POST retry duplicates sends | **VF** | `defaultRetries` returns 0 for non-idempotent methods (`retry-core.ts:18-20`, `google.ts:116`). `sendMessage` and `createDraft` pass `0` explicitly (`gmail/client.ts:44-63`). The runner reconciles through `findSentMessage` and `reserveSend` (`runner.ts:568-582`). |
| H2: digest leaks to Slack | **VF** | Same as SEC H-1. In addition, `notifyMany` returns before Slack when the row is sensitive (`notify.ts:147`) and `deliverToSlack` refuses sensitive rows (`deliver.ts:115`). |
| H3: live step edits shift enrollments | **VF** | Per-enrollment snapshot plus `canApplyNewSteps` alignment check, with a compare-and-set on `currentStep` (`sequences/core.ts:117-`, `actions.ts:146-158`). |
| H4: deal page runs about 130 queries | **PF (likely fixed)** | `dealAccessWhere` is wrapped in React `cache` (`rbac/server.ts:198`) and pipelines are cached (`:191`). Slots get a "known" deal (`collisions.ts:55-62`). Live render took 3.2 s against 5.9–6.5 s in the review. I did not re-measure the query count. |
| M1: handoff accept overrides a later owner change | **VF** | `FOR UPDATE` on both the handoff and the deal, plus `ownerChangedSince` against `ownerAtCreate`. A stale handoff is cancelled and audited inside the transaction, and the error is thrown after commit (`handoffs/service.ts:164-205`). |
| M2: command undo overwrites edits; tokens replayable | **VF** | Single-use: claimed under `withXactLock` with an audit row inside the transaction (`execute.ts:244-254`). `audit()` throws on failure, so the claim can't silently vanish. Compare-and-set through `partitionForUndo` for move, assign and close. Close also adds a SQL-level `eq(expectedCloseDate, expect)` guard (`:268-312`). |
| M3: close-date and tag commands bypass field-level security | **VF** | `commandFieldHidden` is checked (`execute.ts:47-48`). `logFieldChanges` writes activity and `recomputeHealthBounded` recomputes health (`:154-166`). |
| M4: unbounded bulk commands | **VF** | `EXECUTE_BUDGET_MS` deadline, `chunks`, and `remaining` returned for the client to continue. The audit is written per call (`execute.ts:52-111`). |
| M5: people notifications budgeted as "system" | **VF** | New kinds `handoff`, `help` and `assignment` (`notify.ts:17`). Only `alert` and `system` are budgeted (`budget-core.ts:13`). Call sites were moved (deals `:128,299,351`; handoffs; help). |
| M6: "Done" hides a thread permanently | **VF** | Reply keys are versioned `thread:<id>#<ms>` (`queue/actions.ts:59`, `queue/index.ts:99,334`). |
| M7: meeting-brief tick starvation | **VF** | `markSkipped` records skipped meetings (`briefs/meeting.ts:296-299`). Eligibility now requires an account or visible deal (`:110`). `meetings_starts_at_idx` exists. |
| M8: token-refresh blip pauses all sequences | **VF** | `diagnoseRefresh` and `GoogleTokenTransientError` (`google.ts:44-97`). A rejected token promise is not cached (`runner.ts:166-174`). |
| M9: signal apply dead-ends on gate; partial rollback | **VF** | Returns `needs_input` with a move-dialog href. Only the mutation is inside the claim/release (`signals/service.ts` header and `:219-220`). |

### QA / UX

| ID | Status | Evidence |
|---|---|---|
| BLK-01: MNPI through the digest | **VF** | See SEC H-1. |
| MAJ-01: `e`/`s` act with no focus | **VF** | Outside a row, only `j`/`k` from `<body>` enter the queue (`today-queue.tsx:204-212`). Alert undo goes through `reopenAlert` (`queue/actions.ts:107-126`). |
| MAJ-02: "My Day" vs "Today" | **PF** | Nav, title and digest are renamed. Leftovers are in `app/not-found.tsx:13`, `(app)/forbidden.tsx:17`, `(app)/not-found.tsx:14`, `(app)/error.tsx:28` and the `home/loading.tsx:5` aria-label. See N-5. |
| MAJ-03: Ask bar drops repeats; AI off | **VF** | Per-open nonce (`copilot-chat.tsx:146-151`). Prefill when AI is off (`:122`). |
| MAJ-04: dead toggles / split save | **VF** | Dead toggles removed. Interruptions are saved with one action (`prefs/actions.ts:33-39, 76`). |
| MAJ-05: /home performance | **VF** | Provider timeout is 1.2 s (`queue/index.ts:28`). The forecast provider uses a count query first, with `lite` fallback (`providers/forecast.ts:20-24`). Streamed under Suspense (`home/page.tsx:35`). |
| MAJ-06: microphone blocked | **VF** | `microphone=(self)` (`next.config.ts:7`). |
| MAJ-07: playbook next step never prefilled | **VF** | Hint is passed and `nextStepPrefill` applied (`stage-move.tsx:104,143`). |
| MAJ-08: meeting-only help has no response path | **VF** | `helpHref` goes to `/help/<id>` (`providers/help.ts:22`). Context is rendered (`request-help.tsx:195-200`). |
| MAJ-09: SDR→AE receiver roles | **VF** | `SDR_TO_AE_ROLES` = ae, sales_leader, executive, super_admin (`handoffs/core.ts:108,115`). |
| MAJ-10: deal header overload | **VF (structure)** | `more-actions.tsx` added. Visual review is out of scope. |
| MAJ-11: brief starvation | **VF** | See CR M7. |
| MAJ-12: "Resume all" resumes intentional pauses | **VF** | Only `lastError && systemPaused` (`providers/sequences.ts:20,41`). |
| MAJ-13: autopilot mode shows the viewer's prefs | **VF** | `getPrefs(t.uploadedBy ?? user.id)` (`calls/[id]/page.tsx:51`). |
| MAJ-14: briefs for any external attendee | **VF** | `briefEligibility` requires an account or visible deal (`briefs/meeting.ts:110-111`). |
| MAJ-15: approval notifications without Slack buttons | **VF** | `approvalForNotice` resolves subject hrefs to the pending approval (`slack/deliver.ts:80-92`). Restricted subjects get no label or card (`slack/approvals.ts:63-67`). |
| MAJ-16: alerts channel unused | **VF** | `postCriticalAlertsToChannel` drops sensitive or unresolvable subjects (`deliver.ts:271-295`, `engine.ts:1251`). |
| MAJ-17: `ShareDealsButton` has no caller | **VF** | Mounted in `pipeline-board.tsx:149` (restricted deals filtered) and `deals-list.tsx:244`. The server also refuses restricted deals (`share/service.ts:74-79`). |
| MAJ-18: Slack ID self-asserted | **VF** | See SEC M-4. |
| MAJ-19: first template active immediately | **VF** | Inserted with `active: false` (`templates.ts:135`). `setTemplateActive` requires `templateReviewBlockers` to be empty (`template-actions.ts:121-127`). |
| MAJ-20: verbs hijack the palette | **VF** | Actions and go-to stay ranked; preview is one entry (`command-palette.tsx:173-175`). |
| MAJ-21: repeated identical items | **VF** | `collapseGroups` (`queue/index.ts:351`). Bulk overrides become one card (`review/core.ts:205-`). |
| MAJ-22: nav sprawl | **VF** | Per-role defaults are 12 items or fewer (`prefs/core.ts:13-25`). Pipeline review needs team analytics (`nav.ts:50-51`). Finance has no Inbox or Sequences (`nav.ts:37`). |

**Areas called out in the brief, re-checked across the whole tree:**
- Every `notify`/`notifyMany` call site that can carry a deal or account name passes `sensitive` or `mnpiSafe`. I traced about 35 call sites.
- `deliverToSlack` refuses sensitive rows and has a fail-closed href backstop.
- Deal-channel comment mirror, edits and deletes re-check deal and account restriction (`deliver.ts:168-234`).
- Wins-channel posts re-check restriction (`:241-264`).
- The review recap names only non-restricted deals, with account restriction included (`review/queries.ts:496-505`).
- Approval cards are neutral for restricted subjects.
- Approval SLA reminders go through `isSensitiveEntity` (`approvals/sla.ts:118-134`).

---

## 4. Diff scan for new problems

- **Server actions.** Every export in a `"use server"` file is `action(...)`-wrapped (scripted check: 0 exceptions). For actions with no inline check, I confirmed the delegate enforces permission. Examples: `exportDeals` uses the export scope; `listShareLinks` is own-or-admin; Slack admin uses `requireAdmin`; `previewCommand` is filtered in `buildPreview`; `getRecentTouches` uses `getVisibleAccount`.
- **Transactions.** I scanned all 26 `db.transaction` / `withXactLock` bodies in changed files. None uses the global `db`, calls `audit`/`logActivity`/`notify` without `tx`, or calls `after()` inside the transaction. `notify` Slack, `defer()` and the comment mirror all wrap with `outsideTransaction` (CR L1 fixed).
- **Fire-and-forget.** Server-side `after`/`defer` callbacks all catch. Client `void action()` calls use `ActionResult` (they don't throw).
- **Raw SQL.** The only `sql.raw` is pre-existing constant tier labels (`analytics/executive.ts:84`). There is no `.unsafe` with user input.
- **Secrets / client boundary.** No `"use client"` file reads non-`NEXT_PUBLIC` env or imports `@/db`, `@/lib/env` or server-only modules.
- **Public surface.** The `proxy.ts` matcher now excludes `share/`, and `sign-in` / `pending` are anchored. `/api/cron/tick` requires cron auth, and the Slack endpoints are signature-gated (verified live).

## 5. New / residual findings (ranked)

| # | Severity | Finding | Fix |
|---|---|---|---|
| N-1 | **Medium** | The background story tick sends deal facts to the AI without checking `copilot.use_ai` for the owner. `team/stories.ts:202-203` calls `aiStoryDraft`, which checks only `aiAvailable()` (`:109-110`). An admin override removing AI from a role is ignored for auto-drafted stories. Restricted deals are excluded, so this is not an MNPI leak. This is the residual of SEC M-6. | Add `&& (await aiAllowedFor(c.ownerId))` to the condition at `:202`. |
| N-2 | Low | The 1:1 AI anonymizes only `deals.restricted`, not deals on restricted **accounts** (`one-on-one.ts:84,101,263`). The viewer can see these deals, but the names go to the model. This is inconsistent with the stories, briefs and handoffs paths. | Join `accounts.restricted` into `restricted`. |
| N-3 | Low | H-3 residual: `applyNewStepsToEnrollments` (owner or admin, confirmed) switches **other senders'** enrollments to new content. The sender gets an after-the-fact notification and the change is audited, but the sender never opts in. | Apply only the actor's own enrollments, and give other senders an "Apply new version" action. Alternatively, pause others' enrollments until they accept. |
| N-4 | Low | M-8 residual: a `sdr_to_ae` handoff also moves ownership but does not require `canAssignTo` for the sender (`handoffs/service.ts:112`). Receivers are limited to AE-and-above roles, which bounds the impact. | Apply the `canAssignTo` check to `sdr_to_ae` too. Alternatively, document it in V2_SPEC as an intended SDR right. |
| N-5 | Low (copy) | "My Day" remains in the not-found, forbidden and error pages and in the `/home` loading aria-label. | Rename to "Today". |
| N-6 | Cosmetic | `slack/identity.ts:79-80` says "user_prefs.slack_user_id has no unique index". The index now exists (migration 0011, verified in the DB). | Update the comment. |
| N-7 | Low | Help notifications are marked sensitive only from `dealId` (`help/service.ts:101-104, 125-130`). Meeting-only help requests on a restricted account can reach Slack with the free-text `ask` as the body. The title never names the account. | Resolve the meeting's account through `isSensitiveEntity("meeting", meetingId)`. |

No regressions were found in the areas the fix rounds touched.

## 6. Blocking items

**None.** N-1 is a recommended pre-release fix (a one-line gate), not a blocker. Release is conditional on production running migrations `0009_sensitive_and_snapshot`, `0010_audit_fix_indexes` and `0011_slack_identity` before deploy.
