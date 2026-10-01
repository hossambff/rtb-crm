import "server-only";
import { and, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { logServerError } from "@/lib/errors";
import { notify } from "@/lib/notifications/notify";
import { isSensitiveEntity } from "@/lib/notifications/sensitive";
import { getSetting } from "@/lib/settings";
import { activeUserWhere } from "@/lib/users";
import { approvalHref } from "@/lib/slack/core";
import { appUserById } from "@/lib/slack/identity";
import { approvalKindLabel } from "./kinds";
import { routeRestrictedApproval } from "./routing";
import { restrictedFallbackTitle } from "./routing-core";
import { canDecide, getApprovalHandler, type ApprovalRow } from "./registry";
import { computeDueAt, escalationRoles, fmtDuration, normalizeSlaSettings, SLA_SETTINGS_KEY, type SlaSettings } from "./sla-core";
import { scheduleApprovalCardRefresh } from "@/lib/slack/card-refresh";

/** Approval SLAs (docs/V2_SPEC.md §C7). Owner: WS-E1. */

export async function getSlaSettings(): Promise<SlaSettings> {
  try {
    return normalizeSlaSettings(await getSetting<unknown>(SLA_SETTINGS_KEY, null));
  } catch {
    return normalizeSlaSettings(null);
  }
}

/** Due date for a new request of `kind`. Modules that insert approvals directly spread `await approvalSlaFields(kind)`. */
export async function approvalDueAt(kind: string, from: Date = new Date()): Promise<Date> {
  return computeDueAt(kind, from, await getSlaSettings());
}

export async function approvalSlaFields(kind: string, from: Date = new Date()): Promise<{ dueAt: Date }> {
  return { dueAt: await approvalDueAt(kind, from) };
}

/** Effective due date of an existing row (rows created before SLAs, or by a path that didn't set dueAt). */
export function effectiveDueAt(a: Pick<ApprovalRow, "kind" | "createdAt" | "dueAt">, settings: SlaSettings): Date {
  return a.dueAt ?? computeDueAt(a.kind, a.createdAt, settings);
}

const MAX_RECIPIENTS = 20;

async function decidersAmong(approval: ApprovalRow, roles: string[]): Promise<{ id: string; label: string | null }[]> {
  const users = await db
    .select({ id: s.user.id })
    .from(s.user)
    .where(and(inArray(s.user.role, roles), activeUserWhere, ne(s.user.id, approval.requestedBy)))
    .limit(60);
  const out: { id: string; label: string | null }[] = [];
  const h = getApprovalHandler(approval.kind);
  for (const u of users) {
    if (out.length >= MAX_RECIPIENTS) break;
    const appUser = await appUserById(u.id);
    if (!appUser || !(await canDecide(appUser, approval))) continue;
    out.push({ id: u.id, label: h.label ? await h.label(appUser, approval).catch(() => null) : null });
  }
  return out;
}

/**
 * The 5-minute tick job. Idempotent and bounded; never throws.
 * 1. Backfills `dueAt` on pending rows that lack one (direct inserts by other modules, pre-SLA rows).
 * 2. For each pending request past its due date and not yet escalated: atomically claims it (escalatedAt is set only
 *    while still null and pending — so it happens exactly once, even with overlapping ticks), then notifies the backup
 *    approvers (next role up) who can actually decide it; if none can, the regular approvers get an overdue reminder.
 */
export async function escalateOverdueApprovals(opts: { now?: Date; limit?: number; deadlineMs?: number } = {}): Promise<{ escalated: number; backfilled: number; digestPosted: boolean }> {
  const now = opts.now ?? new Date();
  const deadline = opts.deadlineMs ?? Date.now() + 60_000;
  let escalated = 0;
  let backfilled = 0;
  try {
    const settings = await getSlaSettings();

    const missing = await db
      .select({ id: s.approvals.id, kind: s.approvals.kind, createdAt: s.approvals.createdAt })
      .from(s.approvals)
      .where(and(eq(s.approvals.status, "pending"), isNull(s.approvals.dueAt)))
      .limit(200);
    for (const m of missing) {
      if (Date.now() > deadline) break;
      const r = await db
        .update(s.approvals)
        .set({ dueAt: computeDueAt(m.kind, m.createdAt, settings) })
        .where(and(eq(s.approvals.id, m.id), isNull(s.approvals.dueAt)))
        .returning({ id: s.approvals.id });
      backfilled += r.length;
    }

    const overdue = await db
      .select()
      .from(s.approvals)
      .where(and(eq(s.approvals.status, "pending"), isNull(s.approvals.escalatedAt), lt(s.approvals.dueAt, now)))
      .orderBy(s.approvals.dueAt)
      .limit(opts.limit ?? 25);

    for (const a of overdue) {
      if (Date.now() > deadline) break;
      const [claimed] = await db
        .update(s.approvals)
        .set({ escalatedAt: now })
        .where(and(eq(s.approvals.id, a.id), eq(s.approvals.status, "pending"), isNull(s.approvals.escalatedAt)))
        .returning();
      if (!claimed) continue;
      escalated++;
      scheduleApprovalCardRefresh({ ids: [claimed.id] }); // earlier Slack cards show "Escalated"
      try {
        const backupRoles = escalationRoles(claimed.approverRole);
        let recipients = await decidersAmong(claimed, backupRoles);
        const reminder = recipients.length === 0;
        if (reminder) {
          recipients = await decidersAmong(claimed, Array.from(new Set([claimed.approverRole, "executive", "admin", "super_admin"])));
        }
        const kindLabel = approvalKindLabel(claimed.kind);
        const sensitive = await isSensitiveEntity(claimed.entity, claimed.entityId);
        let fallback = false;
        if (sensitive) {
          // QA MIN-36: restricted subject → only deciders on the access list (or super_admin); none → super_admins, neutral.
          const routed = await routeRestrictedApproval(claimed, recipients.map((r) => r.id));
          const labels = new Map(recipients.map((r) => [r.id, r.label]));
          fallback = routed.fallback;
          recipients = routed.recipients.map((id) => ({ id, label: fallback ? null : (labels.get(id) ?? null) }));
        }
        const late = claimed.dueAt ? fmtDuration(now.getTime() - claimed.dueAt.getTime()) : null;
        for (const r of recipients) {
          await notify(r.id, {
            kind: "approval",
            title: fallback ? restrictedFallbackTitle(kindLabel) : `${reminder ? "Overdue" : "Escalated to you"}: ${kindLabel}${r.label ? ` · ${r.label}` : ""}`.slice(0, 300),
            body: `Waiting since ${claimed.createdAt.toISOString().slice(0, 10)}${late ? `, ${late} past its SLA` : ""}.`,
            href: approvalHref(claimed.id),
            sensitive,
          });
        }
        await audit({
          actorId: null,
          actorKind: "system",
          action: "approval.escalated",
          entity: "approval",
          entityId: claimed.id,
          after: { dueAt: claimed.dueAt, escalatedAt: now, notified: recipients.map((r) => r.id), mode: reminder ? "reminder" : "backup", roles: backupRoles },
        });
      } catch (e) {
        logServerError("approvals.escalate_notify", e);
      }
    }
  } catch (e) {
    logServerError("approvals.escalate", e);
  }
  // The optional Slack channel digest rides on this job's 5-minute cadence (posts at most once a day; no-op when Slack
  // or the digest is off). Lazy import keeps Slack out of the approvals module graph.
  let digestPosted = false;
  try {
    const { postSlackChannelDigest } = await import("@/lib/slack/digest");
    digestPosted = (await postSlackChannelDigest(now)).posted;
  } catch {
    // never throws
  }
  return { escalated, backfilled, digestPosted };
}

/** Count of pending requests past due (Slack channel digest, Today badges). */
export async function overdueApprovalCount(now: Date = new Date()): Promise<{ pending: number; overdue: number }> {
  const [r] = await db
    .select({
      pending: sql<number>`count(*)::int`,
      overdue: sql<number>`count(*) filter (where ${s.approvals.dueAt} < ${now.toISOString()})::int`,
    })
    .from(s.approvals)
    .where(eq(s.approvals.status, "pending"));
  return { pending: r?.pending ?? 0, overdue: r?.overdue ?? 0 };
}
