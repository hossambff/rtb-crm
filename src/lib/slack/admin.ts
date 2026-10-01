import "server-only";
import { z } from "zod";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { integrationConnections } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { requireAdmin } from "@/lib/admin/guard";
import { audit } from "@/lib/audit";
import { encryptSecret, maskSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import type { AppUser } from "@/lib/rbac/server";
import { activeUserWhere } from "@/lib/users";
import { textMessage } from "./blocks";
import { slackCall } from "./client";
import { normalizeChannel, validateBotToken, validateSigningSecret } from "./core";
import { getSlackRow, readSecrets, type SlackOrgConfig } from "./config";

export const credentialsInput = z.object({
  botToken: z.string().max(300).optional().default(""),
  signingSecret: z.string().max(100).optional().default(""),
});

/**
 * Save (or rotate) the bot token and/or signing secret. Blank fields keep the stored value. The token is verified
 * with auth.test before anything is stored, which also records the workspace identity used to reject requests from
 * other workspaces. Secrets are AES-GCM encrypted; only masks are ever returned or audited.
 */
export async function saveSlackCredentials(user: AppUser, input: z.infer<typeof credentialsInput>): Promise<{ teamName: string | null }> {
  await requireAdmin(user);
  const row = await getSlackRow();
  const prev = readSecrets(row?.secretEncrypted) ?? { botToken: "", signingSecret: "" };
  const botToken = input.botToken.trim() || prev.botToken;
  const signingSecret = input.signingSecret.trim() || prev.signingSecret;
  const tokenErr = validateBotToken(botToken);
  if (tokenErr) throw new UserError(tokenErr);
  const secretErr = validateSigningSecret(signingSecret);
  if (secretErr) throw new UserError(secretErr);

  const who = await slackCall<{ team_id?: string; team?: string; user_id?: string; bot_id?: string }>(botToken, "auth.test", {}, { timeoutMs: 5000 });
  if (!who.ok) {
    if (who.error === "invalid_auth" || who.error === "not_authed" || who.error === "account_inactive" || who.error === "token_revoked")
      throw new UserError("Slack rejected this token. Copy the Bot User OAuth Token again from OAuth & Permissions.");
    throw new UserError(`Couldn't reach Slack to verify the token (${who.error}). Try again.`);
  }
  if (!who.bot_id) throw new UserError("This token isn't a bot token. Use the Bot User OAuth Token (xoxb-).");
  const prevConfig = (row?.config ?? {}) as SlackOrgConfig;
  if (prevConfig.teamId && who.team_id && prevConfig.teamId !== who.team_id) {
    // Switching workspaces invalidates every stored Slack member ID mapping.
    await db.update(s.userPrefs).set({ slackUserId: null }).where(isNotNull(s.userPrefs.slackUserId));
  }
  const config: SlackOrgConfig = {
    ...prevConfig,
    teamId: who.team_id ?? null,
    teamName: who.team ?? null,
    botUserId: who.user_id ?? null,
    botTokenMasked: maskSecret(botToken),
    signingSecretSet: true,
    connectedAt: prevConfig.connectedAt && row?.status === "connected" ? prevConfig.connectedAt : new Date().toISOString(),
  };
  const patch = { status: "connected", secretEncrypted: encryptSecret(JSON.stringify({ botToken, signingSecret })), config: config as Record<string, unknown>, lastError: null, updatedAt: new Date() };
  if (row) await db.update(integrationConnections).set(patch).where(eq(integrationConnections.id, row.id));
  else await db.insert(integrationConnections).values({ userId: null, provider: "slack", ...patch });
  await audit({
    actorId: user.id,
    action: "integration.slack_saved",
    entity: "integration",
    entityId: "slack",
    before: row ? { teamId: prevConfig.teamId ?? null, botTokenMasked: prevConfig.botTokenMasked ?? null } : null,
    after: { teamId: config.teamId, teamName: config.teamName, botTokenMasked: config.botTokenMasked, tokenRotated: Boolean(input.botToken.trim()), secretRotated: Boolean(input.signingSecret.trim()) },
  });
  return { teamName: config.teamName ?? null };
}

const channelField = z.string().trim().max(90).optional().default("");

export const channelsInput = z.object({
  alertsChannel: channelField,
  winsChannel: channelField,
  digestChannel: channelField,
  digestEnabled: z.boolean().default(false),
  dealChannels: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,20}$/), channelField).default({}),
});

