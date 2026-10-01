# Roundtable Sales OS V2: QA and UX audit against `docs/V2_SPEC.md`

**Date:** 1 Oct 2026
**Auditor:** independent QA lead / product design (read-only)
**Scope:** all 30 V2 features (A1–A10, B1–B10, C1–C10) plus the Coalition term sheet generator.

**Inputs**
- `docs/V2_SPEC.md`
- `docs/ENGINEERING.md` §UI rules
- `docs/PRD.md` §16A

**Method**
- **Code tracing:** every acceptance point was traced from route to component to action to service, with file:line evidence.
- **Live checks:** run against the dev server on `:3000`, one request at a time.
  - 7 dev roles, signed in with `POST /api/auth/sign-in/email`.
  - 26 routes per role, about 190 requests in total.
- **Design and UX review:** done by reading the components.
- **No changes made:** no source edits, no data writes, no commits.
- **Not done: 375 px screenshots.** These needed a signed-in session in a browser, and that step was not permitted. Mobile findings below come from reading the code.

Unless noted, paths are relative to `src/`.

---

## 0. Summary

| | Count |
|---|---|
| Features **Met** | **14** |
| Features **Partial** | **17** (one acceptance point inside C6 is Broken) |
| Features **Missing** | 0 |
| Features **Broken** (whole feature) | 0 |
| Findings: **Blocker** | **1** |
| Findings: **Major** | **22** |
| Findings: **Minor** | 41 |
| Findings: **Polish** | 18 |

**Overall:** V2 is broadly built. Every feature is reachable by the intended roles, and the server enforces permissions. The design system is respected almost everywhere:
- no `shadow-*`,
- no transitions over 200 ms (two deliberate 600 ms "delight" animations aside),
- no coloured Tailwind palette classes.

The real risks are these:
1. **One MNPI leak path to Slack** through the daily digest (Blocker).
2. **Noise.** The product's promise is "less on screen", but in practice:
   - nav runs to 20–22 items for AEs, leaders and execs;
   - the Today queue shows 9 identical "Unassigned high-value lead" rows for the SVP;
   - pipeline review is flooded by 147 identical "override pending" deals;
   - the deal page header carries about 12 actions plus 7–9 stage chevrons.
3. **Several "looks done, doesn't work" paths:**
   - capture dictation is blocked by our own `Permissions-Policy`;
   - the B5 next-step prompt never opens;
   - meeting-only help requests can't be answered;
   - "Share from a filtered list" isn't mounted;
   - Slack Approve/Reject buttons appear for only 2 of 6 approval kinds.

---

## 1. Traceability matrix

**Status key:**
- **Met:** every acceptance point is implemented and reachable.
- **Partial:** at least one point is missing or weak.
- **Broken:** implemented, but it does not work.

### WS-A: Today and simplicity

| Feature | Status | Evidence | Gaps |
|---|---|---|---|
| **B1 Today queue** | Partial | `app/(app)/home/page.tsx:47-83` renders only the AskBar, Checklist, TodayQueue, GlanceStats and meetings, so the old sections are gone. Sources: `lib/queue/index.ts:208-277`. `rankQueue` is pure and tested: `lib/queue/core.ts:27-52`, `__tests__/core.test.ts`. ≤10 + "Show N more": `components/home/today-queue.tsx:38,107,340`. Snooze 1 h / 9 am tomorrow (user tz) / Monday: `core.ts:55-60`. Delegate is limited to tasks and alerts. Empty state: `today-queue.tsx:438-459`. | (a) `e`/`s` act when focus is on `<body>` (`today-queue.tsx:191`); see MAJ-01. (b) The provider timeout is 2.5 s (`index.ts:25`), so the <500 ms target can't be guaranteed. Live TTFB on `/home` was 0.75–1.67 s and total time 2.4–3.3 s in dev. (c) Approvers come from a hard-coded role list (`index.ts:26`). (d) Identical items are not grouped (MAJ-21). |
| **B2 Role-shaped nav** | Met | `lib/rbac/nav-server.ts:24-32` (navHidden). Short nav for sdr, intern and commission_rep: `lib/prefs/core.ts:6-7`. "More" disclosure: `shell/sidebar.tsx:17-72`. Settings show/hide: `settings/preferences-section.tsx:129-139`. `pipelineKeys` on the overview: `pipelines/(overview)/page.tsx:17-38`. | `/deals` Motion filter doesn't lead with "motions I sell" (`deals/list/deals-list.tsx:171`). Nav is still long for non-short roles (MAJ-22). |
| **B3 Alert budget** | Partial | `notifications/budget-core.ts:45-53` (tested); `notify.ts:50-168` (digestOnly; critical always interrupts; Slack via `after()`). Bell excludes digestOnly: `notifications/queries.ts:36-41`. "Bundled for you": `digest.ts:64-97`. | **BLK-01:** the digest copies restricted alert titles into a non-sensitive notification that is DMed on Slack. `deliveredVia` never records "digest". |
| **B7 Copilot front door** | Partial | `home/ask-bar.tsx`. ⌘J: `shell/copilot-launcher.tsx:24-32`. 3 data-driven suggestions: `queue/core.ts:91-109` (tested). | Asked as auto-send, not prefill. The same question asked twice in a tab is silently dropped (`copilot/copilot-chat.tsx:145-152`). With AI off, the text is lost (MAJ-03). |
| **B8 Smart defaults and saved views** | Met | `lib/views/core.ts:65-70`, `queries.ts:31-53`, `actions.ts:17-29`. `SavedViewsMenu` is on /deals (`deals-list.tsx:221`), /accounts, /contacts and pipeline board/list. Live: sdr, intern and commission_rep get `307 → /deals?owner=me` and `/contacts?owner=me`. | /pipelines/NET "Mine" is applied with a client-side soft redirect (HTTP 200 + `NEXT_REDIRECT`), not a 307, so the page loads twice. |
| **B9 First-run checklist** | Partial | `lib/prefs/checklist-core.ts:24-80`; `onboarding-checklist/checklist-card.tsx` (progress ring, dismiss). Restore is in Settings. | "Claim your imported deals" is missing. "Set alert budget" is ticked by *any* Preferences save (`prefs/actions.ts:41`). The Slack step shows when Slack isn't configured (dead end). `markChecklistStep` is unused. Live: the checklist is also rendered inside /settings, a duplicate. |
| **B10 Plain language** | Partial | `lib/glossary.ts:7-58` (all required terms); `ui/term.tsx`. | `<Term>` is used in only 6 places, all WS-A. Not used on Forecast (commit/best/pipeline), Pipelines cards (MUU, RTB net, Weighted), Review (NET/ENT chips) or deal value cells. No other team imports it. |
| *Settings → Preferences* | Met | `settings/preferences-section.tsx:96-221`: motions, nav, budget 1–10 (default 3), post-call off/review/auto-draft, briefs, signals, forecast, Slack DM + member ID. | Duplicate group headings for screen readers ("Sidebar Sidebar", "Autopilot Autopilot": sr-only `<legend>` + visible `<h3>`, `:56-58`). Two "Save preferences" buttons on two cards. Dead toggles (MAJ-04). Slack member ID is self-asserted (MAJ-18). |

### WS-B: Deal workspace

