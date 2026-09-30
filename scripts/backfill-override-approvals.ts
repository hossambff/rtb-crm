/**
 * QA-03 / AT-09: the spreadsheet import set `deals.override_status = 'pending'` on the SPT deals with a manual 100%
 * probability but wrote no `approvals` rows, so the executive could never decide them from Tasks → Approvals.
 *
 * Creates ONE bulk `probability_override` approval (approverRole executive, payload.dealIds = every pending-override deal
 * that isn't already covered by another pending override approval), requested by "system:import". The registry's
 * probability_override handler already supports bulk payloads (label "N deals (bulk)", approve/reject applies to all).
 *
 * Idempotent: keyed on entity_id = BULK_KEY. Re-running while the row is pending refreshes payload.dealIds to the
 * current pending set; once it is decided, the script does nothing.
 * Usage: npx tsx scripts/backfill-override-approvals.ts [--dry-run]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { and, eq, isNull, sql } from "drizzle-orm";
import { scriptDb } from "./_db";
import * as s from "../src/db/schema";

const BULK_KEY = "import:overrides:2026-09-29";
const REQUESTED_BY = "system:import";
const NOTE = "Imported overrides per J. Heckman 29 Sep 2026";

async function main() {
  const dry = process.argv.includes("--dry-run");
  const { db, close } = scriptDb();
  try {
    const pendingDeals = await db
      .select({ id: s.deals.id, p: s.deals.probabilityOverride })
      .from(s.deals)
      .where(and(eq(s.deals.overrideStatus, "pending"), isNull(s.deals.deletedAt)));

    const otherPending = await db
      .select({ entityId: s.approvals.entityId, payload: s.approvals.payload, id: s.approvals.id })
      .from(s.approvals)
      .where(and(eq(s.approvals.kind, "probability_override"), eq(s.approvals.status, "pending")));
    const covered = new Set<string>();
    for (const a of otherPending) {
      if (a.entityId === BULK_KEY) continue;
      covered.add(a.entityId);
      const ids = Array.isArray(a.payload?.dealIds) ? (a.payload.dealIds as unknown[]) : [];
      for (const x of ids) if (typeof x === "string") covered.add(x);
    }
    const dealIds = pendingDeals.map((d) => d.id).filter((id) => !covered.has(id));

    const [existing] = await db.select().from(s.approvals).where(and(eq(s.approvals.kind, "probability_override"), eq(s.approvals.entityId, BULK_KEY)));
    const summary = { pendingOverrideDeals: pendingDeals.length, coveredElsewhere: pendingDeals.length - dealIds.length, bulkDeals: dealIds.length, dryRun: dry };

    if (existing && existing.status !== "pending") {
      console.log(JSON.stringify({ ...summary, action: `skip (bulk approval already ${existing.status})`, approvalId: existing.id }, null, 2));
      return;
    }
    if (!dealIds.length) {
      console.log(JSON.stringify({ ...summary, action: "nothing to do" }, null, 2));
      return;
    }
    const prev = Array.isArray(existing?.payload?.dealIds) ? (existing.payload.dealIds as string[]) : null;
    if (prev && prev.length === dealIds.length && prev.every((id) => dealIds.includes(id))) {
      console.log(JSON.stringify({ ...summary, action: "up to date", approvalId: existing!.id }, null, 2));
      return;
    }
    if (dry) {
      console.log(JSON.stringify({ ...summary, action: existing ? "would refresh" : "would create" }, null, 2));
      return;
    }

    const probs = new Set(pendingDeals.filter((d) => dealIds.includes(d.id)).map((d) => d.p));
    const [only] = [...probs];
    const payload: Record<string, unknown> = { dealIds, source: "import" }; // the note carries the reason (shown once)
    if (probs.size === 1 && typeof only === "number") payload.to = only; // shown as "Requested N%" in Approvals
    let approvalId: string;
    if (existing) {
      await db.update(s.approvals).set({ payload }).where(eq(s.approvals.id, existing.id));
      approvalId = existing.id;
    } else {
      const [row] = await db
        .insert(s.approvals)
        .values({ kind: "probability_override", entity: "deal", entityId: BULK_KEY, requestedBy: REQUESTED_BY, approverRole: "executive", payload, note: NOTE })
        .returning({ id: s.approvals.id });
      approvalId = row!.id;
      const execs = await db
        .select({ id: s.user.id })
        .from(s.user)
        .where(and(eq(s.user.role, "executive"), sql`coalesce(${s.user.banned}, false) = false`));
      if (execs.length)
        await db.insert(s.notifications).values(
          execs.map((u) => ({
            userId: u.id,
            kind: "approval",
            title: `Approval requested: ${dealIds.length} imported probability overrides`,
            body: NOTE,
            href: "/tasks?tab=approvals",
          })),
        );
    }
    await db.insert(s.auditLog).values({
      actorId: REQUESTED_BY,
      actorKind: "system",
      action: existing ? "approval.refresh" : "approval.request",
      entity: "approval",
      entityId: approvalId,
      after: { kind: "probability_override", deals: dealIds.length, note: NOTE } as never,
    });
    console.log(JSON.stringify({ ...summary, action: existing ? "refreshed" : "created", approvalId }, null, 2));
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
