import "server-only";
import { NextResponse } from "next/server";
import { ForbiddenError, getCurrentUser, type AppUser } from "@/lib/rbac/server";
import { sameOrigin } from "@/lib/integrations/secrets";
import { logServerError } from "@/lib/errors";
import { DocxError } from "./docx/package";
import { XmlError } from "./docx/xml";

/** Shared helpers for the /api/proposals route handlers (cookie-authenticated). */
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function routeUser(): Promise<AppUser | NextResponse> {
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return json({ error: "You are not signed in." }, 401);
  return user;
}

/** Mutating requests must come from our own pages (Next's origin check only covers server actions). */
export function assertSameOrigin(req: Request) {
  if (!sameOrigin(req)) throw new ForbiddenError("Cross-site request blocked.");
}

export function routeError(scope: string, e: unknown) {
  if (e instanceof ForbiddenError) return json({ error: e.message }, 403);
  if (e instanceof DocxError) return json({ error: e.message }, 422);
  if (e instanceof XmlError) return json({ error: "The document's XML could not be read." }, 422);
  const ref = logServerError(scope, e);
  return json({ error: `Something went wrong. Please try again. (Ref ${ref})` }, 500);
}
