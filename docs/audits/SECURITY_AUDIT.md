# Security Audit — Roundtable Sales OS (rtb-crm)

- **Date:** 2026-09-30
- **Branch:** `main` @ `078043c` (28 commits ahead of origin)
- **Scope:** application code (`src/**`), auth config, route handlers, server actions, AI/Copilot, integrations, exports, Supabase grants, dependencies, git history.
- **Method:** code trace of every `"use server"` file (28) and every route handler (22, including 2 outside `/api`). Live verification against the lead's dev server (`http://localhost:3000`), using the seeded dev accounts. Read-only SQL against the `rso` schema as `rso_app`. Temporary `[test] sec …` rows were used for field-level-security, restricted-deal and Account 360 tests, then deleted. Final count of `[test] sec%` deals, accounts and documents is 0. No source files were modified.
- **Evidence labels:** **LIVE** = reproduced against the running server. **SQL** = verified with a read-only query. **CODE** = precise code trace. **SUSPECTED** = plausible but not fully traced.

## 1. Summary

The core authorization model is sound:
- `dealAccessWhere`, `accountVisibilityWhere` and `contactVisibilityWhere` are used on the main list, detail and search paths.
- Every server action goes through `action()`.
- Every route handler authenticates.
- Cron and webhook secrets are compared in constant time and fail closed.
- Field-level security is stripped server-side, including RSC props.
- There is no raw-HTML rendering anywhere.
- CSV exports neutralise formulas.
- The MIME builder strips CRLF.
- Supabase `anon`/`authenticated` have no access to `rso`.

The weaknesses cluster in three areas:
1. **Privilege escalation through Better Auth's built-in admin endpoints.** The `admin` role can promote itself to `super_admin`, which bypasses every app-level guard and every MNPI access list.
2. **MNPI (restricted-record) leakage through secondary paths** the main helpers don't cover:
   - Account 360 documents
   - Copilot account timeline, contacts and tasks
   - weekly digest and snapshot trends
   - transcripts on restricted accounts
   - approval notifications
   - enrichment runs
   - several lookup actions that return restricted account names
3. **Business-logic integrity gaps:** split self-assignment, self-approval of proposals and registrations, R100 stage and bonus edits, and prompt-injection autonomy resets.

**Count:** 0 Critical · 4 High · 15 Medium · 20 Low · 4 Info.

## 2. Findings

### High

