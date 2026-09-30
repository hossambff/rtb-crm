import "server-only";
import { forbidden } from "next/navigation";
import { requireUser, scopeFor, type AppUser } from "@/lib/rbac/server";
import type { Action, Module } from "@/lib/rbac/model";

/**
 * Page-level RBAC for route segments (QA-09 / AT-02). Call from a segment's layout.tsx so the check runs before any
 * loading.tsx boundary streams — `forbidden()` then renders `src/app/(app)/forbidden.tsx` with a real HTTP 403.
 * Pages keep their own checks (defense in depth); this only makes the response status honest.
 */
export async function guardModule(module: Module, action: Action = "view"): Promise<AppUser> {
  const user = await requireUser();
  if ((await scopeFor(user, module, action)) === "none") forbidden();
  return user;
}

/** Same as guardModule but with an arbitrary predicate (e.g. "view OR enrichment view"). */
export async function guardPage(check: (user: AppUser) => Promise<boolean> | boolean): Promise<AppUser> {
  const user = await requireUser();
  if (!(await check(user))) forbidden();
  return user;
}
