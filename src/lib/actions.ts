import "server-only";
import { z } from "zod";
import { logServerError } from "@/lib/errors";
import { ForbiddenError, getCurrentUser, type AppUser } from "@/lib/rbac/server";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/**
 * Wrap a server action: authenticate, validate input with zod, map errors to a safe result.
 * Usage:
 *   export const updateDeal = action(schema, async (input, user) => { await assertCan(user, …); … return result; });
 */
export function action<S extends z.ZodType, T>(schema: S, handler: (input: z.infer<S>, user: AppUser) => Promise<T>) {
  return async (raw: z.input<S>): Promise<ActionResult<T>> => {
    const user = await getCurrentUser();
    if (!user || user.role === "pending") return { ok: false, error: "You are not signed in." };
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Please check the highlighted fields.", fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]> };
    }
    try {
      return { ok: true, data: await handler(parsed.data, user) };
    } catch (e) {
      if (e instanceof ForbiddenError) return { ok: false, error: e.message };
      if (e instanceof UserError) return { ok: false, error: e.message };
      // Logged with a ref (no query params / secrets); the ref is shown so a report can be matched to the log line.
      const ref = logServerError("action", e);
      return { ok: false, error: `Something went wrong. Please try again. (Ref ${ref})` };
    }
  };
}

/** Throw for user-facing validation/business-rule errors (message is shown to the user). */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
