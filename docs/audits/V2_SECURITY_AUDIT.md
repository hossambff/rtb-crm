# V2 Security Audit — Roundtable Sales OS (rtb-crm)

- **Date:** 2026-10-01
- **Scope:** the V2 diff. That is the working tree against `HEAD` (93 modified files, about 120 new files and directories) plus the foundation in the last commit. The audit covers every new `"use server"` file (48 in total, all wrapped in `action()`) and every new route handler: `/share/[token]`, `/api/slack/{interactions,commands,config}`, `/api/cron/tick` and `/api/proposals/*`. It also covers the background jobs: the tick (sequences, meeting briefs, approval SLA, stories), the digests, Slack delivery and the alert engine's notify path.
- **Method:** I traced each code path end to end. Two read-only live checks were run against `http://localhost:3000`, both unauthenticated (no sign-in was needed). No files were changed and no data was written.
- **Evidence labels:**
  - **CODE:** an exact trace through the code.
  - **LIVE:** reproduced against the running dev server.
  - **UNCONFIRMED:** plausible, but not fully traced.
- **Count:** 0 Critical · 3 High · 8 Medium · 13 Low.

---

## High

### H-1 · The daily digest's "Bundled for you" section sends sensitive (MNPI) notification titles to Slack
**Evidence:** CODE

**Where:**
- `src/lib/notifications/notify.ts:116-126`: the `sensitive` flag is not stored on the row.
- `src/lib/notifications/digest.ts:64-77, 97-99`
- `src/lib/notifications/budget-core.ts:12, 45-61`

**How it happens:**
1. `notify()` honours `sensitive` only in memory (`notify.ts:139`). Rows that went over the user's alert budget are stored with `digestOnly = true`. The table has no `sensitive` column.
2. `sendDailyDigests` selects the last day's unread digest-only rows and copies their **titles** into "Bundled for you".
3. The digest is then sent with `notifyMany([u.id], { kind: "digest", …, href: "/home" })`, with no `sensitive` flag.
4. The `digest` kind is not budgeted, so `decideDelivery` returns `slack: true` (`budget-core.ts:48`).
5. `deliverToSlack` checks restriction only for `/deals/…` and `/accounts/…` hrefs. `/home` passes, so the body goes out as a Slack DM.

**Scenario:**
1. A rep owns a restricted deal. The alert engine raises "Idle past SLA: ‹Restricted deal›", or the autopilot raises "Call “‹Arena acquisition sync›” needs a review". Both are flagged `sensitive`.
2. The rep has already had 3 interrupting alerts today (the default budget), so the row becomes digest-only.
3. The next morning the digest DMs the restricted deal name to Slack.
4. Because `mnpiSafe` titles are neutral, the leak comes from every sensitive notification that keeps its real title: alert-engine alerts, autopilot, task assignment, meeting briefs and email commitments.

**Fix:**
- Add `notifications.sensitive boolean not null default false` (a schema change; ask the DB owner). Alternatively, store neutral text in the `title` of digest-only rows when `sensitive`.
- In `sendDailyDigests`, select `sensitive` and render those rows as "1 update about a restricted record". Or pass `sensitive: true` to the digest whenever any bundled row is sensitive.
- Add a unit test for `bundledSection` with sensitive rows.

### H-2 · Alert-engine notifications for migrations, invoices and registrations send restricted deal/account names to Slack
**Evidence:** CODE

**Where:**
- `src/lib/notifications/sensitive.ts:32-53`: `isSensitiveEntity`.
- `src/lib/alerts/engine.ts:975`: `notifyNew`.
- The rules: NS-19 `:519`, NS-20 `:534`, NS-23 `:607` and NS-16 `:463`.
- `src/lib/alerts/rules.ts:362-393`: `alertHref`.

**Cause:** `isSensitiveEntity` understands only `deal`, `account`, `proposal` and `task`. Every other entity returns `false`. It also returns `false` for any `entityId` with a suffix, because of the regex `^[0-9a-f-]{36}$`. Examples are invoice ids (`<id>#t7`) and interview ids (`<dealId>#iv:…`).

**Affected rules** (none of their hrefs is a `/deals/<id>` link, so the `hrefIsRestricted` backstop in `deliver.ts:48` never runs):

