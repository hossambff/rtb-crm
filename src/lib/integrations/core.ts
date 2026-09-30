/**
 * Pure integration helpers shared by settings, sync and cron (unit-tested; safe for client import).
 *
 * Storage decisions (documented for the rest of the team):
 * - Per-user preferences (notifications, privacy blocklist, email signature, AI voice samples) live in
 *   rso.integration_connections with provider "prefs" (userId = user) in `config` — see `UserPrefs`.
 * - Gmail sync state: provider "gmail" (cursor = Gmail historyId; config = GmailSyncConfig).
 * - Calendar sync state: provider "calendar". Granola: provider "granola" (secretEncrypted = API key).
 * - Zoom org connection: provider "zoom", userId NULL (secretEncrypted = JSON ZoomSecrets).
 * - integration_connections.status: connected | error | revoked. status "error" is what NS-30 (alerts module) reads.
 */
import { z } from "zod";

export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const CALENDAR_READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

/** Roles for which connecting Gmail is mandatory (EML-12). */
export const MAILBOX_REQUIRED_ROLES = ["sales_leader", "ae", "sdr", "intern", "commission_rep"] as const;

export function parseScopes(scope: string | null | undefined): string[] {
  return (scope ?? "").split(/[\s,]+/).filter(Boolean);
}
export function hasScope(scope: string | null | undefined, wanted: string): boolean {
  return parseScopes(scope).includes(wanted);
}

export const notificationPrefsSchema = z.object({
  inApp: z.boolean().default(true),
  emailDigest: z.enum(["off", "daily", "weekly"]).default("daily"),
  slack: z.boolean().default(false),
  minSeverity: z.enum(["info", "warning", "serious", "critical"]).default("warning"),
  aiActions: z.boolean().default(true), // "auto + notify" agent actions (tasks created from email/calls)
  mentions: z.boolean().default(true),
  approvals: z.boolean().default(true),
  quietHoursStart: z.number().int().min(0).max(23).default(20),
  quietHoursEnd: z.number().int().min(0).max(23).default(8),
});
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export const userPrefsSchema = z.object({
  notifications: notificationPrefsSchema.default(notificationPrefsSchema.parse({})),
  blocklist: z.array(z.string()).default([]),
  signature: z.string().max(2000).default(""),
  voiceSamples: z.string().max(8000).default(""),
});
export type UserPrefs = z.infer<typeof userPrefsSchema>;

/** Tolerant parse of stored prefs: invalid/missing fields fall back to defaults. */
export function readPrefs(config: unknown): UserPrefs {
  const parsed = userPrefsSchema.safeParse(config ?? {});
  if (parsed.success) return parsed.data;
  const c = (config ?? {}) as Record<string, unknown>;
  const n = notificationPrefsSchema.safeParse(c.notifications ?? {});
  return {
    notifications: n.success ? n.data : notificationPrefsSchema.parse({}),
    blocklist: Array.isArray(c.blocklist) ? c.blocklist.filter((x): x is string => typeof x === "string") : [],
    signature: typeof c.signature === "string" ? c.signature.slice(0, 2000) : "",
    voiceSamples: typeof c.voiceSamples === "string" ? c.voiceSamples.slice(0, 8000) : "",
  };
}

/** Exponential backoff for failing connections: 5m, 10m, 20m … capped at 6h. */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(5 * 60_000 * 2 ** (failures - 1), 6 * 60 * 60_000);
}

export type SyncState = { failures?: number; nextRetryAt?: string | null };
export function shouldSkipForBackoff(state: SyncState, now: Date): boolean {
  if (!state.nextRetryAt) return false;
  const t = new Date(state.nextRetryAt).getTime();
  return Number.isFinite(t) && t > now.getTime();
}

/** Strip anything that could be a credential from an error message before persisting/showing it. */
export function safeErrorMessage(e: unknown, max = 300): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
  return raw
    .replace(/(Bearer|token|key|secret|password|authorization)([=:\s"]+)[^\s"&,]+/gi, "$1$2[redacted]")
    .replace(/ya29\.[\w.-]+/g, "[redacted]")
    .replace(/access_token=[^&\s]+/g, "access_token=[redacted]")
    .slice(0, max);
}

/** Autonomy levels (PRD §11.4) as stored in app_settings "agent.autonomy". */
export type AutonomyKey =
  | "task_from_commitment"
  | "link_email"
  | "link_transcript"
  | "log_activity"
  | "next_step_update"
  | "stage_change"
  | "field_update_value"
  | "create_contact"
  | "send_email";
export const DEFAULT_AUTONOMY: Record<AutonomyKey, number> = {
  task_from_commitment: 2,
  link_email: 2,
  link_transcript: 2,
  log_activity: 2,
  next_step_update: 2,
  stage_change: 1,
  field_update_value: 1,
  create_contact: 1,
  send_email: 0,
};
export function autonomyLevel(settings: unknown, key: AutonomyKey): number {
  const v = (settings as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === "number" && v >= 0 && v <= 3 ? v : DEFAULT_AUTONOMY[key];
}