| Feature | Status | Evidence | Gaps |
|---|---|---|---|
| **B4 Four-field create** | Partial | `deals/create-deal-dialog.tsx:160-235` (4 fields + More details). Account search or new-by-domain: `:332-442`. MUU vs $ by motion: `:201-215`. +3 business days: `lib/deals/create-core.ts:16-19`. Enrichment: `lib/deals/enrich.ts:21-90`. Undo: `actions.ts:610-637`. | "auto" markers appear only in the Details tab (5th). The priority tag in the header has none. The toast lists bare values with no field names. Submit is disabled with no explanation. A domain match links an account the caller can't see (`actions.ts:206-219`). |
| **B5 One required next step** | Partial | Enforced server-side on create (`actions.ts:162`) and on every stage move (`gates.ts:42-48` → `stage-service.ts:130-135`). Kanban card: next step, overdue red, "No next step" (`kanban.tsx:299-303`, `deal-bits.tsx:69-103`). | **The move-dialog prompt is dead** (MAJ-07): the playbook-prefilled next step never shows. No list-level banner; the per-deal banner only. The Home KPI links to an unfiltered `/pipelines`. A next step with no due date shows no warning. |
| **B6 Summary-first page** | Partial | Header, stage path, value, health, owner, AI 3-line summary (`summary-card.tsx:41`), next step, stakeholder avatars: `deals/[id]/page.tsx:125-245`. Tabs exactly as specified: `deal-tab-keys.ts:2`. Slots: forecast in header `:136`, share `:162`, sequences in Contacts `:302`. Mobile order: `:180-188`. | The signals panel renders below the collision notice, handoff banner and help list, not directly under the summary (`:261-265`). The forecast badge sits inside the `<h1>`. All 6 tabs `forceMount`: every panel's queries run on each view (live: deal page **5.4–7.1 s** total in dev, the slowest route). Header overload: MAJ-10. |
| **A7 Stage playbooks** | Met | `admin/playbooks/page.tsx`, `admin/playbooks-editor.tsx`, `lib/playbooks/service.ts:74-127` (idempotent, `origin: rule`, `evidenceSource playbook:<stageId>`), `stage-service.ts:258-260` post-commit. Guidance on deal page: `page.tsx:267-283`. `scripts/seed-playbooks.ts`. Live: `/admin/playbooks` is 200 for admin, 403 for everyone else. | Check-then-insert race (no unique index). Email templates are listed by name but can't be used. Guidance is collapsed by default. |
| **C2 Deal threads** | Met | `lib/comments/service.ts:20-141`, `deals/discussion.tsx:133-292`, `audience.ts:69-89`. | `void mirrorCommentToSlack` (not `after()`) can be cut off on serverless. `window.confirm` on delete. |
| **C3 Structured handoffs** | Partial | `lib/handoffs/service.ts:33-196`, `core.ts:13-91`, `handoff-dialog.tsx`, `handoff-banner.tsx`, `queue/providers/handoffs.ts:61-96`. | "SDR → AE" accepts any non-viewer role, including another SDR, an intern or a commission rep (MAJ-09). Manager escalation is computed at read time and is never notified or audited. Two pending handoffs are possible (race). |
| **C4 Collision warnings** | Met | `lib/deals/collisions.ts:38-187`. Shown on deal (`page.tsx:254`), account (`accounts/[id]/page.tsx:118,265` "Who's talking to them"), contact (`contacts/[id]/page.tsx:75`) and composer (`inbox/email-composer.tsx:65,216`). | `note` activities count as "touching the publisher" (`collisions-core.ts:22`), which produces false collisions. |
| **C6 Executive help** | Partial (one point Broken) | `components/help/request-help.tsx`, `lib/help/service.ts:35-139`, `queue/providers/help.ts:21-56`. Entry from deal, `/calls` and the brief page. | **Broken:** help asked from a meeting with no deal links to `/home` and can't be declined or answered (MAJ-08). `context` is stored but never shown to the target. "Mark done" from Today needs no response. "Request help" shows on closed deals. |

### WS-C: Autopilot

| Feature | Status | Evidence | Gaps |
|---|---|---|---|
| **A1 Zero-touch post-call** | Met | `lib/transcripts/autopilot.ts`, `autopilot-core.ts:22-63`. `gmail.compose` in `auth/index.ts:20`. Reconnect fallback: `gmail/drafts.ts:69-79`. 24 h undo. "Apply all + draft": `calls/apply-review.tsx:86-126,352`. Guardrail: `drafts-core.ts:16-23`. Never sends. | The call page reads the **viewer's** autopilot mode, not the owner's (`calls/[id]/page.tsx:52,152`), MAJ-13. Zero recipients means the draft silently stays in-app while the notification says "drafted". Undo leaves the Gmail draft in place. No tests for `evaluateDraftGuard`. |
| **A4 Signals** | Met | `lib/signals/core.ts` (phrase library, tested). Unique index `schema.ts:1471`. Apply via `moveDealToStage` (gated): `service.ts:193-262`. Panel and provider. Respects `emailSignals`. | Apply button label is truncated with no `title`. |
| **A5 Auto meeting briefs** | Partial | `lib/briefs/meeting.ts:60-266`, `tick/index.ts:32`, `/calls/briefs/[meetingId]`. Live: bogus id → soft 404 for owners, 403 for finance. | **Tick starvation:** skipped meetings are never marked and keep filling the 25-row window (MAJ-11). Briefs and notifications fire for unlinked external meetings such as vendors and recruiters (MAJ-14). "Prep" is offered for internal-only meetings, and the brief page then errors. No `loading.tsx`. |
| **A10 Quick capture** | Partial | `capture/capture-button.tsx` (mounted at `shell/topbar.tsx:73`), `/capture`, `capture-form.tsx`, `lib/capture/actions.ts` (heuristic without AI, tested). | **Dictation can never work:** `next.config.ts:7` sends `Permissions-Policy: microphone=()`, which blocks the Web Speech API on our own origin (MAJ-06). Confirmed live on every response. Capture isn't contextual: on a deal page it opens with no deal. Auto-detect only covers the user's own deals. The button shows for finance, who then gets "Capture isn't available for your role" (live). No `loading.tsx`. |

### WS-D: Sequences and outreach

| Feature | Status | Evidence | Gaps |
|---|---|---|---|
| **A2 Sequences** | Partial | Builder: `sequences/sequence-builder.tsx`, `lib/sequences/core.ts` (business days, variables, exit rules; tested). Enroll from contact, deal, account, list ≤100 and Scout: `enroll.ts:58-225`. Runner: `runner.ts` (own Gmail, threading, working hours, DNC before every send, exits, retries ×3, activity + audit). Gmail-less sender blocked with a connect link (live copy on `/sequences` for sdr). | The daily cap counts the whole mailbox but compares against *this* sequence's cap (`runner.ts:590-614`). **"Resume all" resumes deliberate pauses** (MAJ-12). Replied % counts unsubscribes as replies. Enrollments table has `min-w-[860px]` with no mobile layout. ⌘S fires through open dialogs. |
| **A3 Scout → outreach** | Met | `lib/scout/outreach-core.ts:41-82` (untrusted-wrapped AI + heuristic), `outreach.ts:38,155-198` (briefs kind opener, ≤20), `scout/outreach-batch.tsx`, `outreach-actions.ts:39-101`. $5 budget: `scout/budget-core.ts:14`. Live: `/scout?tab=outreach` is 200 for sales roles, 403 for finance; empty state is clear. | The next batch starts with nothing selected. `edited:true` is set on every opener. The heuristic opener tells a cold prospect their traffic is falling (tone risk). |

### WS-E1: Slack, approvals SLA, partner links

