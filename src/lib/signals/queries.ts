import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealAccessWhere, scopeFor, type AppUser } from "@/lib/rbac/server";
import { freshSignalSql } from "./service";
import type { SignalKind } from "./core";

export type DealSignalView = {
  id: string;
  dealId: string;
  dealName: string;
  kind: SignalKind;
  source: "email" | "transcript";
  sourceHref: string | null;
  quote: string | null;
  rationale: string | null;
  confidence: number | null;
  engine: string | null;
  suggestedStageId: string | null;
  suggestedStageName: string | null;
  suggestedCloseDate: string | null;
  createdAt: string;
};

const columns = {
  id: s.dealSignals.id,
  dealId: s.dealSignals.dealId,
  dealName: s.deals.name,
  kind: s.dealSignals.kind,
  source: s.dealSignals.source,
  sourceId: s.dealSignals.sourceId,
  quote: s.dealSignals.quote,
  rationale: s.dealSignals.rationale,
  confidence: s.dealSignals.confidence,
  engine: s.dealSignals.engine,
  suggestedStageId: s.dealSignals.suggestedStageId,
  suggestedStageName: s.stages.name,
  suggestedCloseDate: s.dealSignals.suggestedCloseDate,
  createdAt: s.dealSignals.createdAt,
};

type Row = {
  id: string;
  dealId: string;
  dealName: string;
  kind: string;
  source: string;
  sourceId: string;
  quote: string | null;
  rationale: string | null;
  confidence: number | null;
  engine: string | null;
  suggestedStageId: string | null;
  suggestedStageName: string | null;
  suggestedCloseDate: Date | null;
  createdAt: Date;
};

/**
 * Link to the evidence — only when the viewer may open it: the email thread for the mailbox owner (inbox threads are
 * per-mailbox), the call page for transcripts (its own page re-checks visibility).
 */
async function sourceHrefs(user: AppUser, rows: Row[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const emailIds = rows.filter((r) => r.source === "email").map((r) => r.sourceId);
  if (emailIds.length) {
    const threads = await db
      .select({ messageId: s.emailMessages.id, threadId: s.emailThreads.id, owner: s.emailThreads.mailboxUserId })
      .from(s.emailMessages)
      .innerJoin(s.emailThreads, eq(s.emailThreads.id, s.emailMessages.threadId))
      .where(and(inArray(s.emailMessages.id, emailIds), eq(s.emailThreads.private, false)));
    for (const t of threads) if (t.owner === user.id) out.set(t.messageId, `/inbox?thread=${t.threadId}`);
  }
  const callIds = rows.filter((r) => r.source === "transcript").map((r) => r.sourceId);
  if (callIds.length) {
    const scope = await scopeFor(user, "calls", "view");
    if (scope !== "none") {
      const calls = await db.select({ id: s.transcripts.id, uploadedBy: s.transcripts.uploadedBy }).from(s.transcripts).where(inArray(s.transcripts.id, callIds));
      // Own calls always; team/all scopes see others' calls on deals they can view (the call page re-checks).
      for (const c of calls) if (c.uploadedBy === user.id || scope !== "own") out.set(c.id, `/calls/${c.id}`);
    }
  }
  return out;
}

function toView(r: Row, hrefs: Map<string, string>): DealSignalView {
  return {
    id: r.id,
    dealId: r.dealId,
    dealName: r.dealName,
    kind: r.kind as SignalKind,
    source: r.source === "email" ? "email" : "transcript",
    sourceHref: hrefs.get(r.sourceId) ?? null,
    // A call quote is shown only to people who may open that call (email excerpts already sit on the deal timeline).
    quote: r.source === "transcript" && !hrefs.has(r.sourceId) ? null : r.quote,
    rationale: r.rationale,
    confidence: r.confidence,
    engine: r.engine,
    suggestedStageId: r.suggestedStageId,
    suggestedStageName: r.suggestedStageName,
    suggestedCloseDate: r.suggestedCloseDate?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Pending, fresh signals on one deal the user can see (dealAccessWhere covers scope + restricted access lists). */
export async function listDealSignals(user: AppUser, dealId: string): Promise<DealSignalView[]> {
  const where = await dealAccessWhere(user, "view");
  const rows = (await db
    .select(columns)
    .from(s.dealSignals)
    .innerJoin(s.deals, eq(s.deals.id, s.dealSignals.dealId))
    .leftJoin(s.stages, eq(s.stages.id, s.dealSignals.suggestedStageId))
    .where(and(eq(s.dealSignals.dealId, dealId), eq(s.dealSignals.status, "pending"), freshSignalSql, isNull(s.deals.deletedAt), where))
    .orderBy(desc(s.dealSignals.createdAt))
    .limit(10)) as Row[];
  const hrefs = await sourceHrefs(user, rows);
  return rows.map((r) => toView(r, hrefs));
}

/** Pending signals on deals the user owns (Today queue). One indexed query; bounded. */
export async function pendingSignalsForOwner(user: AppUser, limit = 15): Promise<DealSignalView[]> {
  const where = await dealAccessWhere(user, "view");
  const rows = (await db
    .select(columns)
    .from(s.dealSignals)
    .innerJoin(s.deals, eq(s.deals.id, s.dealSignals.dealId))
    .leftJoin(s.stages, eq(s.stages.id, s.dealSignals.suggestedStageId))
    .where(and(eq(s.dealSignals.status, "pending"), freshSignalSql, eq(s.deals.ownerId, user.id), isNull(s.deals.deletedAt), where))
    .orderBy(desc(s.dealSignals.createdAt))
    .limit(limit)) as Row[];
  const hrefs = await sourceHrefs(user, rows);
  return rows.map((r) => toView(r, hrefs));
}
