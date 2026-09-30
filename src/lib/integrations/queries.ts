import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { env } from "@/lib/env";
import { can, type AppUser } from "@/lib/rbac/server";
import { CALENDAR_READ_SCOPE, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE, MAILBOX_REQUIRED_ROLES, hasScope } from "./core";
import { getGoogleAccount } from "./google";
import { getConnection, getPrefs, type Connection } from "./store";

export type ConnectionView = {
  status: string;
  lastSyncAt: string | null;
  lastError: string | null;
  lastResult: Record<string, unknown> | null;
  masked?: string | null;
};

function view(c: Connection | null): ConnectionView | null {
  if (!c) return null;
  const cfg = (c.config ?? {}) as Record<string, unknown>;
  return {
    status: c.status,
    lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
    lastError: c.lastError,
    lastResult: (cfg.lastResult as Record<string, unknown>) ?? null,
    masked: typeof cfg.masked === "string" ? cfg.masked : null,
  };
}

export function mailboxRequired(role: string): boolean {
  return (MAILBOX_REQUIRED_ROLES as readonly string[]).includes(role);
}

/** Everything the Settings page needs — never includes secrets (only masked hints). */
export async function getSettingsState(user: AppUser) {
  const [profile] = await db
    .select({ name: s.user.name, email: s.user.email, title: s.user.title, timezone: s.user.timezone, workStartHour: s.user.workStartHour, workEndHour: s.user.workEndHour })
    .from(s.user)
    .where(eq(s.user.id, user.id));
  const [acct, gmail, calendar, granola, prefs, isAdmin] = await Promise.all([
    getGoogleAccount(user.id),
    getConnection(user.id, "gmail"),
    getConnection(user.id, "calendar"),
    getConnection(user.id, "granola"),
    getPrefs(user.id),
    can(user, "admin", "configure", "all"),
  ]);
  const zoom = isAdmin ? await getConnection(null, "zoom") : null;
  const zoomCfg = (zoom?.config ?? {}) as Record<string, unknown>;
  return {
    profile: profile!,
    google: {
      configured: env.googleConfigured,
      linked: Boolean(acct),
      gmailRead: hasScope(acct?.scope, GMAIL_READ_SCOPE),
      gmailSend: hasScope(acct?.scope, GMAIL_SEND_SCOPE),
      calendar: hasScope(acct?.scope, CALENDAR_READ_SCOPE),
      gmail: view(gmail),
      calendarConn: view(calendar),
    },
    granola: view(granola),
    zoom: isAdmin
      ? {
          connected: Boolean(zoom && zoom.status !== "revoked" && zoom.secretEncrypted),
          status: zoom?.status ?? null,
          accountId: typeof zoomCfg.accountId === "string" ? zoomCfg.accountId : "",
          clientIdMasked: typeof zoomCfg.clientIdMasked === "string" ? zoomCfg.clientIdMasked : null,
          updatedAt: zoom?.updatedAt?.toISOString() ?? null,
          webhookUrl: `${env.appUrl.replace(/\/$/, "")}/api/webhooks/zoom`,
        }
      : null,
    prefs,
    mailboxRequired: mailboxRequired(user.role),
  };
}
export type SettingsState = Awaited<ReturnType<typeof getSettingsState>>;

/** For banners elsewhere (Inbox, My Day): does this user still need to connect Gmail (EML-12)? */
export async function needsMailboxConnection(user: AppUser): Promise<boolean> {
  if (!mailboxRequired(user.role)) return false;
  const acct = await getGoogleAccount(user.id);
  return !hasScope(acct?.scope, GMAIL_READ_SCOPE);
}
