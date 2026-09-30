/**
 * Pure zod schemas + helpers for the admin configuration pages (PRD §15).
 * No server-only imports: shared by server actions, client editors and unit tests.
 */
import { z } from "zod";
import { VIZ } from "@/lib/palette";

/* ───────────────────────────── Constants ───────────────────────────── */

export const STAGE_CATEGORIES = ["open", "won", "lost", "hold"] as const;
export const FIELD_ENTITIES = ["account", "contact", "deal"] as const;
export const FIELD_TYPES = ["text", "number", "currency", "percent", "date", "select", "multiselect", "checkbox", "url"] as const;
export const ALERT_SEVERITIES = ["info", "warning", "serious", "critical"] as const;
export const CLAIM_STATUSES = ["approved", "restricted", "banned"] as const;
export const PRICING_MODELS = ["rev_share", "fixed", "cpm", "package", "free"] as const;
export const PRODUCT_STATUSES = ["live", "beta", "upcoming", "retired"] as const;

export const FIELD_TYPE_LABELS: Record<(typeof FIELD_TYPES)[number], string> = {
  text: "Text",
  number: "Number",
  currency: "Currency",
  percent: "Percent",
  date: "Date",
  select: "Picklist (single)",
  multiselect: "Picklist (multi)",
  checkbox: "Checkbox",
  url: "URL",
};

export const PRICING_MODEL_LABELS: Record<(typeof PRICING_MODELS)[number], string> = {
  rev_share: "Revenue share",
  fixed: "Fixed fee",
  cpm: "CPM",
  package: "Package",
  free: "Free",
};

/** Known deal fields that a stage can require (stage gates). Custom deal field keys are added at runtime. */
export const DEAL_FIELDS = [
  { key: "muu", label: "MUU" },
  { key: "usdPerMuu", label: "$ per MUU" },
  { key: "revSharePct", label: "Revenue share %" },
  { key: "guaranteeType", label: "Guarantee type" },
  { key: "guaranteeMonthlyCents", label: "Monthly guarantee" },
  { key: "rampMonths", label: "Ramp months" },
  { key: "termYears", label: "Term (years)" },
  { key: "contractValueCents", label: "Contract value" },
  { key: "annualizedValueCents", label: "Annualized value" },
  { key: "primaryContactId", label: "Primary contact" },
  { key: "expectedCloseDate", label: "Expected close date" },
  { key: "nextStep", label: "Next step" },
  { key: "nextStepDueAt", label: "Next step due" },
  { key: "source", label: "Source" },
  { key: "priority", label: "Priority" },
  { key: "lostReason", label: "Lost reason" },
] as const;
export const DEAL_FIELD_KEYS: readonly string[] = DEAL_FIELDS.map((f) => f.key);

/** Picklists seeded by default (PRD §15); admins can create new lists too. */
export const DEFAULT_PICKLISTS = ["category", "league", "source", "lost_reason", "reject_reason", "contact_role", "hold_reason"] as const;

/* ───────────────────────────── Helpers ───────────────────────────── */

/** "Demo / Beta Review" → "demo_beta_review" (lowercase, a–z0–9 and underscores, ≤ 40 chars). */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/g, "");
}