| Rule | Title | href |
|---|---|---|
| NS-19 / NS-20 (`entity: "migration"`) | "Migration stalled: ${p.name}" / "Go-live slipped: ${p.name}". The project name is the deal name (`onboarding/service.ts`, `name: row.deal.name`). | `/onboarding?project=…` |
| NS-23 (`entity: "invoice"`) | Contains the restricted deal name for the deal owner | `/revenue?invoice=…` |
| NS-16 (`entity: "lead_registration"`) | "Registration expiring: ${account}". There is no restricted check at all. | `/commissions?tab=registrations` |

**Result:** an automated Slack DM carries the restricted deal or account name to Slack, which is a third-party store, with no user action. NS-19/20 also show the name **in-app** to the onboarding owner, who may not be on the deal's access list.

**Fix:**
- Extend `isSensitiveEntity` to strip the `#…` suffix before validating, and resolve `migration` (→ `migrationProjects.dealId`), `invoice` (→ `invoices.dealId`), `lead_registration` (→ `accountId`), `meeting` (→ `dealId`/`accountId`) and `email_thread` (→ `dealId`/`accountId`).
- Make it fail closed (`true`) for unknown entities that carry an id.
- Use `dealLabel()`-style neutral titles in NS-16/19/20 for recipients who are not on the access list.
- Add a table-driven test that covers every `entity` emitted by `engine.ts`.

### H-3 · A shared sequence's owner (or an admin) can change what is sent from other reps' Gmail after they enrolled
**Evidence:** CODE

**Where:**
- `src/lib/sequences/actions.ts:79-105` (`saveSequence`) and `:40-63` (`createSequence` defaults `shared: true`).
- `src/lib/sequences/runner.ts:216-221, 517-521`: the steps are read live from `sequences.steps` at send time.

**Scenario:**
1. Rep B enrolls 80 of their contacts into Rep A's shared sequence. B's mailbox is the sender.
2. Days later A edits step 2: new body text, a link, or extra email steps. Only the claims guardrail runs, and it does not block links or arbitrary text.
3. The runner renders the **current** step and sends it from B's Gmail as B.
4. B is never shown or notified of the new content.

This breaks "the sequence runner sends only what a human enrolled". It is effectively sender spoofing between colleagues, whether malicious or simply careless.

**Fix:** pick one of the following:
- **(a) Snapshot.** Store the step content, or a hash plus version, in `sequence_enrollments` at enrollment time and send only that snapshot. Edits apply to new enrollments only, or after the sender accepts the new version.
- **(b) Pause and review.** When a sequence with active enrollments from other senders changes, pause those enrollments and notify each sender (shown on Today) to review and resume.

Also audit the diff of step content per sender.

---

## Medium

### M-1 · Delegating an alert (Today "Delegate", or `reassignAlert`) can hand restricted-deal alerts to people outside the access list
**Evidence:** CODE

**Where:** `src/lib/queue/actions.ts:88-90` → `src/lib/alerts/actions.ts:84-101`.

**Cause:**
- `queueDelegate` checks that the receiver can see a task's deal or account (`assertReceiverCanSee`, `queue/actions.ts:113`).
- For alerts it calls `reassignAlert`, which checks only `tasks.assign` scope and that the target is not banned or pending.
- The alert's `title` and `detail` are generated by the engine and include the deal name and figures. They become visible in the target's bell and Today queue.
- `sensitive` keeps it out of Slack, but the in-app disclosure to a non-member remains.

**Scenario:** a sales leader on the access list delegates "No next step: ‹Restricted deal›" to a team rep from Today. The rep now sees the name and detail.

**Fix:**
- In `reassignAlert`, resolve the alert's subject (deal, account, task, migration, invoice; reuse the H-2 resolver).
- Require the target to pass `dealAccessWhere(target, "view")`, built with `loadAppUserById(target)`.
- Otherwise refuse with "X can't see this deal".

### M-2 · `saveTask` can assign a task on a restricted deal to someone who isn't on its access list
**Evidence:** CODE

**Where:** `src/lib/tasks/actions.ts:79-85` (`assertCanAssign`) and `:48-77` (`assertRelatedVisible` checks the **actor** only).

**Cause:**
- The assignee is checked only for scope, ban and pending status.
- Task titles and descriptions are free text and usually name the deal ("Send ‹Restricted deal› the MSA").
- The assignee sees them in `/tasks` and Today. The deal name itself is filtered (M-3 fix), but the free text is not.
- The update path at `:107-116` has the same gap when the assignee changes or a `dealId` is added later.

