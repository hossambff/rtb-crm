import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { backoffMs, readPrefs, safeErrorMessage, type UserPrefs } from "./core";

export type Connection = typeof integrationConnections.$inferSelect;
export type Provider = "gmail" | "calendar" | "granola" | "zoom" | "prefs";

function whereFor(userId: string | null, provider: Provider) {
  return and(userId ? eq(integrationConnections.userId, userId) : isNull(integrationConnections.userId), eq(integrationConnections.provider, provider));
}

export async function getConnection(userId: string | null, provider: Provider): Promise<Connection | null> {
  const [row] = await db.select().from(integrationConnections).where(whereFor(userId, provider)).limit(1);
  return row ?? null;
}

type Patch = Partial<Pick<Connection, "status" | "secretEncrypted" | "config" | "cursor" | "lastSyncAt" | "lastError">>;

/**
 * Insert or update a connection. Org-level rows (userId null) can't use ON CONFLICT (NULLs are distinct in the unique
 * index), so they are handled with select-then-write.
 */
export async function upsertConnection(userId: string | null, provider: Provider, patch: Patch): Promise<Connection> {
  if (userId) {
    const [row] = await db
      .insert(integrationConnections)
      .values({ userId, provider, ...patch })
      .onConflictDoUpdate({ target: [integrationConnections.userId, integrationConnections.provider], set: { ...patch, updatedAt: new Date() } })
      .returning();
    return row!;
  }
  const existing = await getConnection(null, provider);
  if (existing) {
    const [row] = await db
      .update(integrationConnections)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(integrationConnections.id, existing.id))
      .returning();
    return row!;
  }
  const [row] = await db.insert(integrationConnections).values({ userId: null, provider, ...patch }).returning();
  return row!;
}

export async function ensureConnection(userId: string, provider: Provider): Promise<Connection> {
  return (await getConnection(userId, provider)) ?? upsertConnection(userId, provider, { status: "connected", config: {} });
}

/** Merge keys into config (read-modify-write). */
export async function mergeConfig(conn: Connection, patch: Record<string, unknown>, extra: Patch = {}): Promise<Connection> {
  const [row] = await db
    .update(integrationConnections)
    .set({ ...extra, config: { ...(conn.config ?? {}), ...patch }, updatedAt: new Date() })
    .where(eq(integrationConnections.id, conn.id))
    .returning();
  return row!;
}

export class IntegrationAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationAuthError";
  }
}

/** Success: reset failures, clear error, stamp lastSyncAt. */
export async function recordSyncSuccess(conn: Connection, configPatch: Record<string, unknown> = {}, extra: Patch = {}) {
  return mergeConfig(conn, { ...configPatch, failures: 0, nextRetryAt: null }, { status: "connected", lastError: null, lastSyncAt: new Date(), ...extra });
}

/**
 * Failure: exponential backoff; auth failures (or 3+ consecutive failures) flip status to "error",
 * which the alerts module turns into NS-30.
 */
export async function recordSyncFailure(conn: Connection, error: unknown) {
  const failures = Number((conn.config as { failures?: number }).failures ?? 0) + 1;
  const isAuth = error instanceof IntegrationAuthError;
  const status = isAuth || failures >= 3 ? "error" : conn.status === "revoked" ? "revoked" : "connected";
  return mergeConfig(
    conn,
    { failures, nextRetryAt: new Date(Date.now() + backoffMs(failures)).toISOString() },
    { status, lastError: safeErrorMessage(error) },
  );
}

export async function getPrefs(userId: string): Promise<UserPrefs> {
  const conn = await getConnection(userId, "prefs");
  return readPrefs(conn?.config);
}

export async function savePrefs(userId: string, prefs: UserPrefs) {
  await upsertConnection(userId, "prefs", { status: "connected", config: prefs as unknown as Record<string, unknown> });
}
