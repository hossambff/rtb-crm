# Slack setup — Roundtable Sales OS

Slack is optional. Until an admin connects it, every Slack code path is a no-op (notifications stay in-app,
approvals are decided in the app, `/api/slack/*` answers 404).

What you get once it's connected:

| Feature | Where |
| --- | --- |
| DMs for interrupting notifications (the alert budget applies first) | each person opts in: Settings → Preferences → Slack DMs |
| Approve / Reject buttons on approval requests (reject asks for a reason) | DM to people who can decide |
| `/rtb deal <name>`, `/rtb approvals`, `/rtb help` (only visible to you) | any channel |
| Deal comments mirrored to a channel for each pipeline (replies stay threaded) | Admin → Slack → Channels |
| Win / loss stories from the team feed | wins channel |
| Optional daily digest (approvals waiting, yesterday's wins, new deals) | digest channel, around 08:00 New York time |

**MNPI:** restricted deals and accounts never reach Slack. Channel posts about them are skipped. DMs about them are
neutral ("a restricted record") and only link into the app. Restricted approvals can't be decided from Slack.
`/rtb deal` never returns them, even to people on the access list.

## 1. Create the Slack app (about 5 minutes, needs a Slack workspace admin)

1. Go to <https://api.slack.com/apps> → **Create New App** → **From an app manifest**, pick the workspace, and paste
   the manifest below. Replace `https://YOUR-APP` with the production URL, e.g. `https://rtb-crm.vercel.app`.
   The exact URLs are shown, with copy buttons, in **Admin → Slack**.

```yaml
display_information:
  name: Roundtable
  description: Roundtable Sales OS — alerts, approvals and deal lookups
  background_color: "#0b0b0b"
features:
  bot_user:
    display_name: Roundtable
    always_online: true
  slash_commands:
    - command: /rtb
      url: https://YOUR-APP/api/slack/commands
      description: Look up a deal or your approvals
      usage_hint: deal <name> | approvals | help
      should_escape: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - users:read
      - users:read.email
      - commands
      - im:write
settings:
  interactivity:
    is_enabled: true
    request_url: https://YOUR-APP/api/slack/interactions
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

   To set it up by hand instead:
   - **OAuth & Permissions → Bot Token Scopes:** `chat:write`, `users:read`, `users:read.email`, `commands`, `im:write`.
   - **Interactivity & Shortcuts:** on. Request URL `https://YOUR-APP/api/slack/interactions`.
   - **Slash Commands → Create New Command:** `/rtb`, Request URL `https://YOUR-APP/api/slack/commands`,
     usage hint `deal <name> | approvals | help`.
   - **App Home → Messages Tab:** on, so people can receive the bot's DMs.
2. **Install to Workspace** and approve the scopes.
3. Copy two values:
   - **OAuth & Permissions → Bot User OAuth Token** (`xoxb-…`)
   - **Basic Information → App Credentials → Signing Secret** (32 hex characters)

## 2. Connect it in Roundtable

1. **Admin → Slack**. Paste the bot token and the signing secret, then **Connect Slack**. The token is checked
   with Slack (`auth.test`) before it is saved. Both values are encrypted (AES-256-GCM, `ENCRYPTION_KEY`) and never
   shown again. To rotate one, paste only that field. Leave the other blank to keep it.
2. **Channels:** set the alerts channel, the wins channel, optional deal channels for each pipeline, and the
   optional daily digest. Channel IDs (`C0123ABCD`, from channel details) are safest. Names (`#wins`) also work.
   **Invite the bot to each channel** with `/invite @Roundtable`. Use the paper-plane buttons to send a test.
3. **People → Match by email:** links Roundtable users to Slack members with `users.lookupByEmail` (in batches of
   40, so click again if some are left). Anyone not matched yet is matched automatically the first time they use
   `/rtb` or click a button, if their Slack email is the same as their Roundtable email.
4. Ask the team to switch on **Slack DMs** in Settings → Preferences. DMs are opt-in.
5. **DM me a test** checks the whole path for your own account.

Every change is in the audit log (`integration.slack_*`).

## 3. Approval SLAs (same page)

Each approval kind has an SLA. Defaults: probability override 24 h, proposal 48 h, scout budget 24 h, stage gate
24 h, lead registration 72 h, other kinds 24 h. **Weekends don't count** pauses the clock on Saturday and Sunday.
New requests get a due date when they are created. The 5-minute tick (`/api/cron/tick`) escalates each overdue
request **once** to the next role up: executives, or super admins for executive-level requests. Only people who can
actually decide the request are notified. If none of them can, the regular approvers get an "overdue" reminder.

## Security notes

- Every inbound Slack request is verified before its body is parsed: `X-Slack-Signature` v0 (HMAC-SHA256 of
  `v0:timestamp:body` with the signing secret), a ±5-minute timestamp window, a constant-time comparison, and a
  per-instance replay guard. Requests from a different workspace (`team_id` ≠ the connected one) are ignored.
- The Slack user is mapped to a Roundtable user. The same session policy as the app applies (deactivated, expired,
  pending or disallowed-domain users are refused). Decisions go through the approvals service, so permissions,
  separation of duties ("you can't decide your own request"), side effects and the audit trail are identical to the
  app.
- Replies only ever go to `https://hooks.slack.com/…` response URLs or the Slack Web API, with a 3-second timeout.
  Tokens are never logged.
- **Disconnect** (Admin → Slack) deletes the stored credentials. Revoke the token in Slack too if it may have leaked.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Slack rejected this token" | Copy the **Bot** token (`xoxb-`), not a user (`xoxp-`) or app-level (`xapp-`) token. Reinstall the app after you change scopes. |
| Test says `not_in_channel` | `/invite @Roundtable` in that channel. |
| `/rtb` says "dispatch_failed" | Check the slash command URL, and that the deployment is reachable without Vercel authentication protection on `/api/slack/*`. |
| Buttons do nothing | Check the Interactivity request URL and the signing secret. A wrong secret shows as 401 in the logs. |
| "isn't linked to a Roundtable user" | The person's Slack email differs from their Roundtable email. Set their Slack member ID in Settings → Preferences. |
