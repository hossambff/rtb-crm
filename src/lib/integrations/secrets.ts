import "server-only";
import { z } from "zod";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { assertCan, type AppUser } from "@/lib/rbac/server";
import { validateGranolaKeyFormat } from "@/lib/transcripts/granola-core";
import { testGranolaKey } from "@/lib/transcripts/granola";
import { IntegrationAuthError, getConnection, upsertConnection } from "./store";

/**
 * Secret-bearing writes (Granola key, Zoom credentials). Exposed through route handlers under /api/integrations/*
 * rather than server actions so secret values never pass through dev-mode server-function argument logging.
 */

export const granolaKeyInput = z.object({ key: z.string().max(300) });

export async function saveGranolaKeyFor(user: AppUser, input: z.infer<typeof granolaKeyInput>): Promise<{ warning: string | null }> {
  const k = input.key.trim();
  const formatError = validateGranolaKeyFormat(k);
  if (formatError) throw new UserError(formatError);
  let warning: string | null = null;
  try {
    await testGranolaKey(k);
  } catch (e) {
    if (e instanceof IntegrationAuthError) throw new UserError("Granola rejected this key. Copy it again from Granola → Settings → API.");
    warning = "Saved, but Granola couldn't be reached to verify the key. We'll retry on the next sync.";
  }
  await upsertConnection(user.id, "granola", {
    status: warning ? "error" : "connected",
    secretEncrypted: encryptSecret(k),
    config: { masked: maskSecret(k), failures: 0, nextRetryAt: null },
    lastError: warning,
    cursor: null,
  });
  await audit({ actorId: user.id, action: "integration.granola_key_saved", entity: "user", entityId: user.id, after: { masked: maskSecret(k) } });
  return { warning };
}

export const zoomConfigInput = z.object({
  accountId: z.string().trim().min(3, "Account ID is required").max(100),
  clientId: z.string().trim().max(200).optional().default(""),
  clientSecret: z.string().trim().max(300).optional().default(""),
  webhookSecret: z.string().trim().max(300).optional().default(""),
});

/** Admin-only org Zoom connection (Server-to-Server OAuth app + webhook secret token), stored encrypted. */
export async function saveZoomConfigFor(user: AppUser, input: z.infer<typeof zoomConfigInput>): Promise<void> {
  await assertCan(user, "admin", "configure", "all");
  const existing = await getConnection(null, "zoom");
  let prev: { clientId?: string; clientSecret?: string; webhookSecret?: string } = {};
  if (existing?.secretEncrypted) {
    try {
      prev = JSON.parse(decryptSecret(existing.secretEncrypted));
    } catch {
      prev = {};
    }
  }
  const merged = {
    accountId: input.accountId,
    clientId: input.clientId || prev.clientId || "",
    clientSecret: input.clientSecret || prev.clientSecret || "",
    webhookSecret: input.webhookSecret || prev.webhookSecret || "",
  };
  if (!merged.clientId || !merged.clientSecret) throw new UserError("Client ID and client secret are required.");
  if (!merged.webhookSecret) throw new UserError("The webhook secret token is required to verify Zoom events.");
  await upsertConnection(null, "zoom", {
    status: "connected",
    secretEncrypted: encryptSecret(JSON.stringify(merged)),
    config: { accountId: merged.accountId, clientIdMasked: maskSecret(merged.clientId) },
    lastError: null,
  });
  await audit({ actorId: user.id, action: "integration.zoom_saved", entity: "integration", entityId: "zoom", after: { accountId: merged.accountId } });
}

/** CSRF guard for cookie-authenticated JSON route handlers: the Origin must match the request host. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