| ID | Title | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|
| **H-1** | `admin` role can self-promote to `super_admin` (and delete, ban or re-email users) via Better Auth `/api/auth/admin/*` | `src/lib/auth/index.ts:31-37`, `src/lib/auth/access.ts:10-15`; `node_modules/better-auth/dist/plugins/admin/routes.mjs:44-78` (set-role), `:233-300` (update-user) | **CODE + evaluated.**<br>• `authRoles.admin` = full `adminAc`. Running `authRoles.admin.authorize({user:[p]})` returns `true` for `set-role`, `update`, `set-email`, `delete`, `ban`, `create`, `set-password`, `impersonate`, and `false` only for `impersonate-admins`.<br>• `/admin/set-role` only checks that the permission exists and that the role name exists (`super_admin` is in `authRoles`). There is no self-change or privileged-role check.<br>• The catch-all `src/app/api/auth/[...all]/route.ts` exposes these endpoints.<br>• **LIVE:** the endpoints are reachable (intern gets 403, superadmin gets 200 on `/admin/get-user`).<br>• There is no `admin`-role dev account, so the escalation itself was not executed. | An Admin/RevOps user POSTs `{userId:self, role:"super_admin"}`. From then on:<br>• `canSeeRestricted` returns true and `dealAccessWhere` stops filtering restricted deals, so all MNPI is visible.<br>• They can edit the permission matrix, field security and allowed domains.<br>Every app guard is skipped: `users-actions.ts:48-51`, :98 (no self role change), :100/139 (keep one super admin), and the audit trail. `/admin/update-user` can also change any user's email, which enables an account takeover via Google linking. `/admin/remove-user` hard-deletes users. | Choose one:<br>• Give `admin` a reduced Better Auth role (no `set-role`/`update`/`delete`/`set-email`/`set-password`/`ban`).<br>• Or 404 every `/api/auth/admin/*` path in the auth route handler, since the app has its own audited user-management actions.<br>Also add a `hooks.before` that rejects role changes to or from `super_admin`/`admin` unless the caller is `super_admin`. |
| **H-2** | Account 360 shows documents of restricted and out-of-scope deals | `src/lib/accounts/queries.ts:286-296` (with `deals/actions.ts:561-562` always setting `documents.accountId`) | **LIVE.**<br>• Created a `[test] sec` restricted NET deal, not on any access list, on a normal `[test] sec` account, with a contract document.<br>• `/accounts/<id>` rendered "MNPI term sheet" for intern, sdr, exec, svp and finance. None of them can open the deal itself (404).<br>• Cause: `or(eq(documents.accountId, id), exists(deal visible))`. The first branch matches every deal document, so the visibility branch never filters anything. | Contract, NDA and term-sheet names, URLs and signed/expiry dates of restricted deals (e.g. Arena/Paradium) are visible to anyone who can see the account, which by default is almost every role. This breaks ENGINEERING rule 3 and AUD-3. | `and(eq(documents.accountId,id), or(isNull(documents.dealId), exists(select 1 from deals where id=documents.dealId and <dealAccessWhere>)))` |
| **H-3** | Copilot `get_timeline({accountId})` returns activities of restricted and out-of-scope deals | `src/lib/copilot/queries.ts:494-528`; `src/lib/copilot/service.ts:263-265,300` (`meeting_prep` falls back to account access) | **CODE.**<br>• For an account parent, the only conditions are `eq(activities.accountId, id)` plus the actor scope. There is no deal filter.<br>• Email, doc and task activities carry both `dealId` and `accountId` (`deals/actions.ts:574`).<br>• The UI equivalent (`accounts/queries.ts:281`) does filter by `dealWhere`. | Bodies of restricted-deal emails, notes and calls (up to 40 × 500 characters) are sent to the model and shown to the user. This defeats AT-07 and M23 AUD-3. | Add `or(isNull(activities.dealId), exists(deal where dealAccessWhere))`. In `meetingPrep`, deny when `m.dealId` is set but not accessible. |
| **H-4** | Weekly manager digest sends org-wide pipeline totals, including restricted deals, to any manager | `src/lib/notifications/digest.ts:92-160`; `src/lib/notifications/snapshots.ts:31-34` | **CODE.**<br>• Snapshots aggregate all deals with only `isNull(deletedAt)`.<br>• Digest recipients are anyone who is a `managerId` target or team lead, with no `analytics` scope or restricted check.<br>• Pipelines are filtered only when the team has `pipelineTypes`. | Company-wide weighted pipeline and forecast deltas (MNPI for a NASDAQ issuer) reach any user with direct reports, whatever their role. | Build the digest per recipient from live deals with `dealAccessWhere`. Exclude restricted deals from `pipeline_snapshots`, or store them separately. |

### Medium

