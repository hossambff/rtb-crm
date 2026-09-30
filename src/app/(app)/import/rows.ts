import "server-only";
import { listBatches } from "@/lib/import/server";
import { scopeFor, type AppUser } from "@/lib/rbac/server";
import type { BatchRow } from "@/components/import/batch-table";

/** Batches visible in history with a per-row rollback permission flag (same rule as assertCanRollback). */
export async function batchRowsFor(user: AppUser, limit = 100): Promise<BatchRow[]> {
  const [batches, scope] = await Promise.all([listBatches(limit), scopeFor(user, "import", "import")]);
  const allowed = (createdBy: string | null) =>
    scope === "all" || scope === "pipeline" || (scope === "team" && !!createdBy && user.teamMemberIds.includes(createdBy)) || (scope === "own" && createdBy === user.id);
  return batches
    .filter((b) => scope === "all" || scope === "pipeline" || allowed(b.createdBy))
    .map((b) => ({ ...b, stats: (b.stats ?? {}) as Record<string, number>, canRollback: allowed(b.createdBy) }));
}