| Feature | Status | Evidence | Gaps |
|---|---|---|---|
| **C1 Slack** | Partial | `lib/slack/*`, `api/slack/{interactions,commands,config}`. Signature v0 with timing-safe compare and 5 min window: `core.ts:8-33`. SoD re-check: `approvals.ts:97-116`. `/rtb deal` is MNPI-safe. No-op when unconfigured. Live: `/admin/slack` is 200 for admin, 403 for others. | **Approve/Reject buttons only for `requestApproval`-created kinds** (stage gate, term sheet). Overrides, pro forma, scout and lead registration get a plain notice (MAJ-15). **"Alerts channel" is configured but nothing posts to it** (MAJ-16). Stale buttons when decided in-app. The Reject path does DB work before `views.open` (3 s risk). |
| **C7 Approvals SLA** | Met | `approvals/sla-core.ts:10-58`, `sla-editor.tsx`. `dueAt` set on all app creation paths. List shows waiting / holder / due chip: `tasks/approvals-list.tsx:24-153`. Escalates once: `sla.ts:90-136`. Sticky mobile decision bar with h-12 targets: `:171-186`. Live: `/tasks?tab=approvals` is 200 for all roles. | `scripts/backfill-override-approvals.ts:76` omits `dueAt` (the tick backfills it). Sonner toasts overlap the sticky bar on mobile. |
| **C10 Partner view** | Partial | `lib/share/core.ts:15-133`, `service.ts:27-224`, `share/share-dialog.tsx`, `app/share/[token]/page.tsx`. Live: bogus token → 200 "This link isn't available", `X-Robots-Tag: noindex, nofollow, noarchive`, `Cache-Control: no-cache`, meta robots. Bot UA gets a neutral page (no oracle). | **Share from a filtered list is not mounted:** `ShareDealsButton` (`share-dialog.tsx:268`) has no caller (MAJ-17). Rate limit is in-memory per instance. `proxy.ts:22` matcher `share` (no slash) exempts any `/share*` path from auth. Lost deals are shown to partners as a red "Closed". |

### WS-E2: Team rituals

| Feature | Status | Evidence | Gaps |
|---|---|---|---|
| **C5 Pipeline review** | Met | `review/scope-picker.tsx`, `lib/review/core.ts:57-88`, full-screen `review/walkthrough.tsx:392`, outcomes through services `review/actions.ts:96-183`, recap `:187-219`. Keyboard 1–5 / j / k / ← / → / o / ?. Live: superadmin "147 of 3117 open deals need a decision — the top 100 go into the walk-through". | Shortcuts fire behind the open help dialog (`walkthrough.tsx:133-154`). Visible to **every** role, including sdr, intern, commission_rep and finance (live 200). For finance the outcome writes then fail. **Flooded by identical "Override pending" rows** (MAJ-21). SVP empty state says "No open deals in this scope" with no hint to widen the scope. |
| **C8 1:1 prep** | Met | `lib/briefs/one-on-one.ts:70-338`, `/team/1-1/[userId]`, `canPrepFor`. Live: 200 for superadmin and exec; soft 404 for svp (not the manager), sdr, intern, commission_rep and finance. The first generation took **7.98 s** (spinner "Pulling the week together…"); cached afterwards 1.2 s. | The "this week" window is frozen at first open. No rate limit on Refresh (AI cost). Field security is not applied to nextStep, close date and health (`one-on-one.ts:199`). |
| **C9 Stories and playbook** | Met | `lib/team/stories.ts:101-287`, `queue/providers/stories.ts`, `/team` feed + reactions + Playbook tab. "Add to playbook" mounted at `calls/[id]/page.tsx:174`. | "Also post to Slack" is shown (and defaults on for wins) when Slack isn't configured, and the toast claims it posted. The public-post branch ignores account-level restriction (`team/queries.ts:28`). |

### WS-F: Forecast and command

| Feature | Status | Evidence | Gaps |
|---|---|---|---|
| **A9 Forecast autopilot** | Met | `lib/forecast/core.ts:29-259` (pure, tested), `service.ts:199-306`, `forecast-list.tsx` (diff-only, confirm-all, reason into/out of commit), `rollup.tsx` (rep/motion and company), Monday Today item (`providers/forecast.ts`). Live: 200 for all roles. | Shortcuts die after clicking a pill (handler bails on BUTTON/A, `forecast-list.tsx:73`). No `<Term>` on commit / best / pipeline / weighted. The Today provider runs the full `buildForecast` on every /home load. SDR and intern see a dense forecast page with all-$0 tiles, which is noise for roles that don't forecast. |
| **A8 ⌘K commands and bulk** | Partial | `lib/commands/parse.ts` (tested), `service.ts:30-188`, signed HMAC preview token (`token.ts`), `execute.ts:61-202`, `deals-list.tsx:228-401` bulk bar (stage, owner, tag, sequence, export). | **Verb-prefixed queries hide Actions / Go-to / Copilot** ("add note" → "I couldn't turn that into a command") (MAJ-20). The dialog promises undo "for 15 min" but undo exists only in a 12 s toast. "Select all N matching" is offered above the 500 cap and then dead-ends. Lost/hold with an empty reason picklist can't be confirmed. |

### WS-G: Proposals

| Feature | Status | Evidence | Gaps |
|---|---|---|---|
| **Coalition term sheet** | Partial | Upload (≤2 MB, zip validation, base64, sha256): `api/proposals/templates/route.ts`, `docx/package.ts`. Placeholder scan: `detect.ts:72-151`. Mapping UI: `template-mapping.tsx`. Tier parse: `tiers.ts:100-130`. Run-preserving substitution: `substitute.ts`. Output validated. Print route. Versioned `coalition_term_sheet`, status draft → sent → signed, deal document + activity. Synthetic-docx tests. Admin nav entry. Live: empty state for reps ("An admin needs to upload and activate…"), CTA for admin; 403 for sdr, intern and commission_rep; finance gets 200 "No access". | **First uploaded template goes live before review** (`proposals/templates.ts:133`); tier columns may be guessed or swapped (MAJ-19). Standalone generation is missing (`term-sheet-actions.ts:101` requires `dealId`). No automatic region/market detection. Partner economics shows a point, not a **range**. The economics sidebar drops below the whole document under 1280 px. Approval on restricted deals can get stuck (exec not on the access list). |
| **A6 Pro forma** | Met | `deals/deal-proposals.tsx:41-46`, `proposals/new/page.tsx:62-75`, `lib/proposals/prefill.ts` + test. NY Post fixture `calc.test.ts` is green (103 tests in forecast/commands/proposals pass). | MUU, $/MUU and ramp are prefilled without the hidden-field check. |

---

## 2. Live checks: `http://localhost:3000` (dev, Turbopack, warm)

Signed in as `dev.superadmin`, `dev.exec`, `dev.svp`, `dev.sdr`, `dev.intern`, `dev.commission` (@roundtable.io) and `dev.finance@blockchainff.com`.

**Test IDs used**
- Deal `11ff1828…` (MLB Trade Rumors, owned by "Kade").
- Account `01e5f31a…` (9to5Toys).
- Contact `0e985350…`.
- 1:1 target is the sdr user.

**Fixture gaps**
- Sequences and meeting briefs used a non-existent UUID because the dev DB has no sequences or meetings.
- So `/sequences/<id>` and `/calls/briefs/<id>` were only checked on the not-found path. Their happy paths are **not live-verified**.

**Cell legend**
- "soft 404": HTTP 200, with `notFound()` streamed after the loading boundary.
- "→owner=me": the "Mine" default was applied by redirect.