**Fix:** after `assertCanAssign`, when `dealId` or `accountId` is set, reuse `assertReceiverCanSee(await loadAppUserById(assigneeId), values)` from `queue/actions.ts` (move it to a shared module). Apply it on both create and update.

### M-3 · Withdrawing a handoff on a deal whose **account** is restricted DMs the deal name to Slack
**Evidence:** CODE

**Where:** `src/lib/handoffs/service.ts:197`.

**Cause:**
- `mnpiSafe(ctx.deal.restricted, { title: "Handoff of ${ctx.deal.name} was withdrawn" }, …)` with `href: "/home"`.
- When only the account is restricted, `sensitive` stays false and the `/home` href defeats the `hrefIsRestricted` backstop. The title therefore reaches Slack.

**What else was checked** (the integrator's list of `mnpiSafe` callers that check only `deal.restricted`):
- All other callers use `/deals/<id>` hrefs, so Slack is protected by the backstop. Their in-app recipients are deal viewers, so this is defence in depth only (see L-1):
  - `comments/service.ts:103,105,131`
  - `handoffs/service.ts:119,176`
  - `help/service.ts:100-103,133-136`
  - `playbooks/service.ts:122`
- This line is the one that actually leaks.

**Fix:** have `mnpiSafe` callers pass `await isSensitive({ dealId })` instead of `deal.restricted`. That covers the account. Alternatively, link the withdrawal to `/deals/${id}`.

### M-4 · Slack member IDs are self-declared and never verified (misrouted DMs, identity confusion, denial of service)
**Evidence:** CODE

**Where:**
- `src/lib/prefs/actions.ts:22-38`: any user may store any `U…` ID.
- `src/lib/slack/identity.ts:19-29, 36-51`.
- There is no unique constraint on `user_prefs.slack_user_id`.

**Scenarios:**
- **(a) Misrouting.** A typo, or a deliberate entry of a colleague's ID, routes all of the user's Slack DMs to that colleague (`slackIdForUser` trusts prefs first). This includes deal names, comment bodies and approval cards for non-restricted records.
- **(b) Identity confusion.** If the colleague has not been auto-mapped yet, their Slack clicks and `/rtb` commands resolve to the **claimer's** app account (`appUserForSlack`, first branch).
- **(c) Denial of service.** Once both rows claim the same ID, `appUserForSlack` returns null for that Slack user. The colleague's Slack approvals and `/rtb` then stop working.

**Fix:**
- On save, verify the ID with `users.info`: the profile email must equal the user's app email (case-insensitive). Alternatively, send a one-time confirmation DM with a code.
- Refuse an ID already mapped to another user.
- Add a partial unique index on `slack_user_id`.

### M-5 · The sequence runner and the enroller bypass the shared session-equivalent user checks
**Evidence:** CODE

**Where:**
- `src/lib/sequences/runner.ts:146-160, 226-227`: the sender is built from the raw `user` row and checked only for `banned` and `pending`.
- `src/lib/sequences/enroll.ts:66-70`: same check for an admin-chosen sender.

**Cause:** these paths skip `loadAppUserById`, so they ignore `accessExpiresAt`, the domain allowlist and dev accounts in production.

**Scenario:** a contractor's access expires, or their email domain is removed from the allowlist. They can no longer sign in, but their active enrollments keep emailing prospects from their Gmail, and an admin can still pick them as a sender.

The runner also never re-checks:
- that the **enroller** is still active, or
- that the contact is still visible to the enroller. For example, if the account becomes restricted (MNPI) after enrollment, automated outreach continues.

**Fix:**
- In `RunContext.sender`, call `loadAppUserById(senderId)` (null → `pause`). Do the same in `enrollContacts`.
- Before each email step, check that the account and deal are not restricted. If they are, pause with "Restricted — review in Roundtable".

### M-6 · Restricted deal data is sent to the AI model in two V2 features, and V2 AI features skip `copilot.use_ai`
**Evidence:** CODE

The project convention is "MNPI never leaves the building": `deals/summary.ts:22`, `handoffs/service.ts:49`, `team/stories.ts:202` (the tick path), and `1:1` anonymizes. Two paths break it:
- **`draftStoryWithAi`** (`src/lib/team/actions.ts:77-84`) calls `aiStoryDraft(facts…)` without checking `facts.restricted`. That includes the deal name, account, champion, stage path and call objections of a restricted won or lost deal.
- **Meeting briefs** (`src/lib/briefs/meeting.ts:159-168`, `compose`) send the deal's next step, close date, health and last-call highlights to the model for restricted deals and accounts, for owners on the access list.

**Related:** none of the V2 AI entry points check `can(user, "copilot", "use_ai")`. This covers:
- `parseCapture` (`capture/actions.ts:48-51`)
- command AI parse (`commands/service.ts:31-35`)
- `draftStoryWithAi`
- openers (`scout/outreach.ts:179`)
- meeting briefs
- 1:1 AI

An admin override that removes `use_ai` from a role is therefore not honoured.

**Fix:**
- Return the heuristic when `facts.restricted` (stories) or when `deal` or `account` is restricted (meeting briefs, computed via `isSensitive`).
- Gate every AI call on `use_ai`. Background jobs should evaluate it for the owner.

### M-7 · The cross-motion CSV export includes deals whose **account** is restricted
**Evidence:** CODE

**Where:** `src/lib/commands/export.ts:33`. The V1 pipeline export (`deals/actions.ts:832`) has the same gap.

**Cause:** the export filters `eq(s.deals.restricted, false)` only. It exports the deal name, account name and domain, values and the next step of a non-restricted deal on a restricted account to a file that leaves the app. `ENGINEERING.md` rule 3 says restricted records are never exported, and other V2 surfaces treat `account.restricted` as MNPI (Slack commands, share links, digests, recap).

**Fix:** add `sql\`coalesce(${s.accounts.restricted}, false) = false\`` to the where clause in both exports. Count excluded rows in `excludedRestricted`.

### M-8 · A handoff of kind "reassign" bypasses the `assign` permission
**Evidence:** CODE

**Where:** `src/lib/handoffs/service.ts:103-121`, and acceptance at `:153-155`.

**Cause:**
- `createHandoff` requires only `edit` on the deal (`loadDealForWrite(…, "edit")`). The receiver list is "anyone who could own it".
- Acceptance writes `ownerId` and `teamId` directly.
- A role whose matrix gives `deals_*.assign = none/own` (where `canAssignTo` would refuse) can still move ownership to any eligible user, as long as that user clicks Accept. The deal's `teamId` also changes, which changes team visibility.

**Fix:** for `sdr_to_ae` and `reassign`, require `canAssignTo(user, pipelineKey, toUserId)` in `createHandoff`, or make it a matrix decision documented in `V2_SPEC.md`. Audit `teamId` in `deal.reassign`.

---

## Low

- **L-1 · `mnpiSafe` callers check only `deal.restricted`.**
  - **Where:** `src/lib/comments/service.ts:103,105,131`, `src/lib/handoffs/service.ts:119,176`, `src/lib/help/service.ts:102,135`, `src/lib/playbooks/service.ts:122`.
  - **Current exposure:** none, because every href is `/deals/<id>` (the Slack backstop in `deliver.ts:48-66` covers the account) and in-app recipients are the deal's audience. It breaks the moment someone changes an href (as in M-3).
  - **Fix:** use `isSensitive({ dealId })` in all of them (same fix as M-3).
- **L-2 · `deliverToSlack` does not re-validate non-approval recipients** (`src/lib/slack/deliver.ts:84-104`).
  - **Cause:** only `prefs.slackDm` is checked. Users whose access expired, or whose domain was removed, still get DMs with deal names and comment bodies if they remain in Slack. `buildDirectory` (`deals/audience-core.ts:38`) also keeps expired users mentionable and eligible as help or handoff targets.
  - **Fix:** call `appUserById(userId)` per recipient (null → skip). Filter `accessExpiresAt` in `buildDirectory`.
- **L-3 · Cached and past 1:1 briefs are not re-filtered** (`src/lib/briefs/one-on-one.ts:307-314, 352-359`).
  - **Cause:** the content stores restricted deal names and values as seen at generation time. A viewer later removed from an access list still sees them for the rest of the week and in every stored past week.
  - **Fix:** on read, re-filter `metrics` deal lists against `dealAccessWhere(viewer)` and hide names of rows no longer visible. Alternatively, store deal ids only and hydrate names on read.
- **L-4 · The proxy matcher excludes whole path prefixes** (`src/proxy.ts:22`).
  - **Cause:** `share`, `pending` and `sign-in` have no trailing `/`, so the optimistic auth gate skips any future route starting with those words. LIVE: `/shared-anything` → 404 without the sign-in redirect (`/deals` → 307).
  - **Fix:** use `share/|share$` style anchors, e.g. `(?!…|share(?:/|$)|pending(?:/|$)|sign-in(?:/|$)…)`.
- **L-5 · ⌘K `close` and `tag` commands ignore field-level-security overrides** (`src/lib/commands/execute.ts:99-146, 175-194`).
  - **Cause:** `runClose` and its undo write `expectedCloseDate` with no `hiddenDealFields` check, unlike signals (`signals/service.ts:211`) and capture (`capture/actions.ts:125`). This matters only if an admin hides `expectedCloseDate` or `tags` for a role.
  - **Fix:** check `getHiddenFields(user.role, "deal")` in `buildPreview` and `runClose`.
- **L-6 · Proposal templates pass non-text parts through untouched** (`src/lib/proposals/docx/package.ts:131-146`).
  - **Cause:** this covers `word/_rels/*.rels` with `TargetMode="External"` (remote `attachedTemplate`, external images that leak NTLM or IP when opened), `word/embeddings/*`, ActiveX and `altChunk`. Upload is admin-only, but generated term sheets go to partners.
  - **Fix:** reject packages with external relationships or embedded objects at `createTemplate`.
- **L-7 · Deal-comment mirroring to Slack** (`src/lib/slack/deliver.ts:116-145`).
  - **Cause:** the full comment body goes to the pipeline channel, whose members may not have deal scope (team or own). Edits and soft-deletes are never propagated, so a deleted comment stays in Slack.
  - **Fix:** document the channel-membership requirement, and call `chat.update`/`chat.delete` on edit and delete (`comments/service.ts:122-140`).
- **L-8 · Autopilot follow-up draft recipients come from transcript participants** (`src/lib/transcripts/drafts.ts:25-31`).
  - **Cause:** participants are untrusted, and recipients are not checked against CRM contacts (unlike QA-13 for Copilot `draft_email`). The draft is never sent, but it is pre-addressed in the rep's Gmail.
  - **Fix:** keep only addresses that match visible contacts or meeting attendees, and mark the others "unverified".
- **L-9 · Handoff AI prompt passes activity subjects unwrapped** (`src/lib/handoffs/service.ts:59`).
  - **Cause:** `${a.subject}` is raw. Email subjects are external text (the prior audit's M-11 wrapped subjects elsewhere).
  - **Fix:** wrap it with `untrustedField("subject", a.subject, 200)`.
- **L-10 · Meeting-brief attendee lookup ignores contact visibility** (`src/lib/briefs/meeting.ts:102-110`).
  - **Cause:** names, titles and "last touch" of contacts on any account, including restricted accounts, are shown to the meeting owner.
  - **Fix:** add `contactVisibilityWhere(owner)`.
- **L-11 · Team-feed visibility ignores later account restriction** (`src/lib/team/queries.ts:22-33`).
  - **Cause:** a non-restricted post stays visible to everyone (with the deal name) after the deal's **account** becomes restricted. Only `deals.restricted` is re-checked.
  - **Fix:** add the account check to `postVisibleWhere`, mirroring `postTeamPostToSlack`.
- **L-12 · Share-link hardening** (`src/lib/share/*`, `src/app/share/[token]/page.tsx`).
  - The rate limiter is in-memory per instance and trusts the first `x-forwarded-for` hop (fine on Vercel, spoofable behind other proxies).
  - The "N items are no longer available" count tells a partner that something was withdrawn or restricted.
  - The `nextStep` free text is shared verbatim (no MNPI or claims scan).
  - The link is resolved with the creator's **view** scope although creation required **edit**.
  - LIVE (dev): the response carried `Cache-Control: no-cache, must-revalidate`, not the configured `private, no-store`. Next dev overrides it. **UNCONFIRMED** for a production build; verify with `next build && next start`.
  - **Fix:** run `scanMnpi` on the shared `nextStep`, and resolve with `"edit"` for consistency.
- **L-13 · Admins can send sequences from any user's mailbox without that user's consent** (`src/lib/sequences/enroll.ts:64-65`, `queries.ts:239-247`).
  - **Cause:** this is by design but it is impersonation-grade. It is audited, but the sender is not notified.
  - **Fix:** notify the sender on enrollment, and let them pause or stop it (this already works via `manageableEnrollments`). Consider requiring the sender's opt-in.

---

## Verified OK

**Public share links (`/share/[token]`)**
- Tokens are 32 random bytes in base64url. Only `sha256(token)` is stored. Malformed tokens never reach the DB.
- Revoked, expired and inactive-creator links all return the same response.
- Restricted and deleted deals and accounts are dropped at render time, along with the creator's hidden fields.
- The projection is built from an allow-list with no internal ids. The page is server-only (no client props), uses `noindex` and `no-referrer`, and preview bots get no data.
- Creation needs `edit`, refuses restricted deal or account, and is blocked while impersonating. Revoke is creator or admin only.

**Slack inbound and outbound**
- Size cap (64 KB). v0 HMAC over the raw body, constant-time, ±5 minutes. Replay guard.
- Nothing is parsed before verification. Unconfigured → 404. Workspace `team_id` must match the stored id.
- `response_url` is restricted to `hooks.slack.com`. Restricted approvals can't be decided from Slack and get neutral cards.
- Decisions go through `decide()`, so permissions and separation of duties are re-checked. `/rtb` answers are ephemeral and exclude restricted deals and accounts, with field-level security applied.
- Tokens and secrets are AES-GCM encrypted. Only masks are returned or audited. Secrets travel through a same-origin route handler, not a server action. The client is never logged.

**Cron, proposals and downloads**
- `/api/cron/tick` uses the constant-time bearer `CRON_SECRET` check and fails closed.
- `/api/proposals/*`:
  - Upload is admin-only and same-origin (`Origin` required), with a 2 MB cap and the magic number checked.
  - Zip entries: count, names (no `..`, absolute paths or control characters), declared size and a streamed decompression cap.
  - `vbaProject.bin` and macro content types are rejected.
  - The XML parser rejects `DOCTYPE`/`ENTITY` and caps depth and node count. Substitutions are escaped.
  - Downloads are access-checked through `proposalWhere`, blocked while approval is pending, and carry an ASCII-safe `Content-Disposition` with `no-store`.

**Server actions**
- Every V2 `"use server"` export is `action()`-wrapped.
- `runQueueAction` dispatch uses own-property lookup only, over a fixed module map, with string-only payloads, and each handler re-checks permissions.
- Command tokens: per-user HMAC, kind-bound, 15-minute TTL. Execute can only narrow the previewed id set. Every write goes through the bulk actions or SQL `dealAccessWhere(edit)`. The 500 cap is enforced.
- Saved views and preferences are strictly per user. Forecast confirm checks `edit` per deal. Review sessions are facilitator-only, and the recap excludes restricted deal and account names.
- Handoffs:
  - Accept is receiver-only and re-checks ownership eligibility, under a row lock.
  - The read-only brief view is gated on a pending handoff and on access-list membership for restricted deals.
- Help requests are target-only to respond and requester-only to cancel. Targets come from the deal audience.
- Comments are view-gated. Mentions are limited to the deal audience, and edits and deletes are author-only.
- Signals apply/dismiss require `edit` and run through the gated stage-move service.
- Capture applies only what the user explicitly confirms, with field-level security on `nextStep`, `muu` and close date.
- Templates and playbooks admin actions and pages require admin.

**Background jobs and automation**
- `loadAppUserById` denies banned, expired, disallowed-domain and production dev accounts, as well as pending users (unless `allowPending`).
- It is used by autopilot, meeting briefs, approval SLA, Slack identity, share links, forecast pregeneration and delegate. Sequences are the exception (M-5).
- Post-call autopilot:
  - Gmail drafts only, never sends. Downgrades on injection-like transcripts.
  - Checks claims and MNPI before Gmail. Stage moves are suggestions only. Undo is owner-only within 24 hours.
- Inbound-email next steps stay suggestions. Openers are wrapped as untrusted, sanitized and human-approved per contact.
- The sequence runner re-checks do-not-contact, suppression, reply, bounce and unsubscribe live, runs the claims guardrail per send, and is idempotent per step.

**Other MNPI checks**
- Approvals, alert reassignment and escalation notifications carry `sensitive`. Slack approval cards are neutral for restricted subjects.
- The channel digest excludes restricted deals and accounts. Team posts and stories inherit `restricted` (deal or account) and are re-checked before Slack.
- The 1:1 AI prompt anonymizes restricted deals.

**Secrets**
- No secrets reach client bundles (client components import only server actions and types).
- Errors returned to users are generic, with a reference id. SQL parameters are stripped in logs.
