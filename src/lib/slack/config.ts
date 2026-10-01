import "server-only";
import { cache } from "react";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Org-level Slack connection: one integration_connections row (userId null, provider "slack").
 * - secretEncrypted = AES-GCM JSON { botToken, signingSecret } (never sent to the client, never logged)
 * - config = non-secret settings below (channels, workspace identity, masked token)
 */
export type SlackOrgConfig = {
  teamId?: string | null;
  teamName?: string | null;
  botUserId?: string | null;
  botTokenMasked?: string | null;
  signingSecretSet?: boolean;
  alertsChannel?: string | null;
  winsChannel?: string | null;
  digestChannel?: string | null;
  digestEnabled?: boolean;
  /** pipeline key → channel (deal comments mirror here) */
  dealChannels?: Record<string, string>;
  connectedAt?: string | null;
  lastTestAt?: string | null;
  digestLastDate?: string | null;
};

export type SlackSecrets = { botToken: string; signingSecret: string };

export type SlackContext = { token: string; signingSecret: string; config: SlackOrgConfig; appUrl: string };

export async function getSlackRow() {
  const [row] = await db
    .select()
    .from(integrationConnections)
    .where(and(isNull(integrationConnections.userId), eq(integrationConnections.provider, "slack")))
    .limit(1);
  return row ?? null;
}

export function readSecrets(encrypted: string | null | undefined): SlackSecrets | null {
  if (!encrypted) return null;
  try {
    const v = JSON.parse(decryptSecret(encrypted)) as Partial<SlackSecrets>;
    return { botToken: typeof v.botToken === "string" ? v.botToken : "", signingSecret: typeof v.signingSecret === "string" ? v.signingSecret : "" };
  } catch {
    return null;
  }
}

/**
 * The live Slack context (request-cached), or null when Slack is not configured / disconnected — every Slack code path
 * starts here and becomes a no-op on null. Never throws.
 */
export const getSlackContext = cache(async (): Promise<SlackContext | null> => {
  try {
    const row = await getSlackRow();
    if (!row || row.status === "revoked") return null;
    const secrets = readSecrets(row.secretEncrypted);
    if (!secrets?.botToken || !secrets.signingSecret) return null;
    return { token: secrets.botToken, signingSecret: secrets.signingSecret, config: (row.config ?? {}) as SlackOrgConfig, appUrl: env.appUrl };
  } catch {
    return null;
  }
});

/** Signing secret only (webhook verification). Works even if the bot token was revoked. */
export async function getSigningSecret(): Promise<{ signingSecret: string; teamId: string | null } | null> {
  try {
    const row = await getSlackRow();
    if (!row || row.status === "revoked") return null;
    const secrets = readSecrets(row.secretEncrypted);
    if (!secrets?.signingSecret) return null;
    return { signingSecret: secrets.signingSecret, teamId: ((row.config ?? {}) as SlackOrgConfig).teamId ?? null };
  } catch {
    return null;
  }
}
