import "server-only";
import { headers } from "next/headers";
import { db } from "@/db";
import { auditLog } from "@/db/schema";

export async function audit(entry: {
  actorId: string | null;
  actorKind?: "user" | "agent" | "system";
  action: string;
  entity?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
}) {
  let ip: string | null = null;
  try {
    const h = await headers();
    ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  } catch {
    // outside a request (cron/scripts)
  }
  await db.insert(auditLog).values({
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
