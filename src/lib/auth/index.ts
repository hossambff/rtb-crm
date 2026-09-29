import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { APIError } from "better-auth/api";
import { dash } from "@better-auth/infra";
import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { emailDomainAllowed, env } from "@/lib/env";
import { ac, authRoles } from "./access";

/** Gmail + Calendar scopes requested only when a user explicitly connects their inbox (incremental auth). */
export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
];

async function extraAllowedDomains(): Promise<string[]> {
  try {
    const rows = await db.select({ domain: schema.allowedDomains.domain }).from(schema.allowedDomains);
    return rows.map((r) => r.domain);
  } catch {
    return [];
  }
}

const plugins = [
  admin({
    ac,
    roles: authRoles,
    defaultRole: "pending",
    adminRoles: ["super_admin", "admin"],
    impersonationSessionDuration: 60 * 60,
  }),
  ...(process.env.BETTER_AUTH_API_KEY ? [dash({ apiKey: process.env.BETTER_AUTH_API_KEY })] : []),
  nextCookies(),
];

export const auth = betterAuth({
  appName: "Roundtable Sales OS",
  baseURL: process.env.BETTER_AUTH_URL ?? env.appUrl,
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
            .select({ email: schema.user.email, banned: schema.user.banned, expires: schema.user.accessExpiresAt })
            .from(schema.user)
            .where(eq(schema.user.id, session.userId));
          if (!u) return;
          if (!emailDomainAllowed(u.email, await extraAllowedDomains())) {
            throw new APIError("FORBIDDEN", { message: "Your email domain is no longer allowed." });
          }
          if (u.expires && u.expires.getTime() < Date.now()) {
            throw new APIError("FORBIDDEN", { message: "Your access has expired. Contact an admin." });
          }
        },
      },
    },
  },
  plugins,
});

export type Session = typeof auth.$Infer.Session;