| Route | superadmin | exec | svp | sdr | intern | commission | finance | TTFB (s) | Total (s) |
|---|---|---|---|---|---|---|---|---|---|
| /home | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 0.75–1.67 | 2.42–3.34 |
| /deals | 200 | 200 | 200 | 307→owner=me | 307→owner=me | 307→owner=me | 200 | 1.38–2.20 | 1.38–3.12 |
| /deals/&lt;id&gt; | 200 | 200 | 200 | 200 | 403 | 403 | 200 | 1.22–2.19 | **1.71–7.11** |
| /pipelines | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 0.76–1.55 | 1.75–2.65 |
| /pipelines/NET | 200 | 200 | 200 | 200 (soft →owner=me) | 200 (soft →owner=me) | 200 (soft →owner=me) | 200 | 1.00–1.53 | 1.31–3.71 |
| /sequences | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 0.96–1.70 | 1.06–1.79 |
| /sequences/&lt;bogus&gt; | soft 404 | soft 404 | soft 404 | soft 404 | soft 404 | soft 404 | soft 404 | 0.98–1.58 | 0.98–1.58 |
| /forecast | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 0.94–1.63 | 1.74–2.93 |
| /review | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 0.94–1.63 | 1.85–2.45 |
| /team | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 0.93–1.42 | 1.25–1.85 |
| /team/1-1/&lt;sdr&gt; | 200 (7.98 s first gen) | 200 | soft 404 | soft 404 | soft 404 | soft 404 | soft 404 | 0.95–1.38 | 1.20–1.59 (cached) |
| /capture | 200 | 200 | 200 | 200 | 200 | 200 | 200 ("isn't available for your role") | 0.95–1.48 | 0.95–1.48 |
| /calls | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 0.93–1.50 | 1.04–1.50 |
| /calls/briefs/&lt;bogus&gt; | soft 404 | soft 404 | soft 404 | soft 404 | soft 404 | soft 404 | 403 | 0.94–1.42 | 0.94–1.42 |
| /inbox | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 0.93–1.41 | 1.08–1.51 |
| /scout?tab=outreach | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 0.95–1.41 | 1.05–1.63 |
| /proposals | 200 | 200 | 200 | 403 | 403 | 403 | 200 | 0.93–1.40 | 1.23–1.69 |
| /proposals/term-sheets/new | 200 (upload CTA) | 200 (empty state) | 200 (empty state) | 403 | 403 | 403 | 200 ("No access") | 0.97–1.40 | 0.97–1.40 |
| /admin/templates | 200 | 403 | 403 | 403 | 403 | 403 | 403 | 1.07–1.57 | 1.07–1.57 |
| /admin/playbooks | 200 | 403 | 403 | 403 | 403 | 403 | 403 | 0.95–1.45 | 1.15–1.45 |
| /admin/slack | 200 | 403 | 403 | 403 | 403 | 403 | 403 | 1.08–1.48 | 1.26–1.48 |
| /settings | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 1.54–1.84 | 1.54–1.84 |
| /tasks?tab=approvals | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 0.98–1.49 | 2.25–2.72 |
| /accounts/&lt;id&gt; | 200 | 200 | 200 | 200 | 200 | soft 404 | 200 | 0.96–1.88 | 1.39–3.55 |
| /contacts | 200 | 200 | 200 | 200 (soft →owner=me) | 200 (soft →owner=me) | 200 (soft →owner=me) | 200 | 0.99–1.40 | 1.29–1.71 |
| /contacts/&lt;id&gt; | 200 | 200 | 200 | 200 | soft 404 | soft 404 | 200 | 0.93–1.49 | 1.45–2.62 |
| /share/&lt;bogus&gt; (no auth) | 200 "This link isn't available" · noindex header + meta · `no-cache` | | | | | | | 0.10–0.16 | 0.10–0.16 |

**Result:** 0 uncaught error digests, 0 "Something went wrong" pages and 0 5xx responses across about 190 requests. Every 403 renders the shared "No access" page.

**Observations from the live run**
- **Latency floor.** Every authenticated route has a **~0.93 s TTFB floor in dev**, even trivial ones like `/capture`. That points to fixed per-request cost in the `(app)` layout (session, nav, unread count, prefs) against the remote DB. The <500 ms server target for Today can't be confirmed here and is at risk; measure on a preview deploy.
- **Slowest pages.** The deal page is 5.4–7.1 s total, because all six tabs are force-mounted. First 1:1 generation is 8 s.
- **Not-found and forbidden handling is inconsistent:**
  - a deal out of scope returns **403**, but an account or contact out of scope returns a **soft 404 with HTTP 200**;
  - finance gets 200 "No access" on `/proposals/term-sheets/new` and 200 "isn't available" on `/capture`, where other roles get 403.
- **The Today queue is noisy:**
  - SVP: 9 identical rows "Unassigned high-value lead: X · Assign an owner · Open".
  - Superadmin: one row "Approve: 147 deals (bulk) probability override".
  - SDR: the queue shows three **"ZZ V2 test Alpha/Beta/Gamma: missing primary contact"** items. These are test records another workstream left in the shared DB and should be cleaned up.
- **Duplicated onboarding.** The "Connect your inbox to finish onboarding" banner shows above the Ask bar on /home (and on /inbox) while the checklist below shows the same "Connect Gmail & Calendar" step. The checklist is also rendered again inside /settings.
- **Microphone blocked.** Every response carries `Permissions-Policy: camera=(), microphone=(), geolocation=()`, which blocks capture dictation.

---

## 3. Findings

### Blocker

**BLK-01: MNPI titles reach Slack through the daily digest (B3, principle §0.4).**
- **Where:** `lib/notifications/digest.ts:64-77, 97`; `budget-core.ts:56-61`.
- **Why it leaks:**
  - Alerts on restricted records are inserted with their raw title and `sensitive: true` (`alerts/engine.ts:975`). Over budget, they become `digestOnly` rows.
  - `sendDailyDigests` puts those titles into a **"digest" notification with no `sensitive` flag** and `href: "/home"`.
  - "digest" isn't a budgeted kind, so `planDelivery` marks it `slack: true`, and `scheduleSlack` DMs the body.
  - `deliverToSlack`'s restricted check keys on `href`, which is `/home`, so it doesn't catch this.
- **Impact:** restricted deal names are posted to Slack for any user with Slack DMs on.
- **Fix:**
  - In the bundled query, select `href` too. Replace the title of any row whose href `hrefIsRestricted()` with "An update on a restricted record".
  - Alternatively, pass `sensitive: true` to the digest whenever any bundled row is restricted.
  - Add a unit test with a restricted row.

### Major

