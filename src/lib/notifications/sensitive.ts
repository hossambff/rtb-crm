import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { parseEntityRef, type SubjectEntity } from "./sensitive-core";

/**
 * MNPI hard guard helpers for notify() call sites (V2 §0.4): is the subject of a notification a restricted record?
 * A deal counts as restricted when the deal or its account is restricted. Fails closed (true) on lookup errors, so the
 * worst case is a notification that stays in-app instead of also reaching Slack.
 */
export async function isSensitive(ref: { dealId?: string | null; accountId?: string | null }): Promise<boolean> {
  try {
    if (ref.dealId) {
      const [d] = await db
        .select({ r: s.deals.restricted, ar: s.accounts.restricted })
        .from(s.deals)
        .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
        .where(eq(s.deals.id, ref.dealId));
      if (d?.r || d?.ar) return true;
    }
    if (ref.accountId) {
      const [a] = await db.select({ r: s.accounts.restricted }).from(s.accounts).where(eq(s.accounts.id, ref.accountId));
      if (a?.r) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export type Subject = { dealId: string | null; accountId: string | null };

/**
 * The deal / account behind a polymorphic `entity` / `entityId` pair (alerts, approvals). Ids may carry a `#…` suffix.
 * Returns null when the entity can't describe a deal or account ("none"); throws `UnknownSubject` for unrecognized
 * entities that carry a record id (callers fail closed).
 */
export class UnknownSubject extends Error {}

export async function resolveSubject(entity: string | null | undefined, entityId: string | null | undefined, depth = 0): Promise<Subject | null> {
  const ref = parseEntityRef(entity, entityId);
  if (ref.kind === "none") return null;
  if (ref.kind === "unknown") throw new UnknownSubject(entity ?? "");
  const id = ref.id;
  const one = async <T,>(p: Promise<T[]>) => (await p)[0];
  switch (ref.entity as SubjectEntity) {
    case "deal":
      return { dealId: id, accountId: null };
    case "account":
      return { dealId: null, accountId: id };
    case "proposal": {
      const p = await one(db.select({ dealId: s.proposals.dealId }).from(s.proposals).where(eq(s.proposals.id, id)));
      return { dealId: p?.dealId ?? null, accountId: null };
    }
    case "task": {
      const t = await one(db.select({ dealId: s.tasks.dealId, accountId: s.tasks.accountId }).from(s.tasks).where(eq(s.tasks.id, id)));
      return { dealId: t?.dealId ?? null, accountId: t?.accountId ?? null };
    }
    case "migration": {
      const m = await one(db.select({ dealId: s.migrationProjects.dealId, accountId: s.migrationProjects.accountId }).from(s.migrationProjects).where(eq(s.migrationProjects.id, id)));
      return { dealId: m?.dealId ?? null, accountId: m?.accountId ?? null };
    }
    case "invoice": {
      const i = await one(db.select({ dealId: s.invoices.dealId }).from(s.invoices).where(eq(s.invoices.id, id)));
      return { dealId: i?.dealId ?? null, accountId: null };
    }
    case "lead_registration": {
      const r = await one(db.select({ accountId: s.leadRegistrations.accountId }).from(s.leadRegistrations).where(eq(s.leadRegistrations.id, id)));
      return { dealId: null, accountId: r?.accountId ?? null };
    }
    case "meeting": {
      const m = await one(db.select({ dealId: s.meetings.dealId, accountId: s.meetings.accountId }).from(s.meetings).where(eq(s.meetings.id, id)));
      return { dealId: m?.dealId ?? null, accountId: m?.accountId ?? null };
    }
    case "email_thread": {
      const t = await one(db.select({ dealId: s.emailThreads.dealId, accountId: s.emailThreads.accountId }).from(s.emailThreads).where(eq(s.emailThreads.id, id)));
      return { dealId: t?.dealId ?? null, accountId: t?.accountId ?? null };
    }
    case "help_request": {
      const h = await one(db.select({ dealId: s.helpRequests.dealId }).from(s.helpRequests).where(eq(s.helpRequests.id, id)));
      return { dealId: h?.dealId ?? null, accountId: null };
    }
    case "handoff": {
      const h = await one(db.select({ dealId: s.handoffs.dealId }).from(s.handoffs).where(eq(s.handoffs.id, id)));
      return { dealId: h?.dealId ?? null, accountId: null };
    }
    case "approval": {
      if (depth > 1) throw new UnknownSubject("approval");
      const a = await one(db.select({ entity: s.approvals.entity, entityId: s.approvals.entityId }).from(s.approvals).where(eq(s.approvals.id, id)));
      return a ? resolveSubject(a.entity, a.entityId, depth + 1) : { dealId: null, accountId: null };
    }
  }
}

/**
 * Same check for a polymorphic `entity` / `entityId` pair (approvals, alerts). Covers deals, accounts, proposals, tasks,
 * migration projects, invoices, lead registrations, meetings, email threads, help requests and handoffs; strips `#…`
 * suffixes. Fails closed (true) for unrecognized entities that carry a record id and on lookup errors.
 */
export async function isSensitiveEntity(entity: string | null | undefined, entityId: string | null | undefined): Promise<boolean> {
  try {
    const subject = await resolveSubject(entity, entityId);
    if (!subject) return false;
    return await isSensitive(subject);
  } catch {
    return true;
  }
}
