import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { dash } from "@better-auth/infra";
import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { emailDomainAllowed, env } from "@/lib/env";
import { ac, authRoles } from "./access";
import { adminEndpointDecision, requestedRoles, sessionDenialReason, SESSION_DENIAL_MESSAGES } from "./policy";

/** Gmail + Calendar scopes requested only when a user explicitly connects their inbox (incremental auth). */
export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  // V2 A1: post-call follow-ups are saved as Gmail drafts (users.drafts.create). Never used to send.
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export async function extraAllowedDomains(): Promise<string[]> {
  try {
    const rows = await db.select({ domain: schema.allowedDomains.domain }).from(schema.allowedDomains);
    return rows.map((r) => r.domain);
  } catch {
    return [];
  }
}

/** Better Auth admin endpoints whose successful calls are always audited (SEC H-1). */
const AUDITED_AUTH_PATHS = new Set([
  "/admin/set-role",
  "/admin/create-user",
  "/admin/update-user",
  "/admin/remove-user",
  "/admin/ban-user",
  "/admin/unban-user",
  "/admin/set-user-password",
  "/admin/impersonate-user",
  "/admin/revoke-user-sessions",
]);

async function auditAuth(actorId: string | null, action: string, entityId: string | null, after: unknown) {
  await db.insert(schema.auditLog).values({
    actorId,
    actorKind: actorId ? "user" : "system",
    action,
    entity: "user",
    entityId: entityId ?? undefined,
    before: null,
    after: after as never,
  });
}

const plugins = [
  admin({
    ac,
    roles: authRoles,
    defaultRole: "pending",
    adminRoles: ["super_admin"], // SEC H-1: the app `admin` role holds no Better Auth admin statements
    impersonationSessionDuration: 60 * 60,
  }),
  ...(process.env.BETTER_AUTH_API_KEY ? [dash({ apiKey: process.env.BETTER_AUTH_API_KEY })] : []),
  nextCookies(),
];

export const auth = betterAuth({
  appName: "Roundtable Sales OS",
  baseURL: process.env.BETTER_AUTH_URL ?? env.appUrl,
  // Extra origins allowed to call auth endpoints (e.g. the team-scoped *.vercel.app alias). Comma-separated.
  trustedOrigins: (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: env.devLoginEnabled,
    disableSignUp: !env.devLoginEnabled,
    minPasswordLength: 10,
  },
  socialProviders: env.googleConfigured
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          accessType: "offline",
          prompt: "select_account consent",
        },
      }
    : {},
  account: {
    accountLinking: { enabled: true, trustedProviders: ["google"] },
    // SEC M-12: Gmail/Calendar OAuth tokens are AES-256-GCM encrypted at rest; auth.api.getAccessToken decrypts them.
    encryptOAuthTokens: true,
  },
  session: {
    expiresIn: 60 * 60 * 12, // 12h idle policy (PRD AUTH-4)
    updateAge: 60 * 60,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  rateLimit: { enabled: true, window: 60, max: 120 },
  advanced: {
    useSecureCookies: env.isProd,
    database: { generateId: () => crypto.randomUUID() },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // PRD AUTH-2: only RTB Workspace domains may sign in (roundtable.io, blockchainff.com + admin additions).
          if (!emailDomainAllowed(user.email, await extraAllowedDomains())) {
            throw new APIError("FORBIDDEN", {
              message: "Only roundtable.io and blockchainff.com accounts can sign in.",
            });
          }
          // Bootstrap: the very first user becomes super_admin; everyone else waits for an admin to assign a role.
          const [{ n }] = await db.select({ n: count() }).from(schema.user);
          return { data: { ...user, role: n === 0 ? "super_admin" : "pending" } };
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const [u] = await db
            .select({ email: schema.user.email, expires: schema.user.accessExpiresAt })
            .from(schema.user)
            .where(eq(schema.user.id, session.userId));
          if (!u) return;
          // SEC M-2 / M-15: domain allowlist, access expiry and — in production — seeded dev.* accounts.
          // (Bans are enforced by the admin plugin's own session hook.)
          const reason = sessionDenialReason(
            { email: u.email, banned: false, accessExpiresAt: u.expires },
            { allowedDomains: [...env.allowedDomains, ...(await extraAllowedDomains())], isProd: env.isProd },
          );
          if (reason) throw new APIError("FORBIDDEN", { message: SESSION_DENIAL_MESSAGES[reason] });
        },
      },
    },
  },
  hooks: {
    // SEC H-1: /api/auth/admin/* mutations are not reachable over HTTP (the audited Admin → Users server actions are
    // the only path), and only a super_admin can grant an admin-level role, even through a server-side auth.api call.
    before: createAuthMiddleware(async (ctx) => {
      if (!ctx.path?.startsWith("/admin/")) return;
      const session = await getSessionFromCtx(ctx).catch(() => null);
      let callerRole: string | null = null;
      if (session) {
        // Read the role from the DB, not from the (up to 5 min) session cookie cache.
        const [row] = await db.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, session.user.id));
        callerRole = row?.role ?? null;
      }
      const isHttp = Boolean(ctx.request);
      const decision = adminEndpointDecision({ path: ctx.path, isHttp, callerRole, body: ctx.body });
      if (!decision.ok) {
        await auditAuth(session?.user.id ?? null, "auth.admin.denied", null, { path: ctx.path, http: isHttp }).catch(() => undefined);
        throw new APIError(decision.status, { message: decision.message });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (!ctx.path || !AUDITED_AUTH_PATHS.has(ctx.path)) return;
      const returned = ctx.context.returned as unknown;
      if (returned instanceof Error) return; // failed call — nothing changed
      const session = await getSessionFromCtx(ctx).catch(() => null);
      const body = (ctx.body ?? {}) as { userId?: unknown };
      await auditAuth(session?.user.id ?? null, `auth${ctx.path.replaceAll("/", ".")}`, typeof body.userId === "string" ? body.userId : null, {
        roles: requestedRoles(ctx.body),
        http: Boolean(ctx.request),
      }).catch(() => undefined);
    }),
  },
  plugins,
});

export type Session = typeof auth.$Infer.Session;