export async function saveSlackChannels(user: AppUser, input: z.infer<typeof channelsInput>): Promise<void> {
  await requireAdmin(user);
  const row = await getSlackRow();
  if (!row) throw new UserError("Connect Slack first.");
  const errors: string[] = [];
  const norm = (label: string, v: string) => {
    const r = normalizeChannel(v);
    if ("error" in r) {
      errors.push(`${label}: ${r.error}`);
      return null;
    }
    return r.value;
  };
  const dealChannels: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.dealChannels)) {
    const c = norm(`${k} deal channel`, v);
    if (c) dealChannels[k] = c;
  }
  const next = {
    alertsChannel: norm("Alerts channel", input.alertsChannel),
    winsChannel: norm("Wins channel", input.winsChannel),
    digestChannel: norm("Digest channel", input.digestChannel),
    digestEnabled: input.digestEnabled,
    dealChannels,
  };
  if (errors.length) throw new UserError(errors[0]!);
  if (next.digestEnabled && !next.digestChannel) throw new UserError("Pick a channel for the daily digest, or turn it off.");
  const before = (row.config ?? {}) as SlackOrgConfig;
  await db
    .update(integrationConnections)
    .set({ config: { ...before, ...next }, updatedAt: new Date() })
    .where(eq(integrationConnections.id, row.id));
  await audit({
    actorId: user.id,
    action: "integration.slack_channels_saved",
    entity: "integration",
    entityId: "slack",
    before: { alertsChannel: before.alertsChannel, winsChannel: before.winsChannel, digestChannel: before.digestChannel, digestEnabled: before.digestEnabled, dealChannels: before.dealChannels },
    after: next,
  });
}

/** Disconnect: drop the stored secrets (status revoked). Everything Slack becomes a no-op again. */
export async function disconnectSlack(user: AppUser): Promise<void> {
  await requireAdmin(user);
  const row = await getSlackRow();
  if (!row) return;
  await db
    .update(integrationConnections)
    .set({ status: "revoked", secretEncrypted: null, config: { ...(row.config ?? {}), botTokenMasked: null, signingSecretSet: false }, updatedAt: new Date() })
    .where(eq(integrationConnections.id, row.id));
  await audit({ actorId: user.id, action: "integration.slack_disconnected", entity: "integration", entityId: "slack" });
}

/** Post a test message to `target` (a configured channel key) or DM the admin. Returns a human result line. */
export async function sendSlackTest(user: AppUser, target: "alerts" | "wins" | "digest" | "me"): Promise<string> {
  await requireAdmin(user);
  const row = await getSlackRow();
  const secrets = readSecrets(row?.secretEncrypted);
  if (!row || row.status === "revoked" || !secrets?.botToken) throw new UserError("Connect Slack first.");
  const cfg = (row.config ?? {}) as SlackOrgConfig;
  let channel: string | null = null;
  if (target === "me") {
    const { slackIdForUser } = await import("./identity");
    channel = await slackIdForUser(user.id, secrets.botToken);
    if (!channel) throw new UserError(`No Slack member found for ${user.email}. Your Slack email must match your Roundtable email.`);
  } else {
    channel = target === "alerts" ? (cfg.alertsChannel ?? null) : target === "wins" ? (cfg.winsChannel ?? null) : (cfg.digestChannel ?? null);
    if (!channel) throw new UserError("Set that channel first.");
  }
  const msg = textMessage(`Roundtable is connected. Test sent by ${user.name}.`);
  const res = await slackCall(secrets.botToken, "chat.postMessage", { channel, text: msg.text, blocks: msg.blocks });
  if (!res.ok) {
    const hint: Record<string, string> = {
      channel_not_found: "Channel not found. Use the channel ID, or check the name.",
      not_in_channel: "The bot isn't in that channel. In Slack, type /invite @YourBot in the channel.",
      missing_scope: "The Slack app is missing a scope (needs chat:write). Reinstall the app after adding it.",
      invalid_auth: "Slack rejected the token. Save a fresh Bot User OAuth Token.",
    };
    throw new UserError(hint[res.error] ?? `Slack said: ${res.error}`);
  }
  await db.update(integrationConnections).set({ config: { ...cfg, lastTestAt: new Date().toISOString() }, updatedAt: new Date() }).where(eq(integrationConnections.id, row.id));
  await audit({ actorId: user.id, action: "integration.slack_test", entity: "integration", entityId: "slack", after: { target } });
  return target === "me" ? "Sent you a DM." : `Posted to ${channel}.`;
}

