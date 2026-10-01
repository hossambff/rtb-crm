import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, withXactLock } from "@/db";
import * as s from "@/db/schema";
import { getPrefs, patchPrefs } from "@/lib/prefs";
import { loadAppUserById, type AppUser } from "@/lib/rbac/server";
import { slackCall } from "./client";
import { getSlackContext } from "./config";
import { isSlackUserId, pickVerifiedClaimant, slackEmailMatches } from "./core";

/** The AppUser for a user acting through Slack (no browser session): the shared session-equivalent loader. */
export async function appUserById(userId: string): Promise<AppUser | null> {
  return loadAppUserById(userId);
}

/* ───────────── Ownership verification (SEC M-4 / QA MAJ-18) ───────────── */

type SlackProfile = { id: string; email: string | null; usable: boolean };

/**
 * Per-instance cache of verified (userId, Slack member ID) pairs. A Slack member ID is only trusted for a user when the
 * Slack profile email (users.info — Slack verifies workspace emails) equals the user's Roundtable email. Positive results
 * are cached for a day, negative ones for 10 minutes (so a fixed profile email starts working quickly).
 */
const g = globalThis as unknown as { __slackVerified?: Map<string, { ok: boolean; at: number }> };
const verifiedCache: Map<string, { ok: boolean; at: number }> = g.__slackVerified ?? (g.__slackVerified = new Map());
const OK_TTL_MS = 24 * 3_600_000;
const NO_TTL_MS = 10 * 60_000;

async function slackProfile(token: string, slackUserId: string): Promise<SlackProfile | null> {
  const info = await slackCall<{ user?: { id?: string; deleted?: boolean; is_bot?: boolean; profile?: { email?: string } } }>(token, "users.info", { user: slackUserId });
  if (!info.ok) return null;
  return { id: slackUserId, email: info.user?.profile?.email?.trim().toLowerCase() ?? null, usable: !info.user?.deleted && !info.user?.is_bot };
}

/** Does `slackUserId` belong to the app user with `email`? Cached; fails closed (false) when Slack can't be asked. */
async function ownsSlackId(userId: string, email: string, slackUserId: string, token: string): Promise<boolean> {
  const key = `${userId}:${slackUserId}`;
  const hit = verifiedCache.get(key);
  if (hit && Date.now() - hit.at < (hit.ok ? OK_TTL_MS : NO_TTL_MS)) return hit.ok;
  const p = await slackProfile(token, slackUserId);
  if (!p) return false; // transient: don't cache, don't trust
  const ok = p.usable && slackEmailMatches(email, p.email);
  if (verifiedCache.size > 5000) verifiedCache.clear();
  verifiedCache.set(key, { ok, at: Date.now() });
  return ok;
}

export type SlackIdCheck = { ok: true; slackUserId: string } | { ok: false; reason: string };

/**
 * Verify that `slackUserId` may be stored for `user` (Settings → Preferences, owned by WS-A/FX-4): it must be a member ID,
 * not already mapped to another Roundtable user, and its Slack profile email must equal the user's email
 * (case-insensitive). Read-only — use {@link claimSlackMemberId} to also store it atomically.
 * When Slack isn't connected the ID can't be verified and is refused.
 */
export async function verifySlackMemberId(user: { id: string; email: string }, slackUserIdRaw: string): Promise<SlackIdCheck> {
  const slackUserId = slackUserIdRaw.trim().toUpperCase();
  if (!isSlackUserId(slackUserId)) return { ok: false, reason: "Looks like U0123ABCD — find it in Slack under Profile → ⋯ → Copy member ID." };
  const taken = await db
    .select({ userId: s.userPrefs.userId })
    .from(s.userPrefs)
    .where(and(eq(s.userPrefs.slackUserId, slackUserId), ne(s.userPrefs.userId, user.id)))
    .limit(1);
  if (taken.length) return { ok: false, reason: "That Slack member ID is already linked to another Roundtable user." };
  const ctx = await getSlackContext();
  if (!ctx) return { ok: false, reason: "Slack isn't connected yet, so the member ID can't be verified. An admin can connect it in Admin → Slack." };
  const p = await slackProfile(ctx.token, slackUserId);
  if (!p) return { ok: false, reason: "Couldn't check that member ID with Slack. Try again in a minute." };
  if (!p.usable) return { ok: false, reason: "That Slack account is deactivated or a bot." };
  if (!slackEmailMatches(user.email, p.email))
    return { ok: false, reason: `That Slack account's email doesn't match ${user.email}. Use your own member ID (Profile → ⋯ → Copy member ID).` };
  verifiedCache.set(`${user.id}:${slackUserId}`, { ok: true, at: Date.now() });
  return { ok: true, slackUserId };
}

/**
 * Verify and store the user's Slack member ID. Uniqueness (one Roundtable user per Slack member) is enforced in code:
 * the check and the write run in one transaction under an advisory lock keyed by the member ID, so two concurrent claims
 * can't both succeed. (Backed by the unique index user_prefs_slack_user_id_uq.) `null`/"" clears it.
 */
export async function claimSlackMemberId(user: { id: string; email: string }, slackUserIdRaw: string | null): Promise<SlackIdCheck | { ok: true; slackUserId: null }> {
  const raw = (slackUserIdRaw ?? "").trim().toUpperCase();
  if (!raw) {
    await patchPrefs(user.id, { slackUserId: null });
    return { ok: true, slackUserId: null };
  }
  const check = await verifySlackMemberId(user, raw);
  if (!check.ok) return check;
  return storeUniqueSlackId(user.id, check.slackUserId);
}

