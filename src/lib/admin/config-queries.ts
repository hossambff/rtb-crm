import "server-only";
import { and, asc, count, eq, inArray, isNotNull, like, ne, or, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { presetSettingKey, type ProbabilityPreset } from "./presets";
import { readSetting, SETTING_KEYS, type SettingsValues } from "./settings-registry";

/* ───────────────────────────── Pipelines & stages ───────────────────────────── */

export type AdminStage = {
  id: string;
  key: string;
  name: string;
  sortOrder: number;
  probability: number;
  category: "open" | "won" | "lost" | "hold";
  slaDays: number | null;
  requiredFields: string[];
  requiresApproval: boolean;
  importAliases: string[];
  dealCount: number;
};
export type AdminPipeline = {
  id: string;
  key: string;
  type: string;
  name: string;
  description: string | null;
  unit: "muu" | "usd" | "activation";
  color: string;
  usdPerMuu: number;
  defaultRevSharePct: number | null;
  active: boolean;
  preset: ProbabilityPreset | null;
  stages: AdminStage[];
};

export async function getPipelinesWithStages(): Promise<AdminPipeline[]> {
  const [pipes, stageRows, counts, presets] = await Promise.all([
    db.select().from(s.pipelines).orderBy(asc(s.pipelines.sortOrder), asc(s.pipelines.name)),
    db.select().from(s.stages).orderBy(asc(s.stages.sortOrder)),
    db.select({ stageId: s.deals.stageId, n: count() }).from(s.deals).groupBy(s.deals.stageId),
    db.select().from(s.appSettings).where(like(s.appSettings.key, "pipeline.probability_preset.%")),
  ]);
  const countBy = new Map(counts.map((c) => [c.stageId, Number(c.n)]));
  const presetBy = new Map(presets.map((p) => [p.key, p.value]));
  return pipes.map((p) => {
    const stored = presetBy.get(presetSettingKey(p.key));
    return {
      id: p.id,
      key: p.key,
      type: p.type,
      name: p.name,
      description: p.description,
      unit: p.unit,
      color: p.color,
      usdPerMuu: p.usdPerMuu,
      defaultRevSharePct: p.defaultRevSharePct,
      active: p.active,
      preset: stored === "tiered" || stored === "granular" ? stored : null,
      stages: stageRows
        .filter((st) => st.pipelineId === p.id)
        .map((st) => ({
          id: st.id,
          key: st.key,
          name: st.name,
          sortOrder: st.sortOrder,
          probability: st.probability,
          category: st.category,
          slaDays: st.slaDays,
          requiredFields: st.requiredFields,
          requiresApproval: st.requiresApproval,
          importAliases: st.importAliases,
          dealCount: countBy.get(st.id) ?? 0,
        })),
    };
  });
}

/** Custom field keys defined for deals (all pipelines or the given one) — usable as stage-gate required fields. */
export async function getDealCustomFieldKeys(pipelineKey?: string): Promise<{ key: string; label: string; pipelineKey: string | null }[]> {
  const where = pipelineKey
    ? and(eq(s.customFieldDefs.entity, "deal"), or(isNull(s.customFieldDefs.pipelineKey), eq(s.customFieldDefs.pipelineKey, pipelineKey)))
    : eq(s.customFieldDefs.entity, "deal");
  return db
    .select({ key: s.customFieldDefs.key, label: s.customFieldDefs.label, pipelineKey: s.customFieldDefs.pipelineKey })
    .from(s.customFieldDefs)
    .where(where)
    .orderBy(asc(s.customFieldDefs.sortOrder), asc(s.customFieldDefs.label));
}

/** Pipeline keys + their stage keys (for field "required at stages" and product/team pipeline selectors). */
export async function getPipelineOptions(): Promise<{ key: string; name: string; color: string; stages: { key: string; name: string }[] }[]> {
  const [pipes, stageRows] = await Promise.all([
    db.select({ id: s.pipelines.id, key: s.pipelines.key, name: s.pipelines.name, color: s.pipelines.color }).from(s.pipelines).orderBy(asc(s.pipelines.sortOrder)),
    db.select({ pipelineId: s.stages.pipelineId, key: s.stages.key, name: s.stages.name }).from(s.stages).orderBy(asc(s.stages.sortOrder)),
  ]);
  return pipes.map((p) => ({
    key: p.key,
    name: p.name,
    color: p.color,
    stages: stageRows.filter((st) => st.pipelineId === p.id).map((st) => ({ key: st.key, name: st.name })),
  }));
}

/* ───────────────────────────── Fields & picklists ───────────────────────────── */

export type AdminFieldDef = typeof s.customFieldDefs.$inferSelect;
export async function getFieldDefs(): Promise<AdminFieldDef[]> {
  return db.select().from(s.customFieldDefs).orderBy(asc(s.customFieldDefs.entity), asc(s.customFieldDefs.sortOrder), asc(s.customFieldDefs.label));
}

export type AdminPicklistValue = typeof s.picklists.$inferSelect;
export async function getPicklists(): Promise<AdminPicklistValue[]> {
  return db.select().from(s.picklists).orderBy(asc(s.picklists.list), asc(s.picklists.sortOrder), asc(s.picklists.label));
}

export async function getPicklistLabels(lists: string[]): Promise<Record<string, string[]>> {
  const rows = await db
    .select({ list: s.picklists.list, label: s.picklists.label })
    .from(s.picklists)
    .where(and(inArray(s.picklists.list, lists), eq(s.picklists.active, true)))
    .orderBy(asc(s.picklists.sortOrder));
  const out: Record<string, string[]> = Object.fromEntries(lists.map((l) => [l, [] as string[]]));
  for (const r of rows) out[r.list]!.push(r.label);
  return out;
}

/* ───────────────────────────── Alerts ───────────────────────────── */

export type AdminAlertRule = typeof s.alertRules.$inferSelect;
export async function getAlertRules(): Promise<AdminAlertRule[]> {
  return db.select().from(s.alertRules).orderBy(asc(s.alertRules.code));
}

/* ───────────────────────────── Settings ───────────────────────────── */

export async function getAdminSettings(): Promise<SettingsValues> {
  const rows = await db.select().from(s.appSettings).where(inArray(s.appSettings.key, SETTING_KEYS));
  const by = new Map(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, readSetting(k, by.get(k))])) as SettingsValues;
}

