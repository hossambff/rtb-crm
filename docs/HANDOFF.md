# Roundtable Sales OS: morning handoff (30 Sep 2026)

## TL;DR
The MVP is built, audited three times, fixed, and re-verified. The final verdict is **"Ready with caveats"**, and the caveats are external setup steps only (see the checklist below).

**Checks**
- Type-check: clean.
- Lint: clean, 0 warnings.
- Unit tests: 465/465 pass.
- Production build: passes, 58 routes.
- Parallel load test: 36/36 pages returned 200.

**Where the code is:** everything is committed locally on `main` in `RTB Dashboard/rtb-crm`. GitHub push is blocked (item 1 below).

## Your action items (in order)
1. **Unblock the GitHub push.** Push protection flagged a *fake* Stripe-style string that was used as a redaction test fixture in a Copilot unit test.
   - It has since been rewritten so it no longer looks like a key, but it still exists in an older, unpushed commit.
   - Option A: open https://github.com/hossambff/rtb-crm/security/secret-scanning/unblock-secret/3K1gBqaGVpJkyOBsDur48tAU6AE, mark it as a false positive / "used in tests", then run `git push` in `rtb-crm`.
   - Option B: allow me to rewrite the 64 unpushed commits to remove it; my attempt was blocked by the permission check.
2. **Link Vercel.** In the `rtb-crm` Vercel project, go to Settings → Git and connect `hossambff/rtb-crm` (branch `main`). Set the Functions region to **dub1**. Add the env vars listed in `docs/DEPLOY.md` §3.
3. **Google OAuth** (needed for sign-in and Gmail/Calendar). Add the `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` env vars. Add these redirect URIs:
   - `https://<domain>/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google`

   Enable the Gmail and Calendar APIs. See §5 for the consent-screen setup for the two domains.
4. **Better Auth dashboard.** Finish connecting the "RTB CRM (Roundtable Sales OS)" project with the production URL. The API key is already in `.env.local`.
5. **First production sign-in.** The first account to sign in becomes `super_admin`; use your own Google account. Then use Admin → Users to pre-provision the team, and **Claim placeholder** to map imported reps to their real accounts (Chris, Will, Kevin, Casey and others). Until reps are mapped, imported deals are owned by placeholder accounts, so Nothing-Slips alerts have nobody to notify.
6. **Before go-live.** Run `npm run db:purge-dev` to delete the seeded `dev.*` test accounts. Production blocks them regardless.
7. **Decisions waiting for you.**
   - **147 imported probability overrides.** These are James's 90% tier from 29 Sep. They're waiting in Tasks → Approvals as one bulk request for an **executive** to approve or reject.
   - **Import ledger repair.** One partial import batch (`70404ba2`) is missing its rollback records. The repair SQL is in `docs/IMPORT_REPORT.md`; it needs your OK before it's run.
   - **Rotate secrets.** The AI Gateway key and the Supabase secret key were pasted in chat, so rotate both.
8. **Optional.**
   - Add an `APIFY_TOKEN` to enable live Lead Scout; the pilot is capped at $10/month.
   - Each user can add their own Granola API key in Settings.
   - Add AI Gateway credits to switch Copilot to Claude models (Admin → Settings → AI models). The free tier currently allows only `gemini-2.5-flash` and `gpt-5-mini`.
   - On Vercel Pro, raise the sweep cron to hourly and email sync to every 10 minutes.

## What was built
- **Foundation.** Next.js 16 on Supabase: a dedicated project, schema `rso`, and a least-privilege role `rso_app`.
  - Row-level security is on for all 57 tables.
  - The `rso` schema is not exposed to Supabase's REST API, and its tables are only accessible to the server.
- **Auth and permissions.** Better Auth with Google login, limited to `roundtable.io` and `blockchainff.com`.
  - A Module × Action × Scope permission engine covers 13 roles.
  - Restricted (MNPI) records are enforced everywhere, and some fields are hidden per role.
- **Pipelines.** Five sales motions plus the Media Liquidity Pool (PAY). Features include:
  - a Kanban board with stage gates and a list view;
  - deal pages with an AI summary, stakeholders, splits and override approvals;
  - health scores.
- **Accounts, contacts and import.** Account 360 pages, a merge tool, and an import wizard with rollback.
  - The 4 spreadsheets are migrated: **8,579 accounts, 3,178 deals and 3,651 contacts**, with 0 duplicate domains.
  - TheStreet revenue reconciles exactly to the C&W summary.
- **Nothing Slips.** 28 alert rules are active, with escalation (manager → team lead → SVP → exec), approvals, notifications and digests. My Day is the home page.
- **Inbox and calls.** Gmail sync with AI analysis that extracts commitments, calendar sync, Granola (API), Zoom (webhook) and transcript upload.
  - Post-call analysis feeds an Apply screen that creates tasks, updates fields and drafts the follow-up.