| ID | Area | Where | Problem | Precise fix |
|---|---|---|---|---|
| MAJ-01 | B1 keyboard | `components/home/today-queue.tsx:190-211` | `e` and `s` act when nothing is focused (`t === document.body`). Pressing `e` right after load resolves the top item, and an alert resolved this way can't be undone (`lib/queue/actions.ts:61`). | Allow only `j`/`k` from `<body>`, to enter the queue. Require focus inside `[data-queue]` for `e`, `s` and Enter. Give Done an undo toast for alerts as well. |
| MAJ-02 | Naming | `lib/nav.ts:17`, `home/page.tsx:18,66`, `home/loading.tsx:5`, `forbidden.tsx` ("Back to My Day"), `review/page.tsx:27` ("Back to Today"), `help/request-help.tsx:79`, `handoff-dialog.tsx:91`, `team/page.tsx:148` | The same page is called "My Day" (nav, title, forbidden page) and "Today" (card, other teams' copy). 32 occurrences mixed. | Pick **"Today"** for the nav, `<title>` and links ("Back to Today"); keep the greeting. Sweep with `grep -rn "My Day"`. Also rename the digest title prefix, and update the `like 'My Day%'` guard in `digest.ts:63` with it. |
| MAJ-03 | B7 | `components/copilot/copilot-chat.tsx:141-160` | The Ask bar auto-sends. A sessionStorage guard silently ignores a repeated question (suggestions, the checklist "Try it"). With AI off, the text is dropped. | Pass a per-open nonce from `openCopilot()` so the guard is per open. When `aiAvailable` is false, prefill the input instead of sending. |
| MAJ-04 | Settings | `components/settings/preferences-forms.tsx:41-45` | The In-app, Mentions and Approvals toggles are never read by `notify()`. Alert budget and quiet hours live on different cards with two identical "Save preferences" buttons. | Remove the dead toggles, or wire them into `planDelivery`. Merge Alert budget, "Alert me from", quiet hours and Slack into one "Interruptions" group with one save. |
| MAJ-05 | B1 performance | `lib/queue/index.ts:25,203`; `queue/providers/forecast.ts:19` | Provider timeout is 2.5 s, waves run sequentially, and the forecast provider runs a full `buildForecast` on every /home load. Live dev /home is 2.4–3.3 s. | Cut the per-provider timeout to about 400 ms. Make forecast a count-only query. Stream the queue under `<Suspense>` so the header and Ask bar paint first. Add a server-timing log. |
| MAJ-06 | A10 | `next.config.ts:7` | `Permissions-Policy: microphone=()` disables the microphone for **our own origin**, so `SpeechRecognition` always fails with `not-allowed`. Every dictation attempt ends in "Microphone access was blocked" (`capture-form.tsx:100`). | Change it to `microphone=(self)`, keeping camera and geolocation empty. Hide the mic button when `document.featurePolicy?.allowsFeature?.("microphone") === false`. |
| MAJ-07 | B5 | `components/deals/stage-move.tsx:85-93,139-146,205-219` | The next-step prompt opens only when the next step is *missing*, which never happens after B4. The playbook-prefilled next step never appears, and "Book intro call" survives into Contract. | When moving into an open stage and `playbookHints[stage]` differs from `deal.nextStep`, open the dialog with the Next step block prefilled (hint, else current) and due date +3 business days. `moveSchema.fields` already accepts these. |
| MAJ-08 | C6 | `lib/queue/providers/help.ts:21`; `components/help/request-help.tsx:141-233` | Meeting-only help requests link to `/home`. The target can't decline or respond (`HelpRequestList` is only on the deal page). The attached `context` is never rendered. | Use href `/calls/briefs/${meetingId}?help=${id}` and mount `HelpRequestList` there (or add `/help/[id]`). Render `r.context` in `HelpRow`. Route Today "Done" through the response form. |
| MAJ-09 | C3 | `lib/handoffs/core.ts:87-91` | "SDR → AE" lets an SDR, intern or commission rep be the receiver. | For `sdr_to_ae`, require role ∈ {ae, sales_leader, executive, super_admin}; keep the broad rule for `reassign`. |
| MAJ-10 | B6 cognitive load | `app/(app)/deals/[id]/page.tsx:155-188, 318-322, 481-485`; `deals/record/quick-actions.tsx:56-81` | Above the tabs: about 12 actions (owners, share, hand off, request help, close/hold, 7 quick actions, summary) plus 7–9 stage chevrons. 52 `<button>`s in the SSR HTML. "Generate proposal" appears three times; "Upload transcript" twice; "Log activity" and the global Capture overlap. | Primary row: Log · Email · Task · Ask Copilot. Put Upload, Proposal, Find executives, Hand off, Request help and Share into one "More" menu. Remove the duplicate Docs/Calls links. Make topbar Capture deal-aware (see MIN-12) and drop "Log activity → Note". |
| MAJ-11 | A5 | `lib/briefs/meeting.ts:209-234` | The tick selects meetings with no `deliveredAt` (limit 25). Internal-only, opted-out and failed meetings are never marked, so they starve real external meetings. | Upsert a marker brief (`deliveredAt = now`, content `{ skipped: reason }`) for skipped meetings, or filter in SQL on external attendees and owner prefs. |
| MAJ-12 | A2 | `lib/queue/providers/sequences.ts:107-118`; `lib/sequences/actions.ts:236-251` | "Resume all" also resumes enrollments the rep paused **on purpose**, which can send email they chose to hold. | Add `isNotNull(enrollments.lastError)` so only system pauses resume. Make `manageableEnrollments` skip failures instead of throwing for the batch. |
| MAJ-13 | A1 | `app/(app)/calls/[id]/page.tsx:52,152` | The autopilot mode comes from `getPrefs(user.id)` (the viewer), so a manager sees their own mode and not the rep's. | Use `getPrefs(t.uploadedBy ?? deal.ownerId)`. |
| MAJ-14 | A5 noise | `lib/briefs/meeting.ts:62-63` | Briefs and "Brief ready" notifications fire for any external attendee: vendors, recruiters, personal invites. | After `resolveLinks`, return null unless there is an `accountId` or a visible deal; keep a manual "Prepare now". |
| MAJ-15 | C1 | `deals/actions.ts:731`, `proposals/actions.ts:64`, `scout/actions.ts:163,243`, `commissions/actions.ts:258` | Approval notifications use non-approval hrefs, so only stage gates and term sheets get Slack Approve/Reject buttons. | Create them through `requestApproval`, or pass `href: approvalHref(row.id)` and put the deal link in the body. |
| MAJ-16 | C1 | `components/slack/slack-admin.tsx:101`; `lib/slack/admin.ts:77-125` | "Alerts channel" is saved and tested but nothing posts to it, though the hint says "Team-level alerts". | Post non-restricted critical/serious team alerts there from the alert engine, or remove the field and fix the hint. |
| MAJ-17 | C10 | `components/share/share-dialog.tsx:268` | `ShareDealsButton` (share a filtered list) has no caller. | Mount it in the `/deals` bulk bar and the pipeline toolbar with the selected or visible ids. Exclude restricted deals and say how many were skipped. |
| MAJ-18 | C1 security | `lib/prefs/actions.ts:22-38`; `lib/slack/identity.ts:36-40` | The Slack member ID is self-asserted. Claiming a colleague's ID reroutes DMs, and can make their `/rtb` and button clicks run as the claimant. | Verify with `users.info` that the Slack profile email equals the user's email before saving, enforce uniqueness, and otherwise fall back to `lookupByEmail`. |
| MAJ-19 | Term sheet | `lib/proposals/templates.ts:133` | The first uploaded template becomes active immediately, before any mapping or tier review. Reps can generate a term sheet with swapped partner/RTB splits (`tiers.ts:119-125` `columnsGuessed`). | Insert with `active: false`. `setTemplateActive` should require ≥1 mapped placeholder and `tiersReviewed = true`. Show "Draft — not visible to reps" on the template page. |
| MAJ-20 | A8 | `lib/commands/parse.ts:341-343`; `components/shell/command-palette.tsx:172-174,247-261` | Any query starting with add/set/show/find/list/change/update/… switches to command mode and hides Actions, Go-to and Copilot. "add note" ends in "I couldn't turn that into a command". | Keep the Actions and Go-to groups ranked on the query at all times. Enter command mode only when the rules parser returns a command (or when the user picks "Run as command…"). |
| MAJ-21 | Noise (B1, C5) | `lib/queue/index.ts:279-292` (folding); `lib/review/core.ts:57-88`; `lib/review/queries.ts:214-227` | Identical items are listed one by one: 9 "Unassigned high-value lead" rows for the SVP (live), and the review walk-through for superadmin is 147 "Override pending" deals from one imported bulk override (live). Together with the single "Approve: 147 deals (bulk)" row, the same decision shows up three times. | In `rankQueue` input, collapse ≥3 same-kind/same-rule items into one row ("9 high-value leads need an owner → Assign"), opening a pre-filtered list with the bulk bar. In review, exclude deals whose only exception is an override that is part of a pending bulk approval, and show one "Bulk override: decide in Approvals" card instead. |
| MAJ-22 | B2 nav sprawl | `lib/nav.ts:16-41`; `lib/rbac/nav-server.ts` | Default nav: super_admin/admin 22, executive 21, sales_leader 21, ae 20, finance 18 (including Sequences, Inbox, Pipeline review, Team, none of them finance work). sdr, intern and commission_rep: 7 + 10–11 under More. "Pipeline review" (a leader ritual) and Forecast are visible to sdr, intern and commission_rep, and the live pages are mostly empty for them. | Extend the short-nav default to **ae** (Today, Pipelines, Deals, Contacts, Inbox, Sequences, Calls, Forecast + More). Gate "Pipeline review" on analytics scope ≥ team. Hide Sequences, Inbox and Calls for finance (no `email.send`). Fold "Deals" into Pipelines as a list view (one entry point for deals). |

### Minor

| ID | Where | Problem | Fix |
|---|---|---|---|
| MIN-01 | `lib/queue/index.ts:26` | Approvers come from a hard-coded role list. | Use `can(user, module, "approve")`. |
| MIN-02 | `lib/prefs/actions.ts:41`; `checklist-core.ts` | The alert-budget step completes on any save. "Claim imported deals" is missing. The Slack step shows without Slack configured. `markChecklistStep` is unused. | Mark the step only when the value changed. Add a claim step. Hide the Slack step unless `getSlackContext()`. Delete the dead code. |
| MIN-03 | `home/page.tsx:57,76`; `settings/page.tsx` | The inbox banner and the checklist duplicate "Connect Gmail". The checklist is also rendered in Settings. | Hide the banner while the checklist is visible. In Settings, show only a "Restore checklist" link. |
| MIN-04 | `pipelines/(overview)/page.tsx:96-120` | MUU, RTB net, Weighted and the motion codes have no `<Term>`, because they sit inside a `<Link>`. | Put the Link on the title only, and wrap the stat labels in `<Term>`. |
| MIN-05 | `deals/list/deals-list.tsx:171` | The Motion filter ignores "motions I sell". | Sort with `leadWithMotions`. |
| MIN-06 | `settings/preferences-section.tsx:56-58` | sr-only `<legend>` plus `<h3>` makes screen readers say "Sidebar Sidebar" and "Autopilot Autopilot". Legends are empty for JSX titles. | Render the visible title inside `<legend>`, or use `aria-labelledby` and drop the sr-only legend. |
| MIN-07 | `settings/preferences-section.tsx:168-186`; `create-deal-dialog.tsx:178-197`; `handoff-dialog.tsx:107-123`; `share-dialog.tsx:180-195`; `forecast-list` pills | Custom radiogroups have no arrow-key roving. | Use the Radix RadioGroup / ToggleGroup primitive. |
| MIN-08 | `settings/profile` timezone select | About 420 raw IANA zones in a native select, with Africa/Abidjan first. | Add a searchable combobox with the detected zone and common zones on top. |
| MIN-09 | `components/home/today-queue.tsx:234-249` | The selected row has no `aria-selected` or `aria-current`. | Add `aria-current="true"` and a `role="listbox"`/`option` pattern, or `aria-activedescendant`. |
| MIN-10 | `shell/copilot-launcher.tsx:25`; `command-palette.tsx:67` | ⌘J while ⌘K is open stacks two modals. | Close the palette on ⌘J. |
| MIN-11 | `deals/create-deal-dialog.tsx:112,310,139,371` | Submit is disabled with no reason, and the toast lists bare values. | Show inline "Add a next step" hints. Toast: "Priority: High · Close: 14 Jan". |
| MIN-12 | `capture/capture-button.tsx:37`; `topbar.tsx:73`; `lib/capture/actions.ts:32-35` | Capture has no deal context, is not role-gated (finance sees it, live), and auto-detect only covers own deals. | Use `usePathname()` to pass `initialTarget` on `/deals/:id` and `/accounts/:id`. Gate on `activities:create`. Include team-visible open deals. |
| MIN-13 | `lib/deals/actions.ts:206-219` | A domain match links an account the creator can't see, and echoes its name. | Check `getVisibleAccount`; otherwise show a generic message or a registration-conflict flow. |
| MIN-14 | `lib/playbooks/service.ts:85-119`; `handoffs/service.ts:111` | The check-then-insert pattern can produce duplicate tasks or pending handoffs. | Schema request: unique partial indexes, or `pg_advisory_xact_lock(dealId)`. |
| MIN-15 | `lib/comments/service.ts:108` | `void mirrorCommentToSlack` can be killed after the response. | Use `after(() => mirrorCommentToSlack(id))`. |
| MIN-16 | `lib/deals/collisions-core.ts:22` | Notes count as "touching" the publisher. | Exclude `note` from collisions; keep notes in the timeline. |
| MIN-17 | `queue/providers/handoffs.ts:80-96` | Escalation leaves no audit entry or notification. | Add a tick job that stamps it once, audits it and notifies the manager. |
| MIN-18 | `lib/deals/actions.ts:621-626` | Undoing an auto-fill can clear a stage-required field. | Block the clear when the field is in `requiredForStage`. |
| MIN-19 | `deals/deal-bits.tsx:91-100`; `home/sections.tsx:70` | A next step with no due date shows no warning. "Need a next step" links to the unfiltered `/pipelines`. | Add a "Due date missing" badge, and link to `/deals?noNextStep=1`. |
| MIN-20 | `deals/[id]/page.tsx:456-465` | `Slot` only catches top-level errors, so a nested async error takes down the deal page. Tabs force-mount. | Wrap each slot in an error boundary. Lazy-load inactive tabs (target <2 s deal page). |
| MIN-21 | `deals/[id]/page.tsx:261-265,136` | The signals panel isn't directly under the summary, and the forecast badge sits inside the `<h1>`. | Move the panel up and the badge out of the heading. |
| MIN-22 | `gmail/drafts.ts:69`; `autopilot-core.ts:57`; `autopilot.ts:157-203` | Silent in-app draft with "follow-up drafted" copy; undo leaves the Gmail draft in place. | Add a `needsRecipients` flag and its copy. Delete the Gmail draft on undo, or say that it stays. |
| MIN-23 | `gmail/__tests__` | No tests for `evaluateDraftGuard` or `personalizeDraft`. | Add `drafts-core.test.ts`. |
| MIN-24 | `lib/queue/index.ts:244-259`; `briefs/actions.ts:19` | "Prep" is offered for internal-only meetings, and the brief page then errors. | Skip the action when there are no external attendees. |
| MIN-25 | `lib/sequences/runner.ts:590-614` | The daily cap mixes the whole mailbox with this sequence's cap, and scans all history. | Use one per-mailbox cap; bound the scan to the current day. |
| MIN-26 | `lib/sequences/core.ts:400`; `manage.ts:72` | Replied % includes unsubscribes. Skip ignores the next step's delay. | Track opt-outs separately. Use `scheduleAfter` on skip. |
| MIN-27 | `scout/outreach-batch.tsx:40`; `outreach-actions.ts:85` | The next batch starts unselected, and `edited:true` is always set. | Key the component on row ids. Compare the text before setting the flag. |
| MIN-28 | `sequences/sequence-builder.tsx:114-124` | ⌘S saves the sequence underneath an open dialog. | Ignore the shortcut when `[role="dialog"]` is open. |
| MIN-29 | `sequences/enrollments-table.tsx:86`; `app/(app)/proposals/page.tsx:46`; `forecast/rollup.tsx:76`; `calls/page.tsx:179` | Wide tables (560–860 px minimum) at 375 px with no stacked mobile layout; actions sit off-screen. | Under `sm`, render stacked cards (the `/deals` list already does this). |
| MIN-30 | `review/walkthrough.tsx:133-154` | Review shortcuts fire behind the help dialog. | Add `if (help \|\| e.repeat) return;`. |
| MIN-31 | `forecast/forecast-list.tsx:73` | Shortcuts stop after a pill click (the handler bails on BUTTON/A). | Bail only on INPUT, TEXTAREA, SELECT and contentEditable. |
| MIN-32 | `forecast/*`, `rollup.tsx:44` | No `<Term>` on Commit / Best case / Pipeline / Weighted / Gross. | Wrap the tile labels and headers; add glossary entries for "pipeline (category)" and "omitted". |
| MIN-33 | `components/forecast/command-preview.tsx:79,98`; `token.ts` | The dialog says "undo for 15 min" but undo is a 12 s toast. Tokens can be replayed. | Fix the copy or add an Undo entry in Notifications. Use a one-time nonce and compare-and-set on undo. |
| MIN-34 | `deals/list/deals-list.tsx:259`; `command-preview.tsx:55,128` | "Select all N" is offered above 500 and then dead-ends. An empty lost-reason picklist blocks confirm. | Cap with "max 500 per command". Fall back to free text. |
| MIN-35 | `proposals/term-sheet-actions.ts:101`; `detect.ts`; `partner-economics.tsx:51-67`; `term-sheets/[id]/page.tsx:90` | Term sheet: no standalone generation, no automatic region detection, economics is a point not a range, the sidebar sits below the document under 1280 px. | Allow `dealId` to be null with a manual entity form. Detect "in [Market]" phrases. Show a low–high range labelled illustrative. Use an `lg:` grid or a compact card above the preview. |
| MIN-36 | `approval-state.ts:24`; `proposals/actions.ts:139-144` | Restricted term-sheet approvals: the payload stores the deal name, and an exec not on the access list is stuck. | Omit names for restricted deals. Route to an approver on the access list. |
| MIN-37 | `api/slack/interactions/route.ts:71-100`; `lib/slack/deliver.ts:98` | The Reject path is slow before `views.open`. The fallback text "An approval request was updated" is sent for new requests. | Open the modal first and check on submit. Copy: "New approval request — open in Roundtable". |
| MIN-38 | `team/recap.tsx:115`; `story-composer.tsx:67,124`; `announcement-composer.tsx:58` | The "Also post to Slack" option and the success toast show when Slack isn't configured. | Pass a `slackReady` flag, and hide the option otherwise. |
| MIN-39 | `proxy.ts:22` | The matcher `share` exempts `/shared-x` and any other `/share*` path from auth. | Use `share/` (and `pending$\|pending/`). |
| MIN-40 | Not-found / forbidden semantics (live) | Out-of-scope accounts and contacts are a soft 404 with HTTP 200, while deals return 403. Finance gets a 200 "No access" page on term-sheets/new and on capture. | Run the access checks in the page *before* any Suspense or `loading.tsx` streams, using `forbidden()` consistently. Use one pattern across records. |
| MIN-41 | Live DB | Three "ZZ V2 test Alpha/Beta/Gamma" deals left by another workstream show in dev.sdr's Today queue. | Soft-delete the test records (not done here; they aren't mine). |

