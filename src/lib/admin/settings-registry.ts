/**
 * Whitelist of org settings editable from /admin/settings, each with a strict zod schema (pure — unit-tested).
 * Only keys listed here can be written by the generic `updateSetting` action.
 */
import { z } from "zod";
import { MODEL_ID_RE } from "./config-schemas";

/** Agent action types (keys of agent.autonomy, from the seed) with PRD §11.4 labels. */
export const AUTONOMY_ACTIONS = [
  { key: "task_from_commitment", label: "Create tasks from commitments" },
  { key: "link_email", label: "Link emails to records" },
  { key: "link_transcript", label: "Link transcripts to records" },
  { key: "log_activity", label: "Log activities" },
  { key: "next_step_update", label: "Update next steps" },
  { key: "stage_change", label: "Change deal stage" },
  { key: "field_update_value", label: "Update value fields" },
  { key: "create_contact", label: "Create contacts" },
  { key: "send_email", label: "Send email" },
] as const;
export type AutonomyAction = (typeof AUTONOMY_ACTIONS)[number]["key"];

/** PRD §11.4 autonomy levels. */
export const AUTONOMY_LEVELS = [
  { value: 0, label: "0 · Off", hint: "Agent does nothing" },
  { value: 1, label: "1 · Suggest", hint: "Shows a suggestion; the user must accept" },
  { value: 2, label: "2 · Auto + notify", hint: "Performs the action and tells the user; undo within 24h" },
  { value: 3, label: "3 · Auto silent", hint: "Performs the action quietly (still audit-logged)" },
] as const;

const level = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const int = (min: number, max: number, unit: string) =>
  z
    .number({ error: `Enter a whole number of ${unit}` })
    .int(`Whole ${unit} only`)
    .min(min, `Must be between ${min} and ${max} ${unit}`)
    .max(max, `Must be between ${min} and ${max} ${unit}`);

const autonomyShape = Object.fromEntries(AUTONOMY_ACTIONS.map((a) => [a.key, level])) as Record<AutonomyAction, typeof level>;

export const SETTINGS_REGISTRY = {
  "ai.model_fast": {
    label: "Fast model",
    schema: z.string().trim().regex(MODEL_ID_RE, "Use the format provider/model"),
    fallback: "google/gemini-2.5-flash",
  },
  "ai.model_strong": {
    label: "Strong model",
    schema: z.string().trim().regex(MODEL_ID_RE, "Use the format provider/model"),
    fallback: "openai/gpt-5-mini",
  },
  "agent.autonomy": {
    label: "Agent autonomy",
    // PRD §11.4: the agent never sends external email without an explicit human action → send_email is capped at Suggest.
    schema: z.strictObject(autonomyShape).refine((v) => v.send_email <= 1, {
      message: "Send email can be at most “Suggest” — the agent never sends external email on its own.",
    }),
    fallback: {
      task_from_commitment: 2,
      link_email: 2,
      link_transcript: 2,
      log_activity: 2,
      next_step_update: 2,
      stage_change: 1,
      field_update_value: 1,
      create_contact: 1,
      send_email: 0,
    } as Record<AutonomyAction, 0 | 1 | 2 | 3>,
  },
  "agent.claims_mode": {
    label: "Claims guardrail mode",
    schema: z.enum(["warn", "block"]),
    fallback: "warn" as "warn" | "block",
  },
  "email.backfill_days": { label: "Email backfill (days)", schema: int(1, 365, "days"), fallback: 90 },
  "email.unanswered_hours": { label: "Unanswered after (hours)", schema: int(1, 720, "hours"), fallback: 24 },
  "email.retention_unlinked_days": { label: "Keep unlinked emails (days)", schema: int(0, 365, "days"), fallback: 7 },
  "r100.goal_live": { label: "RTB100 live goal", schema: int(1, 100000, "companies"), fallback: 100 },
  "commission.registration_protect_days": { label: "Registration protection (days)", schema: int(1, 365, "days"), fallback: 90 },
  "pipeline.usd_per_muu": {
    label: "Default $ per MUU / yr",
    schema: z.number({ error: "Enter a number" }).gt(0, "Must be greater than 0").max(1000, "Too large"),
    fallback: 1,
  },
  "pipeline.engaged_threshold": {
    label: "Engaged probability threshold",
    schema: z.number({ error: "Enter a number" }).min(0, "Must be between 0 and 100%").max(1, "Must be between 0 and 100%"),
    fallback: 0.5,
  },
  "pipeline.override_approval_threshold_pts": {
    label: "Override approval threshold (pts)",
    schema: z.number({ error: "Enter a number" }).min(0, "Must be between 0 and 100").max(100, "Must be between 0 and 100"),
    fallback: 30,
  },
} as const;

export type SettingKey = keyof typeof SETTINGS_REGISTRY;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS_REGISTRY)[K]["schema"]>;
export type SettingsValues = { [K in SettingKey]: SettingValue<K> };
export const SETTING_KEYS = Object.keys(SETTINGS_REGISTRY) as SettingKey[];

export function isWritableSetting(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY, key);
}

export function validateSetting(key: string, value: unknown): { ok: true; key: SettingKey; value: unknown } | { ok: false; error: string } {
  if (!isWritableSetting(key)) return { ok: false, error: `Setting "${key}" cannot be changed here.` };
  const res = (SETTINGS_REGISTRY[key].schema as z.ZodType).safeParse(value);
  if (!res.success) return { ok: false, error: res.error.issues[0]?.message ?? "Invalid value" };
  return { ok: true, key, value: res.data };
}

/** Coerce a stored value to the registry type, falling back to the default when it's missing or malformed. */
export function readSetting<K extends SettingKey>(key: K, stored: unknown): SettingValue<K> {
  const def = SETTINGS_REGISTRY[key];
  if (key === "agent.autonomy" && stored && typeof stored === "object") {
    // Tolerate partial / extra keys in stored JSON: merge onto defaults.
    const merged: Record<string, unknown> = { ...(def.fallback as object) };
    for (const a of AUTONOMY_ACTIONS) {
      const v = (stored as Record<string, unknown>)[a.key];
      if (v === 0 || v === 1 || v === 2 || v === 3) merged[a.key] = v;
    }
    return merged as SettingValue<K>;
  }
  const res = (def.schema as z.ZodType).safeParse(stored);
  return (res.success ? res.data : def.fallback) as SettingValue<K>;
}

/**
 * Input schema for the generic settings action: a discriminated union over whitelisted keys so zod field errors
 * land on `value`.
 */
export const settingUpdateSchema = z.discriminatedUnion(
  "key",
  SETTING_KEYS.map((k) => z.object({ key: z.literal(k), value: SETTINGS_REGISTRY[k].schema as z.ZodType })) as unknown as [
    z.ZodObject<{ key: z.ZodLiteral<string>; value: z.ZodType }>,
    ...z.ZodObject<{ key: z.ZodLiteral<string>; value: z.ZodType }>[],
  ],
);
