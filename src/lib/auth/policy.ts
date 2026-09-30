/**
 * Pure auth policy (no DB / no server-only imports so it is unit-testable).
 *
 * SEC H-1: Better Auth's admin plugin exposes /api/auth/admin/* (set-role, update-user, remove-user…). The app has
 * its own audited, guarded user-management server actions, so over HTTP only read-only admin endpoints are reachable,
 * and only by super_admin. Any role change that touches a privileged role requires a super_admin caller, even for
 * server-side `auth.api.*` calls.
 * SEC M-2 / M-15: a session is valid only while the user is not banned, not past `accessExpiresAt`, on an allowed
 * domain, and (in production) not a seeded dev.* account.
 */

export const PRIVILEGED_AUTH_ROLES = ["super_admin", "admin"] as const;

/** Endpoints anyone signed in may call over HTTP (the impersonated session must be able to stop impersonating). */
const HTTP_OPEN_ADMIN_PATHS = new Set(["/admin/stop-impersonating", "/admin/has-permission"]);
/** Read-only admin endpoints a super_admin may call over HTTP. Every mutation goes through our server actions. */
const HTTP_SUPER_ADMIN_READ_PATHS = new Set(["/admin/list-users", "/admin/get-user", "/admin/list-user-sessions"]);
/** Endpoints that can assign a role (directly or via the `data` bag). */
const ROLE_WRITING_PATHS = new Set(["/admin/set-role", "/admin/create-user", "/admin/update-user"]);

export type AdminEndpointInput = {
  path: string;
  /** true when the call arrived over HTTP (router), false for a server-side `auth.api.*` call. */
  isHttp: boolean;
  callerRole: string | null | undefined;
  body: unknown;
};

export type Decision = { ok: true } | { ok: false; status: "FORBIDDEN" | "NOT_FOUND"; message: string };

const splitRoles = (r: unknown): string[] =>
  (Array.isArray(r) ? r : typeof r === "string" ? r.split(",") : []).map((x) => String(x).trim()).filter(Boolean);

/** Roles a request body tries to assign (set-role `role`, create-user `role`/`data.role`, update-user `data.role`). */
export function requestedRoles(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const b = body as { role?: unknown; data?: { role?: unknown } };
  return [...splitRoles(b.role), ...splitRoles(b.data?.role)];
}

export function adminEndpointDecision(input: AdminEndpointInput): Decision {
  const { path, isHttp } = input;
  if (!path.startsWith("/admin/")) return { ok: true };
  const callerRoles = splitRoles(input.callerRole);
  const isSuper = callerRoles.includes("super_admin");
  if (isHttp) {
    if (HTTP_OPEN_ADMIN_PATHS.has(path)) return { ok: true };
    if (!(isSuper && HTTP_SUPER_ADMIN_READ_PATHS.has(path))) {
      // Mutations must go through the app's guarded + audited server actions (Admin → Users).
      return { ok: false, status: "NOT_FOUND", message: "Not found" };
    }
  }
  if (ROLE_WRITING_PATHS.has(path)) {
    const roles = requestedRoles(input.body);
    if (roles.some((r) => (PRIVILEGED_AUTH_ROLES as readonly string[]).includes(r)) && !isSuper) {
      return { ok: false, status: "FORBIDDEN", message: "Only a Super Admin can grant admin-level roles." };
    }
  }
  return { ok: true };
}

/** Seeded local-QA accounts (scripts/seed.ts): dev.<role>@… */
export function isDevAccountEmail(email: string | null | undefined): boolean {
  return /^dev\.[^@]*@/i.test((email ?? "").trim());
}

export function emailDomainIn(email: string, domains: string[]): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return domains.map((d) => d.toLowerCase()).includes(domain);
}

export type SessionUserFacts = {
  email: string;
  banned: boolean | null;
  banExpires?: Date | null;
  accessExpiresAt: Date | null;
};

/** Why this user may not hold a session right now (null = allowed). */
export function sessionDenialReason(
  u: SessionUserFacts,
  opts: { allowedDomains: string[]; isProd: boolean; now?: number },
): string | null {
  const now = opts.now ?? Date.now();
  if (u.banned && !(u.banExpires && u.banExpires.getTime() < now)) return "banned";
  if (!emailDomainIn(u.email, opts.allowedDomains)) return "domain_not_allowed";
  if (u.accessExpiresAt && u.accessExpiresAt.getTime() < now) return "access_expired";
  if (opts.isProd && isDevAccountEmail(u.email)) return "dev_account_in_production";
  return null;
}

export const SESSION_DENIAL_MESSAGES: Record<string, string> = {
  banned: "Your account has been deactivated. Contact an admin.",
  domain_not_allowed: "Your email domain is no longer allowed.",
  access_expired: "Your access has expired. Contact an admin.",
  dev_account_in_production: "Development accounts can't sign in to this environment.",
};
