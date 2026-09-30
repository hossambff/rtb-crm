import "server-only";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { normalizeBudget, type BudgetSettings } from "./budget-core";
import { DEFAULT_CORE_VERTICALS, DEFAULT_SUPPORTED_COUNTRIES, DEFAULT_SWEET_SPOT, normalizeWeights, type FitWeights, type SweetSpot } from "./fit";

/** App-settings keys used by Lead Scout (seeded by scripts/seed.ts). */
export const SCOUT_SETTING_KEYS = [
  "scout.visits_per_unique",
  "scout.visits_per_unique_by_category",
  "scout.muu_sweet_spot",
  "scout.fit_weights",
  "scout.core_verticals",
  "scout.supported_countries",
  "scout.budget",
  "scout.target_roles",
  "scout.auto_promote_valid_senior",
  "pipeline.usd_per_muu",
] as const;

export const DEFAULT_TARGET_ROLES: Record<string, string[]> = {
  NET: ["Founder", "Publisher", "Editor-in-Chief", "CEO", "GM"],
  SPT: ["Founder", "Publisher", "Editor-in-Chief", "CEO", "GM"],
  ENT: ["CEO", "CRO", "Chief Digital Officer", "CTO", "CPO", "Head of Ad Ops", "CFO"],
  R100: ["Head of Communications", "PR", "CMO", "Investor Relations"],
};

export type ScoutSettings = {
  visitsPerUnique: number;
  visitsPerUniqueByCategory: Record<string, number>;
  sweetSpot: SweetSpot;
  fitWeights: FitWeights;
  rawFitWeights: Record<string, number>;
  coreVerticals: string[];
  supportedCountries: string[];
  budget: BudgetSettings;
  targetRoles: Record<string, string[]>;
  autoPromoteValidSenior: boolean;
  usdPerMuu: number;
};

export async function getScoutSettings(): Promise<ScoutSettings> {
  const rows = await db.select().from(appSettings).where(inArray(appSettings.key, [...SCOUT_SETTING_KEYS]));
  const m = new Map(rows.map((r) => [r.key, r.value as unknown]));
  const num = (k: string, d: number) => (typeof m.get(k) === "number" && (m.get(k) as number) > 0 ? (m.get(k) as number) : d);
  const obj = <T,>(k: string, d: T): T => (m.get(k) && typeof m.get(k) === "object" ? (m.get(k) as T) : d);
  const rawWeights = obj<Record<string, number>>("scout.fit_weights", {});
  return {
    visitsPerUnique: num("scout.visits_per_unique", 2.5),
    visitsPerUniqueByCategory: obj("scout.visits_per_unique_by_category", { News: 3, Sports: 2 }),
    sweetSpot: { ...DEFAULT_SWEET_SPOT, ...obj<Partial<SweetSpot>>("scout.muu_sweet_spot", {}) } as SweetSpot,
    fitWeights: normalizeWeights(rawWeights),
    rawFitWeights: rawWeights,
    coreVerticals: Array.isArray(m.get("scout.core_verticals")) ? (m.get("scout.core_verticals") as string[]) : DEFAULT_CORE_VERTICALS,
    supportedCountries: Array.isArray(m.get("scout.supported_countries")) ? (m.get("scout.supported_countries") as string[]) : DEFAULT_SUPPORTED_COUNTRIES,
    budget: normalizeBudget(m.get("scout.budget")),
    targetRoles: { ...DEFAULT_TARGET_ROLES, ...obj<Record<string, string[]>>("scout.target_roles", {}) },
    autoPromoteValidSenior: m.get("scout.auto_promote_valid_senior") === true,
    usdPerMuu: num("pipeline.usd_per_muu", 1),
  };
}