### Polish

| ID | Where | Problem | Fix |
|---|---|---|---|
| POL-01 | `today-queue.tsx:445-446`, `checklist-card.tsx:19,24`, `ask-bar.tsx:45`, `term.tsx:31`, `stage-path.tsx:60`, `walkthrough.tsx:185`, `brief-view.tsx:14,70,92`, `post-card.tsx:121`, `story-prompts.tsx:20`, `scout/bits.tsx:78` (`#5C98D5`), `review-queue.tsx:336`, `rollup.tsx:156`, `command-preview.tsx:108,122` | Raw hex values instead of tokens or palette constants. | Use `bg-surface-*`, `border-border-strong`, `text-muted`, and `VIZ`/`SEQ_BLUE` from `lib/palette.ts`. |
| POL-02 | `inbox-filters.tsx:35`, `enroll-dialog.tsx:315`, `transcript-viewer.tsx:24`, `capture-form.tsx:254`, `sequence-builder.tsx:391` | Raw `bg-white`, `text-black` and `border-black/20`. | Use `bg-fg text-accent-inverse` tokens. |
| POL-03 | `capture-form.tsx:172`, `post-card.tsx:30`, `today-queue.tsx:457` | 600 ms delight animations; the system says ≤200 ms. | Acceptable as "earned" micro-delight. Keep them `motion-safe` (they already are), or shorten to 300 ms. |
| POL-04 | `share/[token]/page.tsx:22-27` | Partners see lost deals as a red "Closed". | Use a neutral "Not proceeding", or omit lost deals. |
| POL-05 | `review/scope-picker.tsx:69,109-113` | Codes only (NET/ENT/R100). Buttons inside `role="option"` misuse ARIA. | Show pipeline names, and use a checkbox group. |
| POL-06 | `calls/briefs/[meetingId]/page.tsx:100` | Every risk repeats a "Risk" badge under a "Risks" header. | Drop the per-item badge. |
| POL-07 | `gmail/drafts-core.ts:19` | "MNPI check:" is jargon for reps. | Use "Possible confidential info:". |
| POL-08 | `scout/outreach-core.ts:45` | The heuristic opener mentions a prospect's falling traffic. | Drop that branch. |
| POL-09 | `deals/auto-marker.tsx:13`; kanban "wtd"; "Close / hold…" | Copy: "Filled automatically by rule", "wtd", "Close / hold…". | Use "Auto-filled — undo", "weighted" and "Close or pause…". |
| POL-10 | `help/request-help.tsx:17,89` | Hard-coded "SVP" label. | Use the role label from rbac. |
| POL-11 | `deals/discussion.tsx:38,117` | Repeated `h2`; `window.confirm` on delete. | Drop the heading. Use an undo toast. |
| POL-12 | `header-editors.tsx:105` | Date input without `[color-scheme:dark]`. | Add the class. |
| POL-13 | `admin/playbooks-editor.tsx:167-214` | Doubled "Active" label, reorder is "up" only, no task description. | Add up/down and description fields. |
| POL-14 | Empty states in deal tabs | Ad-hoc dashed `<p>` instead of `EmptyState`. | Use `EmptyState` with one CTA each. |
| POL-15 | `capture-form.tsx:229-230`; `enroll-dialog.tsx:309`; `sequence-builder.tsx:452-472` | The mic button has a changing label and is only 36 px. Toggle rows have no `aria-pressed`. The preview search has no listbox semantics. | Use a static label with `aria-pressed`, `size-11`. Add ARIA roles and arrow keys. |
| POL-16 | `forecast-list.tsx:169` | A manager's save overwrites the rep's call with no marker. | Show "Set by <manager>". |
| POL-17 | `forecast/page.tsx:206`; command preview | ⌘ hints show on Windows. | Use a platform-aware `<Kbd>`. |
| POL-18 | `templates/template-upload.tsx:70`; `tiers.ts:97` | Borderline document-specific literals: "Founding partner term sheet", "founding". | Use a neutral placeholder and drop the word from the regex. |