/** Split a comma/newline separated list, trim, drop empties, dedupe (order preserved). */
export function parseList(text: string, opts: { lowercase?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const v = opts.lowercase ? raw.trim().toLowerCase() : raw.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Move the item with `id` one step up/down; returns a new array (unchanged when at the edge / not found). */
export function moveItem<T extends { id: string }>(items: T[], id: string, direction: "up" | "down"): T[] {
  const i = items.findIndex((x) => x.id === id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= items.length) return items;
  const next = items.slice();
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

export function regexError(pattern: string): string | null {
  try {
    new RegExp(pattern, "i");
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 160) : "Invalid regular expression";
  }
}

type ParamPrimitive = string | number | boolean;
export type ParamValue = ParamPrimitive | ParamPrimitive[];

function kindOf(v: unknown): "string" | "number" | "boolean" | "array" | "other" {
  if (Array.isArray(v)) return "array";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return typeof v as "string" | "number" | "boolean";
  return "other";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse text as a JSON object (not array/null). */
export function parseJsonObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim() === "" ? "{}" : text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message.slice(0, 120) : "parse error"}` };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: "Must be a JSON object, e.g. {\"days\": 7}." };
  return { ok: true, value: parsed };
}

/**
 * Validate alert-rule params JSON (PRD §12.1 thresholds are admin-editable):
 * - must be a JSON object whose values are number | string | boolean | array of those;
 * - must keep the same keys as the current params, each with the same type (arrays keep their element type).
 */
export function validateAlertParams(
  text: string,
  current: Record<string, unknown>,
): { ok: true; value: Record<string, ParamValue> } | { ok: false; error: string } {
  const res = parseJsonObject(text);
  if (!res.ok) return res;
  const value = res.value;
  for (const [k, v] of Object.entries(value)) {
    const kind = kindOf(v);
    if (kind === "other") return { ok: false, error: `"${k}" must be a number, string, boolean or an array of those.` };
    if (kind === "array" && !(v as unknown[]).every((x) => ["string", "number", "boolean"].includes(kindOf(x))))
      return { ok: false, error: `"${k}" must be an array of numbers, strings or booleans.` };
    if (!(k in current)) return { ok: false, error: `Unknown parameter "${k}". Allowed: ${Object.keys(current).join(", ") || "none"}.` };
    const curKind = kindOf(current[k]);
    if (curKind !== "other" && curKind !== kind) return { ok: false, error: `"${k}" must stay a ${curKind} (got ${kind}).` };
    if (kind === "array") {
      const curArr = current[k] as unknown[];
      const elKind = curArr.length ? kindOf(curArr[0]) : null;
      if (elKind && !(v as unknown[]).every((x) => kindOf(x) === elKind)) return { ok: false, error: `"${k}" must be an array of ${elKind}s.` };
    }
    if (kind === "number" && !Number.isFinite(v)) return { ok: false, error: `"${k}" must be a finite number.` };
  }
  for (const k of Object.keys(current)) {
    if (!(k in value)) return { ok: false, error: `Missing parameter "${k}".` };
  }
  return { ok: true, value: value as Record<string, ParamValue> };
}

/* ───────────────────────────── Shared field schemas ───────────────────────────── */

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const uuid = z.uuid();
const probability = z.number({ error: "Enter a number" }).min(0, "Must be between 0 and 100%").max(1, "Must be between 0 and 100%");
const slaDays = z.number({ error: "Enter a whole number of days" }).int("Whole days only").min(1, "At least 1 day").max(365, "At most 365 days").nullable();
const slugKey = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "Lowercase letters, digits and underscores; must start with a letter (max 40)");
const stringList = (max: number, itemMax = 80) => z.array(z.string().trim().min(1).max(itemMax)).max(max);

/* ───────────────────────────── Pipelines & stages ───────────────────────────── */

export const pipelineUpdateSchema = z.object({
  id: uuid,
  name: z.string().trim().min(2, "Name is required").max(80),
  description: optText(500),
  color: z
    .string()
    .trim()
    .transform((c) => c.toUpperCase())
    .refine((c) => (VIZ as readonly string[]).includes(c), "Pick one of the palette colors"),
  usdPerMuu: z.number({ error: "Enter a number" }).gt(0, "Must be greater than 0").max(1000, "Too large"),
  defaultRevSharePct: probability.nullable(),
  active: z.boolean(),
});

export const stageCreateSchema = z.object({
  pipelineId: uuid,
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(60)
    .refine((n) => slugify(n).length > 0, "Name must contain letters or digits"),
  probability,
  category: z.enum(STAGE_CATEGORIES),
  slaDays,
});

export const stageUpdateSchema = z.object({
  id: uuid,
  name: z.string().trim().min(1, "Name is required").max(60),
  probability,
  category: z.enum(STAGE_CATEGORIES),
  slaDays,
  requiredFields: stringList(40, 60),
  requiresApproval: z.boolean(),
  importAliases: z
    .array(z.string().trim().toLowerCase().max(80))
    .max(60)
    .transform((a) => Array.from(new Set(a.filter(Boolean)))),
});

export const stageMoveSchema = z.object({ id: uuid, direction: z.enum(["up", "down"]) });
export const idSchema = z.object({ id: uuid });

export const PROBABILITY_PRESETS = ["tiered", "granular"] as const;
export const presetApplySchema = z.object({ pipelineId: uuid, preset: z.enum(PROBABILITY_PRESETS) });

/* ───────────────────────────── Custom fields & picklists ───────────────────────────── */

export const fieldDefSchema = z
  .object({
    id: uuid.optional(),
    entity: z.enum(FIELD_ENTITIES),
    pipelineKey: z
      .string()
      .trim()
      .max(40)
      .nullish()
      .transform((v) => (v ? v : null)),
    key: slugKey,
    label: z.string().trim().min(1, "Label is required").max(80),
    fieldType: z.enum(FIELD_TYPES),
    options: stringList(200, 120),
    requiredAtStages: stringList(60, 60),
    helpText: optText(300),
    sortOrder: z.number({ error: "Enter a number" }).int().min(0).max(10000),
  })
  .superRefine((v, ctx) => {
    if ((v.fieldType === "select" || v.fieldType === "multiselect") && v.options.length === 0)
      ctx.addIssue({ code: "custom", path: ["options"], message: "Add at least one option for a picklist field" });
    if (v.entity !== "deal" && v.pipelineKey) ctx.addIssue({ code: "custom", path: ["pipelineKey"], message: "Only deal fields can be limited to a pipeline" });
    if (v.entity !== "deal" && v.requiredAtStages.length)
      ctx.addIssue({ code: "custom", path: ["requiredAtStages"], message: "Only deal fields can be required at stages" });
    if (v.requiredAtStages.length && !v.pipelineKey)
      ctx.addIssue({ code: "custom", path: ["requiredAtStages"], message: "Choose a pipeline to require this field at its stages" });
    if (v.entity === "deal" && DEAL_FIELD_KEYS.includes(v.key)) ctx.addIssue({ code: "custom", path: ["key"], message: "That key is a built-in deal field" });
  })
  .transform((v) => ({
    ...v,
    options: v.fieldType === "select" || v.fieldType === "multiselect" ? Array.from(new Set(v.options)) : [],
  }));

export const picklistAddSchema = z.object({
  list: slugKey,
  value: z.string().trim().min(1, "Value is required").max(80),
  label: z.string().trim().max(80).optional(),
});
export const picklistLabelSchema = z.object({ id: uuid, label: z.string().trim().min(1, "Label is required").max(80) });
export const picklistActiveSchema = z.object({ id: uuid, active: z.boolean() });

/* ───────────────────────────── Alerts ───────────────────────────── */

export const alertRuleUpdateSchema = z.object({
  code: z.string().trim().min(1).max(20),
  severity: z.enum(ALERT_SEVERITIES),
  escalateAfterHours: z
    .number({ error: "Enter whole hours" })
    .int("Whole hours only")
    .min(1, "At least 1 hour")
    .max(24 * 30, "At most 720 hours")
    .nullable(),
  paramsText: z
    .string()
    .max(4000)
    .refine((t) => parseJsonObject(t).ok, "Must be a valid JSON object"),
});
export const alertEnabledSchema = z.object({ code: z.string().trim().min(1).max(20), enabled: z.boolean() });

/* ───────────────────────────── Settings: domains & AI test ───────────────────────────── */

export const DOMAIN_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const domainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .transform((d) => d.replace(/^@/, ""))
    .refine((d) => DOMAIN_RE.test(d), "Enter a domain like example.com"),
});

export const MODEL_ID_RE = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const modelTestSchema = z.object({
  tier: z.enum(["fast", "strong"]),
  model: z.string().trim().regex(MODEL_ID_RE, "Use the format provider/model, e.g. google/gemini-2.5-flash"),
});

/* ───────────────────────────── Claims ───────────────────────────── */

export const claimSchema = z.object({
  id: uuid.optional(),
  text: z.string().trim().min(3, "Claim text is required").max(300),
  pattern: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((v) => (v ? v : null))
    .superRefine((p, ctx) => {
      if (!p) return;
      const err = regexError(p);
      if (err) ctx.addIssue({ code: "custom", message: `Invalid regex: ${err}` });
    }),
  status: z.enum(CLAIM_STATUSES),
  approvedAlternative: optText(600),
  evidence: optText(1000),
  productId: uuid.nullish().transform((v) => v ?? null),
  expiresAt: z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), "Use a valid date"),
});

/* ───────────────────────────── Products ───────────────────────────── */

export const productSchema = z.object({
  id: uuid.optional(),
  family: z.string().trim().min(1, "Family is required").max(60),
  name: z.string().trim().min(2, "Name is required").max(120),
  sku: optText(60),
  description: optText(1000),
  pipelineKeys: stringList(20, 40),
  pricingModel: z.enum(PRICING_MODELS).nullable(),
  status: z.enum(PRODUCT_STATUSES),
  active: z.boolean(),
  defaultTermsText: z
    .string()
    .max(4000)
    .refine((t) => parseJsonObject(t).ok, "Must be a valid JSON object, e.g. {\"termYears\": 3}"),
});

/* ───────────────────────────── Teams ───────────────────────────── */

export const teamSchema = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(2, "Name is required").max(80),
  leadId: z
    .string()
    .trim()
    .max(100)
    .nullish()
    .transform((v) => (v ? v : null)),
  pipelineTypes: stringList(20, 40),
  regions: stringList(50),
  verticals: stringList(50),
  leagues: stringList(50),
});

/** Postgres unique-violation detection (drizzle wraps the driver error in `cause`). */
export function isUniqueViolation(e: unknown): boolean {
  const code = (x: unknown) => (typeof x === "object" && x !== null && "code" in x ? (x as { code?: unknown }).code : undefined);
  return code(e) === "23505" || code((e as { cause?: unknown } | null)?.cause) === "23505";
}
