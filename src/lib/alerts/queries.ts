import "server-only";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import type { AppUser } from "@/lib/rbac/server";
import { alertHref, SEVERITY_RANK, type Severity } from "./rules";

export type AlertView = {
  id: string;
  ruleCode: string;
  ruleName: string | null;
  entity: string;
  entityId: string;
  href: string;
  severity: Severity;
  title: string;
  detail: string | null;
  suggestedAction: string | null;
  state: string;
  snoozedUntil: string | null;
  escalatedAt: string | null;
  createdAt: string;
};

const ACTIVE = ["open", "acknowledged", "escalated"] as const;

/** Alerts addressed to the user, most severe first. Snoozed ones only when includeSnoozed. */
export async function listMyAlerts(user: AppUser, opts: { limit?: number; includeSnoozed?: boolean } = {}): Promise<AlertView[]> {
  const states = opts.includeSnoozed ? [...ACTIVE, "snoozed" as const] : [...ACTIVE];
  const rows = await db
    .select({ a: s.alerts, ruleName: s.alertRules.name })
    .from(s.alerts)
    .leftJoin(s.alertRules, eq(s.alertRules.code, s.alerts.ruleCode))
    .where(and(eq(s.alerts.recipientId, user.id), inArray(s.alerts.state, states)))
    .orderBy(
      sql`case ${s.alerts.severity} when 'critical' then 0 when 'serious' then 1 when 'warning' then 2 else 3 end`,
      desc(s.alerts.createdAt),
    )
    .limit(opts.limit ?? 200);
  return rows.map(({ a, ruleName }) => ({
    id: a.id,
    ruleCode: a.ruleCode,
    ruleName,
    entity: a.entity,
    entityId: a.entityId,
    href: alertHref(a.entity, a.entityId),
    severity: a.severity,
    title: a.title,
    detail: a.detail,
    suggestedAction: a.suggestedAction,
    state: a.state,
    snoozedUntil: a.snoozedUntil?.toISOString() ?? null,
    escalatedAt: a.escalatedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  }));
}

export async function alertCountsBySeverity(user: AppUser): Promise<Record<Severity, number>> {
  const rows = await db
    .select({ severity: s.alerts.severity, n: count() })
    .from(s.alerts)
    .where(and(eq(s.alerts.recipientId, user.id), inArray(s.alerts.state, [...ACTIVE])))
    .groupBy(s.alerts.severity);
  const out: Record<Severity, number> = { critical: 0, serious: 0, warning: 0, info: 0 };
  for (const r of rows) out[r.severity] = r.n;
  return out;
}

export function sortBySeverity<T extends { severity: Severity }>(list: T[]): T[] {
  return [...list].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}