---

## 4. Cross-cutting UX review

### Design system (PRD §16A / ENGINEERING §UI)

Clean overall:
- **0** `shadow-*` classes and **0** transitions at 300 ms or longer.
- **0** coloured Tailwind palette classes; status uses `StatusBadge` (icon + label).
- Headings use `font-display` everywhere checked.

Drift is limited to:
- about 20 raw hex or `bg-white`/`text-black` literals (POL-01, POL-02);
- a handful of `text-good/critical` icons outside StatusBadge (`stage-path.tsx:89,94`, `create-deal-dialog.tsx:371`).

### Copy and naming
- **Today vs My Day** is the most visible inconsistency (MAJ-02).
- **"Motion" vs "pipeline"** is used for the same concept:
  - Settings says "Motions I sell".
  - The nav, page titles and Pipelines overview say "Pipelines"; forecast says "motion"; review chips use codes.
  - **Fix:** keep "Pipelines" as the noun for the board, define "motion" in the glossary as "a type of pipeline (NET, ENT…)", and always show the full name beside the code.
- **Jargon left bare:** "MUU", "RTB net", "Weighted", "Commit/Best case", "override", "SLA" and "MNPI" appear without `<Term>` on Pipelines, Forecast, Review and the deal value cells (B10 Partial).

### Keyboard map (no same-page collisions)