export async function getAllowedDomains(): Promise<{ domain: string; createdAt: Date }[]> {
  return db.select().from(s.allowedDomains).orderBy(asc(s.allowedDomains.domain));
}

/* ───────────────────────────── Claims & products ───────────────────────────── */

export type AdminClaim = typeof s.claims.$inferSelect & { approverName: string | null; expired: boolean };
export async function getClaims(): Promise<AdminClaim[]> {
  const rows = await db
    .select({ c: s.claims, approverName: s.user.name })
    .from(s.claims)
    .leftJoin(s.user, eq(s.user.id, s.claims.approverId))
    .orderBy(asc(s.claims.status), asc(s.claims.text));
  const now = Date.now();
  return rows.map((r) => ({ ...r.c, approverName: r.approverName, expired: r.c.expiresAt ? r.c.expiresAt.getTime() < now : false }));
}

export type AdminProduct = typeof s.products.$inferSelect;
export async function getProducts(): Promise<AdminProduct[]> {
  return db.select().from(s.products).orderBy(asc(s.products.family), asc(s.products.name));
}

/* ───────────────────────────── Teams ───────────────────────────── */

export type AdminTeam = typeof s.teams.$inferSelect & { memberCount: number; leadName: string | null };
export async function getTeams(): Promise<AdminTeam[]> {
  const [rows, counts] = await Promise.all([
    db
      .select({ t: s.teams, leadName: s.user.name })
      .from(s.teams)
      .leftJoin(s.user, eq(s.user.id, s.teams.leadId))
      .orderBy(asc(s.teams.name)),
    db.select({ teamId: s.user.teamId, n: count() }).from(s.user).where(isNotNull(s.user.teamId)).groupBy(s.user.teamId),
  ]);
  const by = new Map(counts.map((c) => [c.teamId, Number(c.n)]));
  return rows.map((r) => ({ ...r.t, leadName: r.leadName, memberCount: by.get(r.t.id) ?? 0 }));
}

export async function getActiveUsers(): Promise<{ id: string; name: string; email: string }[]> {
  return db
    .select({ id: s.user.id, name: s.user.name, email: s.user.email })
    .from(s.user)
    .where(and(ne(s.user.role, "pending"), or(isNull(s.user.banned), eq(s.user.banned, false)), or(isNull(s.user.accessExpiresAt), sql`${s.user.accessExpiresAt} > now()`)))
    .orderBy(asc(s.user.name));
}
