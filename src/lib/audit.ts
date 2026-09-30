import "server-only";
import { headers } from "next/headers";
import { db, type Executor } from "@/db";
import { auditLog } from "@/db/schema";

export async function audit(entry: {
  actorId: string | null;
  actorKind?: "user" | "agent" | "system";
  action: string;
  entity?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
}, q: Executor = db) {
  let ip: string | null = null;
  try {
    const h = await headers();
    ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  } catch {
    // outside a request (cron/scripts)
  }
  // Pass `q` (the transaction) when auditing inside one: the entry then commits/rolls back with the work, and the
  // insert doesn't need a second pooled connection while the transaction holds the first.
  await q.insert(auditLog).values({
    actorId: entry.actorId,
    actorKind: entry.actorKind ?? "user",
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    before: (entry.before ?? null) as never,
    after: (entry.after ?? null) as never,
    ip,
  });
}
