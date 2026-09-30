"use server";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/rbac/server";
import { notificationPrefsSchema, GMAIL_READ_SCOPE, hasScope } from "./core";
import { normalizeBlocklist } from "./matching-core";
import { getGoogleAccount } from "./google";
import { getConnection, getPrefs, savePrefs, upsertConnection } from "./store";
import { runUserSync } from "./sync-runner";

const TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

export const updateProfile = action(
  z
    .object({
      name: z.string().trim().min(1, "Name is required").max(120),
      title: z.string().trim().max(120).optional().default(""),
      timezone: z.string().refine((tz) => TIMEZONES.has(tz) || tz === "UTC", "Pick a valid timezone"),
      workStartHour: z.coerce.number().int().min(0).max(23),
      workEndHour: z.coerce.number().int().min(1).max(24),
    })
    .refine((v) => v.workEndHour > v.workStartHour, { message: "End must be after start", path: ["workEndHour"] }),
  async (input, user) => {
    const [before] = await db
      .select({ name: s.user.name, title: s.user.title, timezone: s.user.timezone, workStartHour: s.user.workStartHour, workEndHour: s.user.workEndHour })
      .from(s.user)
      .where(eq(s.user.id, user.id));
    const after_ = { name: input.name, title: input.title || null, timezone: input.timezone, workStartHour: input.workStartHour, workEndHour: input.workEndHour };
    await db.update(s.user).set(after_).where(eq(s.user.id, user.id));
    await audit({ actorId: user.id, action: "user.profile_update", entity: "user", entityId: user.id, before, after: after_ });
    revalidatePath("/settings");
    return true;
  },
);

/** Called after the Google linkSocial redirect (?connected=google): mark connections live and kick off a first sync. */
export const confirmGoogleConnected = action(z.object({}), async (_input, user) => {
  const acct = await getGoogleAccount(user.id);
  if (!acct || !hasScope(acct.scope, GMAIL_READ_SCOPE)) return { connected: false };
  for (const provider of ["gmail", "calendar"] as const) {
    await upsertConnection(user.id, provider, { status: "connected", lastError: null });
  }
  await audit({ actorId: user.id, action: "integration.google_connected", entity: "user", entityId: user.id });
  after(async () => {
    await runUserSync(user.id).catch(() => undefined);
  });
  revalidatePath("/settings");
  return { connected: true };
});

/** Pause/resume inbox + calendar sync without unlinking the Google sign-in account. */
export const setInboxSync = action(z.object({ enabled: z.boolean() }), async ({ enabled }, user) => {
  for (const provider of ["gmail", "calendar"] as const) {
    await upsertConnection(user.id, provider, { status: enabled ? "connected" : "revoked", lastError: null });
  }
  await audit({ actorId: user.id, action: enabled ? "integration.inbox_resumed" : "integration.inbox_paused", entity: "user", entityId: user.id });
  revalidatePath("/settings");
  return true;
});

export const revokeGranolaKey = action(z.object({}), async (_i, user) => {
  const conn = await getConnection(user.id, "granola");
  if (!conn) return true;
  await upsertConnection(user.id, "granola", { status: "revoked", secretEncrypted: null, config: {}, lastError: null });
  await audit({ actorId: user.id, action: "integration.granola_key_revoked", entity: "user", entityId: user.id });
  revalidatePath("/settings");
  return true;
});

export const syncGranolaNow = action(z.object({}), async (_i, user) => {
  const conn = await getConnection(user.id, "granola");
  if (!conn?.secretEncrypted || conn.status === "revoked") throw new UserError("Add your Granola API key first.");
  const r = await runUserSync(user.id);
  revalidatePath("/calls");
  revalidatePath("/settings");
  const g = r.granola;
  if (g && "error" in g) throw new UserError(`Granola sync failed: ${g.error}`);
  if (g && !("listed" in g)) throw new UserError("Granola sync is backing off after recent errors. Try again in a few minutes.");
  return { ingested: g?.ingested ?? 0, updated: g?.updated ?? 0 };
});

export const revokeZoom = action(z.object({}), async (_i, user) => {
  await assertCan(user, "admin", "configure", "all");
  await upsertConnection(null, "zoom", { status: "revoked", secretEncrypted: null, config: {} });
  await audit({ actorId: user.id, action: "integration.zoom_revoked", entity: "integration", entityId: "zoom" });
  revalidatePath("/settings");
  return true;
});

export const saveNotificationPrefs = action(
  z.object({
    notifications: notificationPrefsSchema,
    signature: z.string().max(2000).default(""),
    voiceSamples: z.string().max(8000).default(""),
  }),
  async (input, user) => {
    const prefs = await getPrefs(user.id);
    await savePrefs(user.id, { ...prefs, notifications: input.notifications, signature: input.signature, voiceSamples: input.voiceSamples });
    revalidatePath("/settings");
    return true;
  },
);

export const saveBlocklist = action(z.object({ entries: z.string().max(20_000) }), async ({ entries }, user) => {
  const list = normalizeBlocklist(entries.split(/[\n,;]+/));
  if (list.length > 500) throw new UserError("The blocklist can hold up to 500 entries.");
  const prefs = await getPrefs(user.id);
  await savePrefs(user.id, { ...prefs, blocklist: list });
  await audit({ actorId: user.id, action: "user.blocklist_update", entity: "user", entityId: user.id, after: { count: list.length } });
  revalidatePath("/settings");
  return { count: list.length, entries: list };
});