| Keys | Where | Notes |
|---|---|---|
| ⌘K | palette, global | |
| ⌘J | Copilot, global | stacks over ⌘K (MIN-10) |
| `n` | new task, /home and /tasks | |
| j / k / e / s / ↵ | Today | `e`/`s` from body: MAJ-01 |
| j / k / 1–4 / ↵ | Forecast | dies after a pill click: MIN-31 |
| 1–5 / j / k / ← / → / o / ? | Review | fires behind help: MIN-30 |
| `/` and Esc | /deals | |
| ⌘S | sequence builder | fires through dialogs: MIN-28 |
| ⌘↵ | discussion, capture, preview | |

Hints are visible on Today, Review and Forecast.

**Suggestion:** a single `?` cheat sheet, available globally, that lists the current page's keys.

### Cognitive load and duplicate entry points

**Places that hold "things to do":**
- Today
- Tasks & Alerts (nav)
- the bell (→ /tasks?tab=notifications)
- Inbox "Reply owed"
- Approvals (inside /tasks)

Today is the right primary surface. The bell and the Tasks nav item now compete with it.

**Fix:** make the bell open a popover of the *interrupting* notifications only, with a "See all in Today" footer. Rename "Tasks & Alerts" to "All tasks" and move it under More for short-nav roles.

**Ways to log something:**
- Topbar Capture
- deal "Log activity"
- palette "create note / log call"
- Copilot

Make Capture the one quick path and context-aware (MIN-12).

**Deals list vs Pipelines:** two nav entries for the same records (MAJ-22).

### Mobile at 375 px (code review only)

What works:
- Today collapses the row actions into "⋯".
- The deal header reorders to next step and quick actions first.
- The approvals sticky bar has 48 px targets.
- /capture is single-column.
- /deals has stacked cards.

What doesn't: proposals, forecast roll-ups, enrollments, calls and the account sub-tables are horizontal-scroll tables with actions off-screen (MIN-29). The term-sheet economics sits below the whole document (MIN-35).

### Loading, empty and error states

Error handling:
- The `(app)/error.tsx` group boundary covers every route.
- `forecast` and `admin` have their own `error.tsx`.

`loading.tsx` is present for:
- home, sequences, sequences/[id], forecast, review, team, team/1-1/[userId]
- calls, inbox, scout, proposals, term-sheets/new, tasks
- deals/[id], pipelines/[key]

`loading.tsx` is **missing** for /capture, /calls/briefs/[meetingId], /calls/upload, /admin/templates and /settings. Settings is the slowest simple page at 1.5–1.8 s (six parallel loads).

Empty states are present and mostly good: one CTA each, calm copy, "That's everything for today", "Your forecast is in", "No one to reach out to yet".

### Joyless or confusing moments a real rep would hit
1. **Pressing `e` on landing** silently clears the top alert (MAJ-01).
2. **The microphone button never works** (MAJ-06). That is the worst first impression of the "say what happened" promise.
3. **The SVP opens Today to nine identical "Unassigned high-value lead" rows** (MAJ-21). That reads as spam, not prioritisation.
4. **SDR and intern see Forecast and Pipeline review full of $0 / "No open deals in this scope"**, with no idea whether they are meant to use them (MAJ-22).
5. **Asking the same suggested Copilot question twice does nothing** (MAJ-03).
6. **Moving a deal forward never asks "what's next?"** even though the playbook knows (MAJ-07). The next step quietly goes stale.
7. **"Also post to Slack" is ticked and the toast says "posted"** even when Slack isn't set up (MIN-38).

---

## 5. The 10 highest-leverage UX improvements

| # | Improvement | Covers |
|---|---|---|
| 1 | **Group like items in Today and Review.** One row per rule ("9 leads need an owner → Assign all"), opening a pre-filtered list with the bulk bar. Drop bulk-override deals from review. This alone removes most of the noise leaders see. | MAJ-21 |
| 2 | **Short nav for everyone by default** (8 items + More), role-tuned. Gate Pipeline review to leaders. Hide email surfaces for finance. Merge Deals into Pipelines as a list view. | MAJ-22 |
| 3 | **Make the playbook drive the next step on every stage move.** Prefilled, one Enter to accept. That is the core B5 promise. | MAJ-07 |
| 4 | **Fix Capture end-to-end:** allow the microphone for self, make it deal-aware from the current page, gate it by role. Then point the deal's "Log activity → Note" at it, so there is one quick path. | MAJ-06, MIN-12 |
| 5 | **Calm the deal header:** 4 primary actions, everything else in "More", signals panel directly under the summary, lazy tabs (deal page from about 6 s to under 2 s). | MAJ-10, MIN-20, MIN-21 |
| 6 | **One name, one inbox.** "Today" everywhere. The bell becomes a popover of interruptions with "See all in Today". Tasks & Alerts becomes "All tasks" under More. | MAJ-02 |
| 7 | **Safe keyboard by default:** `e`/`s` need explicit row focus; Done gets undo for alerts; a single global `?` shortcut sheet. | MAJ-01, MIN-30, MIN-31 |
| 8 | **Put `<Term>` on every number label** (MUU, RTB net, Weighted, Commit/Best/Pipeline, Override) and show pipeline names next to codes. Cheap, and it removes most jargon friction for new reps and interns. | B10, MIN-04, MIN-32 |
| 9 | **Honest integration states.** Hide Slack options and checklist steps when Slack isn't configured. Show "Add a recipient to put this in Gmail" instead of claiming "drafted". Never claim "posted" when nothing was. | MIN-02, MIN-22, MIN-38, MAJ-16 |
| 10 | **One Settings "Interruptions" card** (alert budget, severity floor, quiet hours, Slack DM) with one Save. Remove the dead notification toggles and the duplicate checklist. | MAJ-04, MIN-03 |

---

## 6. Not verified / limits
- **No screenshots at 375 px.** A browser session couldn't be established in this audit, so mobile findings are from code.
- **Happy paths for `/sequences/[id]` and `/calls/briefs/[meetingId]`** were not exercised live; the dev DB has no sequences or meetings.
- **Slack, Gmail and AI integrations** were reviewed in code only; none are connected in dev.
- **Timings are from a Turbopack dev server** against the remote Supabase. Treat them as relative, not as production numbers.
- **No test records were created or modified by this audit.**