export async function mapSlackUsers(user: AppUser): Promise<{ checked: number; mapped: number; notFound: number; remaining: number }> {
  await requireAdmin(user);
  const row = await getSlackRow();
  const secrets = readSecrets(row?.secretEncrypted);
  if (!row || row.status === "revoked" || !secrets?.botToken) throw new UserError("Connect Slack first.");
  const { autoMapUsers } = await import("./identity");
  const r = await autoMapUsers(secrets.botToken);
  await audit({ actorId: user.id, action: "integration.slack_users_mapped", entity: "integration", entityId: "slack", after: r });
  return r;
}

/* ───────────── Admin page view model (no secrets) ───────────── */

export type SlackAdminView = {
  connected: boolean;
  status: string | null;
  teamName: string | null;
  botTokenMasked: string | null;
  signingSecretSet: boolean;
  connectedAt: string | null;
  lastTestAt: string | null;
  channels: { alertsChannel: string; winsChannel: string; digestChannel: string; digestEnabled: boolean; dealChannels: Record<string, string> };
  pipelines: { key: string; name: string; color: string }[];
  people: { total: number; mapped: number; dmOn: number };
  urls: { interactions: string; commands: string };
  encryptionReady: boolean;
};

export async function getSlackAdminView(): Promise<SlackAdminView> {
  const [row, pipelines, people] = await Promise.all([
    getSlackRow(),
    db.select({ key: s.pipelines.key, name: s.pipelines.name, color: s.pipelines.color }).from(s.pipelines).where(eq(s.pipelines.active, true)).orderBy(asc(s.pipelines.sortOrder)),
    db
      .select({
        total: sql<number>`count(*)::int`,
        mapped: sql<number>`count(${s.userPrefs.slackUserId})::int`,
        dmOn: sql<number>`count(*) filter (where ${s.userPrefs.slackDm})::int`,
      })
      .from(s.user)
      .leftJoin(s.userPrefs, eq(s.userPrefs.userId, s.user.id))
      .where(and(activeUserWhere)),
  ]);
  const cfg = (row?.config ?? {}) as SlackOrgConfig;
  const secrets = readSecrets(row?.secretEncrypted);
  const base = env.appUrl.replace(/\/$/, "");
  return {
    connected: Boolean(row && row.status !== "revoked" && secrets?.botToken && secrets.signingSecret),
    status: row?.status ?? null,
    teamName: cfg.teamName ?? null,
    botTokenMasked: secrets?.botToken ? (cfg.botTokenMasked ?? null) : null,
    signingSecretSet: Boolean(secrets?.signingSecret),
    connectedAt: cfg.connectedAt ?? null,
    lastTestAt: cfg.lastTestAt ?? null,
    channels: {
      alertsChannel: cfg.alertsChannel ?? "",
      winsChannel: cfg.winsChannel ?? "",
      digestChannel: cfg.digestChannel ?? "",
      digestEnabled: Boolean(cfg.digestEnabled),
      dealChannels: cfg.dealChannels ?? {},
    },
    pipelines,
    people: people[0] ?? { total: 0, mapped: 0, dmOn: 0 },
    urls: { interactions: `${base}/api/slack/interactions`, commands: `${base}/api/slack/commands` },
    encryptionReady: Boolean(process.env.ENCRYPTION_KEY),
  };
}