- **Copilot.** A streaming AI agent with 13 permission-scoped tools, meeting prep, a claims/MNPI guardrail and prompt-injection defense.
- **Lead Scout.** Apify integration with an actor registry, fit scoring, a review queue, executive enrichment and budget caps.
- **Programs.** Roundtable 100 goal tracker, Revenue/AR, Onboarding board, Commissions (plans, accruals, statements, lead registration) and a Proposals pro forma. The NY Post case reproduces exactly.
- **Analytics and Admin.** 8 dashboards built with the validated pastel palette, plus a full admin console and audit log.

## Quality process
1. Eight feature agents built modules in parallel.
2. One integration pass wired the modules together.
3. Three independent audits (`docs/audits/`) covered security, code correctness and functional QA.
4. Three fix agents resolved all Critical, High and Medium findings.
5. A final release verification ran, and I fixed its remaining low-severity items.

Remediation status tables are in each audit file.

## Known limitations
- Live Gmail, Calendar, Zoom, Granola and Apify runs are unverified because their credentials aren't set up yet. The logic around them is unit-tested with fixtures and mock servers.
- The Granola API endpoint paths are best-effort and kept in one constants block for easy adjustment.
- `/pipelines/NET` takes about 2.5 s warm in dev. It loads board cards for about 2,000 deals, so a lighter card query is a follow-up.
- Deferred Low findings are listed, with reasons, in the audit remediation sections.

---

# V2 release, 1 Oct 2026: productivity, simplicity, coordination

All 30 features are built, along with the Network Development term-sheet generator.

**Quality process**
- Eight build teams, then an integration pass.
- Three independent audits (security, correctness and performance, QA/UX), then four fix teams and a cleanup round.
- A release verification, with verdict **GO**.

**Release results**
- Production build passes.
- Typecheck and lint are clean.
- 942 unit tests pass.
- A parallel load test passed: 3 rounds × 18 routes, all 200.

## What's new
- **Productivity**
  - **Calls and email:**
    - Post-call autopilot (tasks, next step, a Gmail draft, 24-hour undo).
    - Deal signals from email and calls (one click to apply).
    - Auto meeting briefs.
    - Voice/quick capture.
  - **Outreach:**
    - Sequences from each rep's own Gmail (auto-exit on reply, daily caps, no double-sends).
    - Lead Scout → reviewed outreach batches.
  - **Deals:**
    - Stage playbooks (49 seeded).
    - Four-field deal creation with auto-fill.
    - Forecast autopilot.
    - ⌘K natural-language commands with preview and undo.
  - **Proposals:**
    - Pro forma prefill.
    - Coalition term-sheet generator.
- **Simplicity**
  - One ranked **Today** queue on **My Day** (keyboard j/k/e/s).
  - A sidebar shaped to each role (≤12 items, the rest under More).
  - Alert budget (bundles into the digest).
  - Ask-Copilot bar and a first-run checklist.
  - Saved views and smart defaults.
  - Plain-language glossary.
  - Summary-first deal page.
- **Coordination**
  - **Slack:** DMs, approve/reject from Slack, `/rtb deal`, an alerts channel and a wins channel. MNPI never leaves the app.
  - **Approvals:** SLAs and escalation.
  - **On a deal:**
    - Deal threads with @mentions.
    - Structured handoffs that must be accepted.
    - Collision warnings.
    - Exec help requests.
  - **Team rituals:**
    - Pipeline review mode.
    - 1:1 prep.
    - Win/loss stories and a playbook library.
  - **Partners:** read-only partner links.

## Ops checklist
1. **Migrations 0004–0011** are already applied to the Supabase DB.
2. **Starter sequences:** 3 are seeded **inactive**. Activate them in /sequences after reviewing the copy.
3. **5-minute scheduler:** Supabase `pg_cron` + `pg_net` call `/api/cron/tick` with the CRON_SECRET bearer. Set it up once after deploy (see DEPLOY.md §7).
4. **Google OAuth:** add the `gmail.compose` scope to the consent screen. Existing users must reconnect Gmail to get drafts in Gmail.
5. **Term sheet:** upload the template at **Admin → Templates**. Map the detected fields, review the parsed revenue-share tiers, then **Activate**. The template is never stored in the repo.
6. **Slack (optional):** follow docs/SLACK_SETUP.md, then paste the bot token and signing secret at Admin → Slack & approvals.
7. **Forecast:** none of the 3,117 imported open deals has a close date, so they show as "Unscheduled". Reps set dates via /deals → bulk "Close date".
8. **Apify:** on the free plan with a $5/month cap; the org budget is set to $5.
