/**
 * Background jobs acting on a user's behalf build their AppUser with the shared, session-equivalent loader
 * (`loadAppUserById` in src/lib/rbac/server.ts — same ban / access-expiry / domain / pending rules as getCurrentUser).
 * Kept as a re-export for existing imports.
 */
export { loadAppUserById } from "@/lib/rbac/server";