| ID | Title | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|
| **M-1** | Lookup actions reveal restricted account names and existence | `commissions/actions.ts:147-182` (`checkRegistration`/`conflictsFor`); `accounts/actions.ts:30-65` (`findDuplicates`/`checkAccountDuplicates`, also in `createAccount`:107 and `updateAccount`:132 error text); `deals/actions.ts:177-182` (`createDeal` accountId path uses `ownedEntityWhere` without the restricted check and returns `accountName`); `accounts/actions.ts:76,134` + `accounts/queries.ts:206-208` (`parentId` pointing at a restricted account shows its name/domain); `contacts/actions.ts:45-58` (`emailTaken` returns any contact's name) | **LIVE** (server actions called directly with a `Next-Action` header):<br>• commission_rep: `checkRegistration({domain:"arenagroup.com"})` returned `accountName:"Arena Group (Paradium.AI)"` plus "an open deal exists".<br>• commission_rep: `checkRegistration({accountId:<Paradium UUID>})` returned `"Paradium.AI Inc."`, `thearenagroup.net`.<br>• intern: `checkAccountDuplicates({domain:"arenagroup.com"})` returned the restricted account's id and name.<br>• Other paths: CODE. | Anyone who can guess a domain can confirm that a company is a restricted MNPI target and learn its name. Given a UUID, they also learn any account's name, even with accounts scope "own". | When the account is not visible (`accountVisibilityWhere` / `canSeeRestricted`), return `{exists:true}` with no name or id. Validate `accountId`/`parentId` with `getVisibleAccount`. |
| **M-2** | Access expiry and domain removal are enforced only at session creation | `src/lib/auth/index.ts:73-77,99-113`; `src/lib/rbac/server.ts:34-38` | **CODE.**<br>• `accessExpiresAt` and the domain allowlist are checked only in `session.create.before`.<br>• Sessions slide (12h `expiresIn`, `updateAge` 1h).<br>• `getCurrentUser` checks only `banned`.<br>• `accessExpiresAt` is read nowhere else. | A contractor or intern past their end date keeps access for as long as they stay active. Removing a domain from `allowed_domains` doesn't cut off existing sessions. | In `getCurrentUser`, return null when `accessExpiresAt < now` or the domain is no longer allowed. Have the sweep cron revoke sessions of expired users. |
| **M-3** | Copilot contact search and `get_account` ignore restricted accounts and deals | `copilot/queries.ts:54-56,194-200` (`contactWhere` = `ownedEntityWhere` only, joins account name); `:460-465` (open tasks by `accountId`, no deal filter) | **CODE.** The UI search uses `contactVisibilityWhere`; Copilot does not. | `search_records("arena")` returns contact names, titles and emails plus the restricted account name. Task titles on restricted deals also leak. | Use `contactVisibilityWhere`. Add the deal-visibility filter on tasks. |
| **M-4** | Transcripts linked only to a restricted account are visible to team/all calls scope | `src/lib/transcripts/queries.ts:15-24`; auto-linking at `transcripts/ingest.ts:85-100` | **CODE.** The filter checks deal visibility when `dealId` is set but never checks `accounts.restricted` or the access list. | Execs, sales leaders and admins can read full restricted-account call transcripts and AI analysis. | Add the account restricted and access-list clause (as in `accountVisibilityWhere`). |
| **M-5** | Approval notifications reveal restricted deal names | `approvals/service.ts:40-47` (from `deals/stage-service.ts:131-138`); `proposals/actions.ts:48-52` | **CODE.** Every approver-role and executive user is notified with `Stage approval: ${deal.name}` or `Proposal approval: ${dealName}`, without `filterRecipientsForDeal`. `requestProbabilityOverride` (`deals/actions.ts:638`) does filter. | MNPI deal names reach users who are not on the access list. | Filter recipients with `filterRecipientsForDeal`, or use a generic title for restricted deals. Apply the same to `reassignAlert` (`alerts/actions.ts:83-98`, suspected). |
| **M-6** | Enrichment run page shows staged contacts of restricted accounts | `scout/queries.ts:119-127,183-193`; `app/(app)/scout/runs/[id]/page.tsx:24-73` | **CODE.** `runScopeWhere` gates only on enrichment/scout scope. The page masks the title but renders each staged contact's name, title, email and LinkedIn. | People targeted at a restricted account are revealed, and the email domains identify the company. | Join accounts and apply the restricted and access-list check in `runScopeWhere`/`getRunDetail`. |
| **M-7** | Analytics snapshot trend and week-ago tiles include restricted deals | `src/lib/analytics/executive.ts:329-360` | **CODE.** Gated only on `ctx.orgWide` (analytics = all: executive, admin, finance, viewer). Snapshots include restricted deals (H-4). Current restricted deals carry no value, so there is no leak today. | Restricted values show in the trend line, and also as the gap between the live tile (which excludes them) and the snapshot. | Exclude restricted deals from snapshots, or show the trend only to super_admin. |
| **M-8** | `setSplits` lets a deal editor add themselves (and re-weight others) without assign permission | `src/lib/deals/actions.ts:362-380` | **CODE.** `newcomers` filters out `user.id`, so the caller skips `assign`. Percentages and removals need only edit scope. Splits drive commission recipients (`commissions/engine.ts:233-236`). | An AE (deals edit = team) can put themselves at up to 100% on a teammate's deal. That diverts commission accruals and grants them "own" access. | Require `assign` (checked with `inScope`) for any membership or percentage change, including self. Lock splits on won deals. |
| **M-9** | Self-approval: `decideProposal` and `decideRegistration` have no separation of duties | `proposals/actions.ts:116-146`; `commissions/actions.ts:232-240` + `registration-service.ts:16-53` | **CODE.** Only `assertCan(...approve/assign, "all")` is checked. There is no `createdBy`/`requestedBy !== user.id` check. The generic `approvals/registry.ts:49` path does enforce this. | An executive can approve their own out-of-guardrail proposal. A sales leader or admin can register a lead, approve it themselves and take ownership of an account. | Route both through `approvals/service.decide()`, or add the requester check (except super_admin). |
| **M-10** | Copilot prompt-injection autonomy cap resets on every request; history is client-supplied | `app/api/copilot/route.ts:112-140`; `copilot/guards.ts:47-52`; `copilot/service.ts:98-110` | **CODE.**<br>• `untrustedSeen` is created fresh on each POST.<br>• Earlier `<untrusted>` tool output is replayed from client-sent history.<br>• The client can forge assistant or tool parts. | An injection planted in turn 1 (email or web content) can trigger auto-level `create_task` in turn 2. Default `task_from_commitment` is 2. This breaks §11.5. | Mark the run untrusted if any history message contains tool parts or `<untrusted>`. Better: keep run state server-side and reject client-supplied tool results. |
| **M-11** | Inbound email AI auto-writes deal next-step and tasks; some attacker fields are not wrapped in `untrusted()` | `gmail/analyze.ts:117-156`; `admin/settings-registry.ts:58,62`; unwrapped fields at `gmail/analysis-core.ts:245` (subject, sender name), `transcripts/analysis-core.ts:295` (title), `deals/summary.ts:50` (activity subjects) | **CODE.** | A crafted external email can set `nextStep`/`nextStepDueAt` and create tasks, which feed health and alerts. External content should be capped at "suggest" (§11.5). | Force suggest-only for inbound-derived writes. Wrap subject, sender and title in `untrusted()`. |
| **M-12** | Google OAuth refresh tokens (gmail.send and readonly scopes) stored in plaintext | `src/db/schema.ts:187`; `src/lib/auth/index.ts` (no `account.encryptOAuthTokens`) | **CODE + SQL.** Currently 0 Google account rows (only 7 credential rows), so nothing is exposed yet. Better Auth 1.7.6 supports `encryptOAuthTokens`. | Once Gmail is connected, a DB or backup leak grants send and read access to every connected mailbox. Inconsistent with rule 6. | Set `account: { encryptOAuthTokens: true }` before connecting the first mailbox. |
| **M-13** | XLSX/CSV import has no decompressed-size or row cap (zip bomb / memory DoS) | `lib/import/server.ts:13,24-35`; `lib/import/workbook.ts:34-38`; `api/scout/parse-domains/route.ts:26-36` | **CODE.** Only the compressed size is limited (15 MB, or 2 MB for parse-domains). `exceljs` `load()` inflates everything, and every row is materialised before any cap. | Any importer, or anyone with `scout:create`, can exhaust a function's memory or CPU with a small crafted file. | Use the streaming `WorkbookReader` with row and column caps. Reject when the sum of uncompressed entry sizes is too large. Add `MAX_ROWS` to the CSV path. |
| **M-14** | Reps can set the R100 bonus (the commission base) on their own deals | `r100/actions.ts:31-57`; `commissions/engine.ts:292-310` | **CODE.** `bonusCents` (up to $1M), `bonusEligible` and `firstPostDate` are gated only by `deals_R100` edit (own for intern/sdr/ae, all for editorial). | Reps inflate their own `r100_live` accruals. Finance approval is the only safeguard. | Restrict these fields to `commissions:configure`, or treat them as hidden fields for sales roles. |
| **M-15** | Better Auth `useSecureCookies` depends on `NODE_ENV`, and dev accounts with a published password (including `super_admin`) live in the same DB as real business data | `src/lib/auth/index.ts:55-58,80`; `src/lib/env.ts:15`; `scripts/seed.ts:18,254-260` | **SQL + CODE.** Seven `dev.*` users exist in `rso.user`, including `dev.superadmin@roundtable.io` (super_admin), with credential rows. Password login is correctly hard-off when `NODE_ENV=production`. However, any deployment or `next start`/`next dev` run against this DB with `ALLOW_DEV_LOGIN=true` exposes a super_admin whose password is in git. | Full MNPI access for anyone with repo read access, if dev login is ever reachable against this database (for example a staging or preview misconfiguration, or a tunnelled dev server). | Run `npm run db:purge-dev` (or ban the dev users) on the shared DB. Use a separate dev database. Generate dev passwords per machine instead of committing one. |

### Low

| ID | Title | Location | Evidence / notes | Fix |
|---|---|---|---|---|
| L-1 | `/api/cron/scout` compares the secret with `!==` (not constant time) | `app/api/cron/scout/route.ts:20-21` | CODE. Fails closed when unset. **LIVE:** all 6 cron routes return 401 with no auth and with `Bearer undefined`. | Use `isAuthorizedCron`. |
| L-2 | Import `commit`/`preview`/`parse` have no Origin check (they rely on SameSite=Lax) | `app/api/import/commit/route.ts:9-14`, `preview`, `parse` | CODE. Integrations routes use `sameOrigin()`. The residual risk is a same-site sibling subdomain. | Add `sameOrigin(req)`. |
| L-3 | Transcripts can be attached to deals the user can only view | `app/api/integrations/transcripts/route.ts:76-78`; `gmail/actions.ts:140-160`; `transcripts/actions.ts:31-39` | CODE. Uses `"view"`, not `"edit"`. | Require edit scope. |
| L-4 | Copilot caps can be bypassed by concurrency; no input-size cap; `web_research` Apify spend is uncounted and the token is in the URL | `app/api/copilot/route.ts:92-132`; `copilot/rate-limit.ts:34`; `copilot/service.ts:217-247` | CODE. The hourly cap counts `agent_runs` rows, which are only inserted at the end of the stream. The token bucket is per instance. | Insert a pending row up front. Cap characters. Count web research. Send the token as a Bearer header. |
| L-5 | Scout budget check-then-insert race | `scout/service.ts:24-40`; `scout/budget.ts:67-90` | CODE. Bounded per run by `maxTotalChargeUsd`. | Use an advisory lock per user. |
| L-6 | Zoom download follows redirects with the Bearer token; the allowlist is checked only on the first hop; the body is buffered before the size check | `transcripts/zoom.ts:42-52` | SUSPECTED (undici strips auth on cross-origin redirects). | Use `redirect:"manual"`, re-validate each hop, stream with a byte cap. |
| L-7 | Full error objects are logged (Drizzle errors include SQL params, i.e. PII) | `app/api/import/shared.ts:52`; `lib/actions.ts:25`; `copilot/tools.ts:23`; `alerts/engine.ts:1005` | CODE. No secrets logged. | Log `e.name` plus a truncated message. |
| L-8 | AES-GCM decrypt accepts short tags; no AAD | `src/lib/crypto.ts:21-27` | CODE. | Set `authTagLength:16` and check the tag length. Use AAD = `provider:userId`. |
| L-9 | Accounts/contacts CSV export includes restricted rows for users on the access list | `app/api/import/export/route.ts:40-62` | **LIVE:** exec export had 8,577 rows and 0 restricted, which is correct. Super_admin export contains both Arena/Paradium rows. The deals export drops restricted rows (`deals/actions.ts:729`). AUD-3 says "export blocked". | Filter restricted rows out of exports. |
| L-10 | Claims guardrail gaps | `claims-core.ts:15`; `gmail/actions.ts:60 vs 98-100`; `proposals/actions.ts:149-160` | CODE. Plain substring matching (zero-width or spacing bypass). The signature is appended after the check. `scanMnpi` is not run on manual send. Proposals are never checked. Admin regexes can be ReDoS'd. Block mode **is** enforced server-side in `sendEmail` (AT-08 holds). | Normalize text before matching. Check the final body. Check proposals. Apply a regex timeout or a safe-regex check. |
| L-11 | `setR100Stage` bypasses the stage service | `r100/actions.ts:59-99` | CODE. Skips gate fields, won/lost reasons and won automation. **SQL:** no R100 stage currently has `requires_approval`, so the approval bypass is latent. | Call `moveDealToStage`. |
| L-12 | Contacts of restricted accounts are reachable via deal paths | `deals/stage-service.ts:65-73`; `deals/actions.ts:769-778` | CODE / SUSPECTED (depends on the data). | Use `contactVisibilityWhere`. |
| L-13 | Account owner can be nulled or set without `assign` | `accounts/actions.ts:75,111,135` (`optText` turns an omitted value into null) | CODE. | Treat an omitted field as unchanged. Require `assign` for any owner change. |
| L-14 | Reassign checks `assign` by rank only, not against the record | `deals/actions.ts:96-99,274-276` | CODE. Harmless with the default matrix. | `inScope(assignScope, record)`. |
| L-15 | `requestMoreBudget` has no permission check; `previewSearchRun` has no ownership check | `scout/actions.ts:117-163` | CODE. Enables approval and notification spam. | `assertCan(scout, create)` plus an owner check. |
| L-16 | `"pipeline"` scope with no team pipelines means everything | `rbac/server.ts:114-115,166` | CODE. A sales_leader with no team sees all ENT deals. | Treat empty `teamPipelineKeys` as "own". |
| L-17 | Onboarding `ownerId` is set without `assign`; `linkContactToDeal` doesn't check the contact's account | `onboarding/actions.ts:53-65`; `contacts/actions.ts:110-124` | CODE. | Add the checks. |
| L-18 | Restricted deals still trigger alerts (labelled "Restricted deal") revealing existence, health and override %; `meeting_prep` writes `prepBrief` without confirmation | `alerts/engine.ts:201-202,404-423`; `copilot/service.ts:354-358` | CODE. | Suppress for non-access-list recipients. Require a click to save the brief. |
| L-19 | No Content-Security-Policy; URLs from imports/Apify rendered as `href` without scheme validation | `next.config.ts:3-9`; `accounts/[id]/page.tsx:409,523`; `r100-table.tsx:288,397`; `staged-contacts.tsx:114`; `copilot/tool-parts.tsx:183`; `onboarding-view.tsx:321,326` | **LIVE** headers: XFO DENY, nosniff, HSTS, Referrer-Policy and Permissions-Policy present; CSP absent. React 19.2.8 neutralises `javascript:` hrefs, so this is defence in depth. | Add a CSP (nonce-based `script-src`, `frame-ancestors 'none'`). Validate `https?:` at ingest. |
| L-20 | DB least privilege: `rso_app` owns all 56 tables (so it can run DDL, DROP and TRUNCATE) and has `CREATE` on the database | Supabase | **SQL:** `tableowner = rso_app`, `has_database_privilege(rso_app, CREATE) = true`. | Use a separate owner/migration role. Grant the runtime role DML only. Revoke `CREATE` on the database. |

### Info

- **I-1 agent_runs stores MNPI in plaintext.** Stored content includes Copilot text (up to 4 KB), full email and transcript analysis, tool inputs, and the last user message (`ai.ts:55,68`, `copilot/route.ts:123-131`). No UI reads raw rows. Consider retention limits or encryption.
- **I-2 Inconsistent policy on sending restricted content to the LLM.** `deals/summary.ts:21` withholds AI for restricted deals, but email analysis, transcript analysis and Copilot (for access-list users) send it to the AI gateway. Choose one policy and enforce it in `aiObject`/`aiText`.
- **I-3 `deal.*` admin override is ignored.** `stripHidden` and the deal/Copilot DTOs ignore it; only proposals honour `*`.
- **I-4 `npm audit --omit=dev`: 6 moderate, 0 high, 0 critical.**
  - `exceljs` → `uuid` <11.1.1 (GHSA-w5hq-g745-h8pq; the app doesn't pass `buf`, so not reachable).
  - `drizzle-kit` → `@esbuild-kit` → `esbuild` ≤0.24.2 (GHSA-67mh-4wv8-2f99; dev server only).
  - No SheetJS `xlsx` dependency.

## 3. Verified secure (coverage)

**Authentication**
- All 51 pages under `src/app/(app)` sit behind `(app)/layout.tsx:11` `requireUser()`, and every data-loading page calls `requireUser()` itself or via `analytics/page.ts:10`.
- The proxy redirects cookieless requests to sign-in.
- `action()` rejects signed-out and `pending` users.
- Every route handler checks the session and blocks `pending`. **LIVE:** anonymous requests get 401 from `/api/search`, `/api/import/export` and `/api/scout/runs/:id`, and 307 from `/commissions/export` and `/admin/audit/export`.
- Dev email/password login is hard-disabled when `NODE_ENV=production` (`env.ts:15`), and sign-up is disabled with it.
- The domain allowlist is enforced server-side on user create and on session create.
- Banned users are blocked by the Better Auth admin plugin's session hook and by `getCurrentUser`.
- **LIVE:**
  - Sign-in is rate-limited (429 after bursts).
  - Cross-origin sign-in returns 403.
  - Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in prod (`useSecureCookies: isProd`).
  - `update-user {role}` returns `FIELD_NOT_ALLOWED`.
  - A non-admin gets 403 on `/api/auth/admin/*`.

**Cron and webhooks**
- `isAuthorizedCron` and `sync-email` use `timingSafeEqual` and fail closed (LIVE 401 on all 6 routes).
- Zoom webhook: HMAC over `v0:ts:rawBody`, constant-time compare, 300s skew window, URL validation also signed, 503 when unconfigured (LIVE).
- Apify webhook: per-step random secret, stored as SHA-256, constant-time compare. Status and cost are re-fetched from Apify rather than trusted from the body (LIVE 400 on a bogus request).

**Record authorization (LIVE)**
- Intern and commission_rep get a 404 on another user's NET deal. sdr, exec and finance can open it, which matches the matrix.
- The restricted Arena deal and both restricted accounts return 404 for every role except super_admin, including exec, svp and finance.
- An intern cannot open their *own* restricted deal without being on the access list.
- `/api/search?q=Paradium` returns no hits for intern and exec, and 3 for super_admin.
- Intern gets "No access" on `/revenue`, `/proposals`, `/onboarding` and `/admin/*`, and 404 on `/import`.
- Intern and commission_rep get 403 on `/api/import/export` and `/admin/audit/export`.

**Field-level security (LIVE)**
- As intern, on an owned `[test] sec` deal with `revSharePct=0.4321`, guarantee $9,876.54, `guaranteeType` and `termYears=3.7`: none of the values appear in the HTML or RSC payload of `/deals/:id` (the fields are `$undefined`), `/pipelines/NET` or `/home`.
- `proposal.*` hiding is enforced in `proposalWhere`/`assertProposalDeal` (AT-02).

**Server actions (CODE)**
- All 28 `"use server"` files export only `action()` wrappers.
- Deal writes go through `loadDealForWrite` (`dealAccessWhere` + `assertCan` + `inScope`).
- Other areas with scope and restricted checks: revenue, onboarding, proposals, tasks, contacts, scout candidates/enrichment, and imports/rollback.
- Notifications are filtered to self.
- Commission accruals: `accrualScopeWhere` is ANDed with any `userId` filter, so a rep cannot read others' accruals or statements.
- `decideApproval` enforces separation of duties, and sdr cannot decide any approval kind.
- In-app user management blocks self role changes and requires super_admin for privileged roles (undermined by H-1).

**CSRF**
- Next server actions enforce Origin. **LIVE:** a cross-origin `Next-Action` POST is rejected (HTTP 500 from the origin check; nothing executed).
- The integrations routes check `sameOrigin`.

**Injection**
- `sql.raw` and `sql.identifier` are used only with constants.
- `ilike` input is escaped for `%` and `_`.
- There is no `dangerouslySetInnerHTML`, `innerHTML`, `srcDoc`, iframe or rehype-raw.
- Emails and transcripts render as text.
- The Copilot markdown parser allowlists http, https, mailto and relative links.
- Every CSV export neutralises `= + - @ \t \r`.
- The Gmail MIME builder strips CR/LF from headers, validates To/Cc with `z.email()`, and base64-encodes the body.

**SSRF**
- Every outbound fetch goes to a fixed host: `api.apify.com`, `public-api.granola.ai`, `googleapis`, or `zoom.us` (allowlisted, https-only).
- Apify IDs are regex-validated.
- Web scraping runs inside Apify, not on this server.

**Secrets**
- `git log -p --all` (32 commits) contains no API keys, tokens, private keys or DB passwords. The only credential is the documented dev seed password (see M-15).
- `.env*` files are gitignored; only `.env.example` is tracked, and it has blank values.
- `ENCRYPTION_KEY`: AES-256-GCM, random 12-byte IV, 32-byte key, no fallback.
- Granola, Zoom and Apify secrets are stored encrypted, and audit entries record them masked.
- Secret-bearing saves go through route handlers, and `logging.serverFunctions: false`.

**AI**
- External email, transcript and web content, account notes and summaries are wrapped in `untrusted()` (exceptions in M-11).
- Copilot cannot send email (drafts only).
- Stage changes are suggest-only and re-checked on click.
- Out-of-scope lookups are denied and audited (AT-07 holds for deals).

**Supabase (SQL)**
- The app runs as `rso_app`, which is not a superuser and has no `BYPASSRLS`.
- `has_schema_privilege` for `anon`, `authenticated` and `public` on `rso` is false.
- Zero table grants to `anon`, `authenticated`, `PUBLIC` or `service_role`.
- RLS is enabled on all 56 tables with 0 policies.
- `rso_app` has no usage on the `auth` or `storage` schemas and no `CREATE` on `public`.

## 4. Residual risks and notes

- **H-1 was not executed end to end,** because there is no `admin`-role test account and changing roles on real rows is out of bounds. It is proven by code trace plus a runtime evaluation of the configured access-control role. Re-test after the fix: sign in as an admin, POST `/api/auth/admin/set-role`, and expect 403.
- **Copilot findings (H-3, M-3, M-10) are code-traced only.** Copilot calls a paid, nondeterministic model, so it was not driven live.
- **Restricted deals currently carry no monetary values** (Arena ENT deal: `contract_value_cents` is null), so the aggregate leaks (H-4, M-7) are latent today. They become real as soon as values are entered.
- **RLS with no policies is not a defence** for the app role, because the owner bypasses it. All tenant and row isolation relies on application code. Any new query path that skips the visibility helpers repeats H-2 or H-3. Consider a lint rule or a DB view layer for restricted filtering.
- **In-memory rate limits** (Better Auth at 120/min and the Copilot token bucket) are per instance on serverless. Use a shared store (DB or Redis) for production-grade limits.
- **Not covered:** Vercel project settings, the Google OAuth consent-screen configuration and Workspace-side controls, Supabase dashboard access, and backup encryption.
- **Cleanup:** the `[test] sec` rows (2 deals, 1 account, 1 document) were deleted and verified at 0 remaining. Cookie jars and scratch files were removed from the scratchpad.
