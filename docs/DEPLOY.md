# Deploying Roundtable Sales OS

## 1. What already exists
| Piece | Status |
|---|---|
| GitHub | `git@github.com:hossambff/rtb-crm.git`, branch `main` |
| Supabase | Project **RTBCRM** (`thjlfivbhjkgnfkquzfv`, eu-west-1). All app tables live in schema `rso`, owned by the restricted login role `rso_app`. Row-level security is on for every table. The schema isn't exposed through PostgREST, and the `anon`/`authenticated` roles have no access. |
| Migrations | `drizzle/*.sql`. Apply with `npm run db:migrate`, which also re-enables RLS on any new tables. Seed with `npm run db:seed` (idempotent). |
| Better Auth dashboard | Project "RTB CRM (Roundtable Sales OS)" was started at dash.better-auth.com. Enter the production base URL to finish connecting it (step 4). |

## 2. Link Vercel to GitHub
In the Vercel project **rtb-crm**:
1. Go to Settings → Git and connect `hossambff/rtb-crm` with production branch `main`.
2. Framework preset is Next.js. Node.js version is **22.x** or **24.x**.
3. For Functions region, choose **Dublin (dub1)**. The Supabase database is in eu-west-1.

## 3. Environment variables (Production + Preview)
| Key | Value |
|---|---|
| `DATABASE_URL` | `postgresql://rso_app.thjlfivbhjkgnfkquzfv:<password>@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`. This is the transaction pooler; the password is in the local `.env.local`. |
| `DATABASE_URL_SESSION` | Same as above but on port `5432`. Only needed if you run migrations from CI. |
| `BETTER_AUTH_SECRET` | 32+ random bytes, e.g. `openssl rand -base64 32`. Use a new value for production. |
| `BETTER_AUTH_URL` | `https://<your-domain>` |
| `NEXT_PUBLIC_APP_URL` | `https://<your-domain>` |
| `ALLOWED_EMAIL_DOMAINS` | `roundtable.io,blockchainff.com` |
| `ALLOW_DEV_LOGIN` | `false` (developer login is also hard-disabled in production builds) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From your Google Cloud OAuth client. See step 5. |
| `BETTER_AUTH_API_KEY` | The key from the Better Auth dashboard (`ba_…`) |
| `ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored Granola and Apify keys. **Never rotate it without re-encrypting those keys.** |
| `CRON_SECRET` | Random string (`openssl rand -hex 24`). Vercel Cron sends it as a Bearer token. |
| `AI_GATEWAY_API_KEY` | Optional on Vercel: deployments authenticate to the AI Gateway automatically via OIDC. |
| `AI_MODEL_FAST` / `AI_MODEL_STRONG` | Defaults are `google/gemini-2.5-flash` / `openai/gpt-5-mini` (free tier). After adding AI Gateway credits, switch to e.g. `anthropic/claude-haiku-4.5` / `anthropic/claude-sonnet-5.5`. These can also be changed in Admin → Settings. |
| `APIFY_TOKEN` | Optional. You can also paste it in Lead Scout → Settings, where it is stored encrypted. |

## 4. Better Auth dashboard
At dash.better-auth.com → project "RTB CRM (Roundtable Sales OS)":
- set Base URL to `https://<your-domain>`;
- set Base Path to `/api/auth`.

## 5. Google OAuth (sign-in + Gmail/Calendar)
In Google Cloud Console → APIs & Services, use an OAuth client in the Workspace that owns `roundtable.io`.
1. **Consent screen.** If `roundtable.io` and `blockchainff.com` are the **same** Workspace organization, set User type to **Internal**. If they are separate organizations, choose External, keep it in *Testing*, and add every user as a test user (up to 100).
2. **Scopes.** `openid email profile`, plus these for inbox monitoring:
   - `gmail.readonly`
   - `gmail.send`
   - `calendar.readonly`
3. **Enable APIs.** Gmail API and Google Calendar API.
4. **Authorized redirect URIs.**
   - `https://<your-domain>/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google`
5. Copy the client ID and secret into Vercel.

## 6. First sign-in
The **first user ever** to sign in becomes `super_admin`. Everyone after that lands on "pending" until an admin assigns a role in **Admin → Users**.
- **Pre-provisioning.** Admin → Users → "Add user" with role, team and employment type. The user then signs in with Google.
- **Placeholder reps from the spreadsheet import.** Accounts like "Chris (placeholder)" are banned `*.placeholder@roundtable.invalid` users. Use Admin → Users → **Claim placeholder** to move their deals and tasks to the real account.
- **Dev accounts.** Before go-live, delete the seeded `dev.*` accounts: Admin → Users → deactivate, or `npm run db:purge-dev`.

## 7. Cron jobs (vercel.json)
All schedules are **daily** so the project deploys on Vercel Hobby (Hobby rejects deployments with more frequent
crons). Times are UTC. Every route requires `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends it).

| Path | Schedule (Hobby) | Recommended on Pro | What it does |
|---|---|---|---|
| `/api/cron/scout` | `0 5 * * *` | daily | Scheduled Lead Scout searches; resumes stalled runs |
| `/api/cron/sweep` | `0 6 * * *` | `0 * * * *` (hourly) or `*/15 * * * *` | Nothing-Slips alert engine |
| `/api/cron/sync-email` | `30 6 * * *` | `*/10 * * * *` (every 10 min) | Gmail, Calendar and Granola sync, email analysis |
| `/api/cron/commissions` | `0 7 * * *` | daily | Commission accruals, clawbacks, registration expiry |
| `/api/cron/digest` | `0 12 * * *` | daily | "My Day" and manager digests |
| `/api/cron/snapshot` | `55 23 * * *` | daily | Pipeline snapshots |

**In-app fallback (Hobby).** Because the sweep and inbox sync only run once a day on Hobby, opening **My Day**
(`/home`) triggers a background catch-up after the page is sent (`after()` from `next/server`, non-blocking):
the sweep runs if the last one (`app_settings` key `alerts.last_sweep_at`) is older than 60 minutes, and the
signed-in user's own Gmail/Calendar/Granola sync runs if nothing synced for them in the last 15 minutes. Each job
is claimed atomically in `app_settings`, so concurrent page loads don't run it twice. Admins can also run the sweep
from Admin → Alerts. On Pro, switch `sweep` to hourly and `sync-email` to every 10 minutes in `vercel.json`.

## 8. Zoom (optional)
1. Create a Zoom **Server-to-Server OAuth** or **General** app with the event `recording.transcript_completed`.
2. Set the webhook URL to `https://<your-domain>/api/webhooks/zoom`.
3. Paste the Secret Token in Settings → Connections → Zoom (admin).

## 9. Every-5-minutes tick (V2) — Supabase pg_cron
Vercel Hobby crons are daily, so Supabase drives `/api/cron/tick` (sequences, meeting briefs, approval SLAs, handoff
escalation, win/loss story prompts). Configured on 1 Oct 2026 (job `rtb-tick`, `*/5 * * * *`): the scheduler secret is
generated inside Postgres and stored in Vault (`rtb_tick_secret`); the app only stores its sha256 in
`rso.app_settings` (`tick.secret_sha256`), so the plaintext never leaves the database. To rotate: create a new vault
secret and update the hash with `encode(digest(<secret>, 'sha256'), 'hex')`. Inspect runs with
`select * from cron.job_run_details order by start_time desc limit 10;` and `select * from net._http_response order by created desc limit 10;`.