/** Write `slackUserId` for `userId` only if no other user holds it (transaction + advisory lock on the member ID). */
async function storeUniqueSlackId(userId: string, slackUserId: string): Promise<SlackIdCheck> {
  const r = await withXactLock(`rso.slack_member:${slackUserId}`, async (tx) => {
    const taken = await tx
      .select({ userId: s.userPrefs.userId })
      .from(s.userPrefs)
      .where(and(eq(s.userPrefs.slackUserId, slackUserId), ne(s.userPrefs.userId, userId)))
      .limit(1);
    if (taken.length) return false;
    await tx.insert(s.userPrefs).values({ userId, slackUserId }).onConflictDoUpdate({ target: s.userPrefs.userId, set: { slackUserId } });
    return true;
  });
  if (!r.locked || !r.value) return { ok: false, reason: "That Slack member ID is already linked to another Roundtable user." };
  return { ok: true, slackUserId };
}

/**
 * The user's Slack member ID for outbound DMs: user_prefs.slackUserId when it is verified to belong to the user (Slack
 * profile email = Roundtable email) and claimed by nobody else; otherwise auto-mapped with users.lookupByEmail (requires
 * users:read.email) and stored (only if unclaimed). Returns null when no trustworthy mapping exists — a self-declared ID
 * that belongs to a colleague never receives this user's DMs (SEC M-4).
 */
export async function slackIdForUser(userId: string, token: string, opts: { lookup?: boolean } = {}): Promise<string | null> {
  const prefs = await getPrefs(userId);
  const [u] = await db.select({ email: s.user.email }).from(s.user).where(eq(s.user.id, userId));
  if (!u?.email) return null;
  if (prefs.slackUserId && isSlackUserId(prefs.slackUserId)) {
    const claims = await db.select({ userId: s.userPrefs.userId }).from(s.userPrefs).where(eq(s.userPrefs.slackUserId, prefs.slackUserId)).limit(2);
    if (claims.length === 1 && (await ownsSlackId(userId, u.email, prefs.slackUserId, token))) return prefs.slackUserId;
    // unverified or contested: fall through to the email lookup (never DM a colleague's ID)
  }
  if (opts.lookup === false) return null;
  const res = await slackCall<{ user?: { id?: string; deleted?: boolean; is_bot?: boolean } }>(token, "users.lookupByEmail", { email: u.email });
  if (!res.ok || !isSlackUserId(res.user?.id) || res.user?.deleted || res.user?.is_bot) return null;
  const id = res.user.id;
  if (prefs.slackUserId !== id) {
    const stored = await storeUniqueSlackId(userId, id);
    if (!stored.ok) return null;
  }
  verifiedCache.set(`${userId}:${id}`, { ok: true, at: Date.now() });
  return id;
}

/**
 * Map an incoming Slack user to an app user (button clicks, /rtb). Order: user_prefs mappings for this member ID whose
 * owner is verified (Slack profile email = Roundtable email) — a self-declared claim on a colleague's ID never makes
 * their clicks act as the claimant, and duplicate claims are resolved by the email instead of locking the real owner
 * out — else the Slack profile email matched case-insensitively to an app account, then remembered (if unclaimed).
 * Returns null when unknown (the caller answers "connect your account").
 */
export async function appUserForSlack(slackUserId: string, token: string | null): Promise<AppUser | null> {
  if (!isSlackUserId(slackUserId) || !token) return null;
  const profile = await slackProfile(token, slackUserId);
  if (!profile || !profile.usable || !profile.email) return null;
  const mapped = await db
    .select({ userId: s.userPrefs.userId, email: s.user.email })
    .from(s.userPrefs)
    .innerJoin(s.user, eq(s.user.id, s.userPrefs.userId))
    .where(eq(s.userPrefs.slackUserId, slackUserId))
    .limit(10);
  const owner = pickVerifiedClaimant(mapped, profile.email);
  if (owner) return appUserById(owner);
  const [u] = await db.select({ id: s.user.id }).from(s.user).where(eq(sql`lower(${s.user.email})`, profile.email)).limit(1);
  if (!u) return null;
  const prefs = await getPrefs(u.id);
  if (prefs.slackUserId !== slackUserId) {
    // A false self-claim by someone else is simply overridden for the real owner (the claimant keeps nothing).
    await db.update(s.userPrefs).set({ slackUserId: null }).where(and(eq(s.userPrefs.slackUserId, slackUserId), ne(s.userPrefs.userId, u.id)));
    const stored = await storeUniqueSlackId(u.id, slackUserId);
    if (!stored.ok) return null;
  }
  return appUserById(u.id);
}

/** Bulk auto-map for the admin page: active users without a Slack ID, bounded per click (Slack tier-3 rate limits). */
export async function autoMapUsers(token: string, limit = 40): Promise<{ checked: number; mapped: number; notFound: number; remaining: number }> {
  const rows = await db
    .select({ id: s.user.id, slackUserId: s.userPrefs.slackUserId })
    .from(s.user)
    .leftJoin(s.userPrefs, eq(s.userPrefs.userId, s.user.id))
    .where(and(sql`${s.user.role} <> 'pending'`, sql`coalesce(${s.user.banned}, false) = false`));
  const todo = rows.filter((r) => !r.slackUserId);
  let mapped = 0;
  let notFound = 0;
  const batch = todo.slice(0, limit);
  for (const r of batch) {
    const id = await slackIdForUser(r.id, token);
    if (id) mapped++;
    else notFound++;
  }
  return { checked: batch.length, mapped, notFound, remaining: Math.max(0, todo.length - batch.length) };
}
