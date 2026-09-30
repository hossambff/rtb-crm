import "server-only";
import { requireUser } from "@/lib/rbac/server";
import { parseFilters } from "./filters";
import { analyticsContext, type AnalyticsContext } from "./scope";

type SP = Record<string, string | string[] | undefined>;

/** Resolve the signed-in user, URL filters and permission scope for an analytics page (null = no access). */
export async function pageContext(searchParams: Promise<SP>): Promise<{ ctx: AnalyticsContext | null; now: Date }> {
  const user = await requireUser();
  const now = new Date();
  const filters = parseFilters(await searchParams, now);
  return { ctx: await analyticsContext(user, filters), now };
}

/** Deal record URL (owned by the deals module). */
export function dealHref(id: string): string {
  return `/deals/${id}`;
}
