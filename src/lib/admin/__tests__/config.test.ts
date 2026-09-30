import { describe, expect, it } from "vitest";
import {
  claimSchema,
  domainSchema,
  fieldDefSchema,
  isUniqueViolation,
  modelTestSchema,
  moveItem,
  parseJsonObject,
  parseList,
  pipelineUpdateSchema,
  productSchema,
  slugify,
  stageUpdateSchema,
  validateAlertParams,
} from "../config-schemas";
import { GRANULAR, presetProbability, presetSettingKey, previewPreset, TIERED } from "../presets";
import { isWritableSetting, readSetting, settingUpdateSchema, SETTING_KEYS, validateSetting } from "../settings-registry";

const MUU_KEYS = ["target", "outreach", "in_comms", "warming", "hot", "demo", "contract", "migrating", "live", "on_hold", "cold", "lost"];
const ENT_KEYS = ["target", "outreach", "in_comms", "nda", "proposal", "negotiation", "contract", "won", "on_hold", "cold", "lost"];

describe("probability presets", () => {
  it("covers every seeded MUU and ENT stage key in both presets", () => {
    for (const k of [...MUU_KEYS, ...ENT_KEYS]) {
      expect(TIERED[k], `tiered ${k}`).toBeTypeOf("number");
      expect(GRANULAR[k], `granular ${k}`).toBeTypeOf("number");
    }
  });

  it("tiered reproduces the seed values", () => {
    expect(presetProbability("tiered", { key: "target", category: "open", probability: 0.3 })).toBe(0.1);
    expect(presetProbability("tiered", { key: "in_comms", category: "open", probability: 0 })).toBe(0.5);
    expect(presetProbability("tiered", { key: "hot", category: "open", probability: 0 })).toBe(0.9);
    expect(presetProbability("tiered", { key: "contract", category: "open", probability: 0 })).toBe(1);
    expect(presetProbability("tiered", { key: "on_hold", category: "hold", probability: 0 })).toBe(0.5);
    expect(presetProbability("tiered", { key: "negotiation", category: "open", probability: 0 })).toBe(0.9);
  });

  it("granular follows PRD Appendix A", () => {
    const p = (key: string, category = "open") => presetProbability("granular", { key, category, probability: 0.5 });
    expect(p("contract")).toBe(0.95);
    expect(p("hot")).toBe(0.9);
    expect(p("demo")).toBe(0.75);
    expect(p("warming")).toBe(0.6);
    expect(p("in_comms")).toBe(0.4);
    expect(p("on_hold", "hold")).toBe(0.15);
    expect(p("cold")).toBe(0.1);
    expect(p("outreach")).toBe(0.08);
    expect(p("target")).toBe(0.06);
  });

  it("won stays 100%, lost is 0% (tiered) / 1% (granular)", () => {
    expect(presetProbability("granular", { key: "migrating", category: "won", probability: 0.2 })).toBe(1);
    expect(presetProbability("tiered", { key: "custom_won", category: "won", probability: 0.2 })).toBe(1);
    expect(presetProbability("tiered", { key: "lost", category: "lost", probability: 0.2 })).toBe(0);
    expect(presetProbability("granular", { key: "lost", category: "lost", probability: 0.2 })).toBe(0.01);
  });

  it("keeps unknown open stages unchanged and flags changes in the preview", () => {
    const preview = previewPreset("granular", [
      { id: "1", key: "custom_stage", name: "Custom", category: "open", probability: 0.33 },
      { id: "2", key: "hot", name: "Hot", category: "open", probability: 0.9 },
      { id: "3", key: "demo", name: "Demo", category: "open", probability: 0.9 },
    ]);
    expect(preview[0]).toMatchObject({ before: 0.33, after: 0.33, changed: false });
    expect(preview[1]!.changed).toBe(false);
    expect(preview[2]).toMatchObject({ before: 0.9, after: 0.75, changed: true });
  });

  it("builds the preset setting key", () => {
    expect(presetSettingKey("NET")).toBe("pipeline.probability_preset.NET");
  });
});

describe("settings registry", () => {
  it("only whitelisted keys are writable", () => {
    expect(isWritableSetting("email.backfill_days")).toBe(true);
    expect(isWritableSetting("scout.budget")).toBe(false);
    expect(isWritableSetting("__proto__")).toBe(false);
    expect(validateSetting("scout.budget", 5)).toMatchObject({ ok: false });
  });

  it("validates ranges per key", () => {
    expect(validateSetting("email.backfill_days", 90)).toMatchObject({ ok: true, value: 90 });
    expect(validateSetting("email.backfill_days", 0).ok).toBe(false);
    expect(validateSetting("email.backfill_days", 366).ok).toBe(false);
    expect(validateSetting("email.backfill_days", 1.5).ok).toBe(false);
    expect(validateSetting("email.retention_unlinked_days", 0).ok).toBe(true);
    expect(validateSetting("email.unanswered_hours", 721).ok).toBe(false);
    expect(validateSetting("r100.goal_live", 0).ok).toBe(false);
    expect(validateSetting("pipeline.usd_per_muu", 0).ok).toBe(false);
    expect(validateSetting("pipeline.usd_per_muu", 1.25).ok).toBe(true);
    expect(validateSetting("pipeline.engaged_threshold", 1.2).ok).toBe(false);
    expect(validateSetting("pipeline.override_approval_threshold_pts", 101).ok).toBe(false);
    expect(validateSetting("agent.claims_mode", "block").ok).toBe(true);
    expect(validateSetting("agent.claims_mode", "off").ok).toBe(false);
    expect(validateSetting("ai.model_fast", "google/gemini-2.5-flash").ok).toBe(true);
    expect(validateSetting("ai.model_fast", "gemini").ok).toBe(false);
    expect(validateSetting("email.backfill_days", "90").ok).toBe(false);
  });

  it("autonomy needs every action with a 0..3 level and nothing else", () => {
    const full = readSetting("agent.autonomy", null);
    expect(validateSetting("agent.autonomy", full).ok).toBe(true);
    expect(validateSetting("agent.autonomy", { ...full, send_email: 4 }).ok).toBe(false);
    expect(validateSetting("agent.autonomy", { ...full, send_email: 2 }).ok).toBe(false);
    expect(validateSetting("agent.autonomy", { ...full, stage_change: 3 }).ok).toBe(true);
    expect(validateSetting("agent.autonomy", { ...full, delete_data: 3 }).ok).toBe(false);
    const { send_email: _omit, ...partial } = full;
    void _omit;
    expect(validateSetting("agent.autonomy", partial).ok).toBe(false);
  });

  it("readSetting falls back on malformed stored values and merges partial autonomy", () => {
    expect(readSetting("email.backfill_days", "abc")).toBe(90);
    expect(readSetting("email.backfill_days", 30)).toBe(30);
    expect(readSetting("agent.autonomy", { send_email: 1, bogus: 3 })).toMatchObject({ send_email: 1, stage_change: 1 });
  });

  it("the action schema discriminates on key", () => {
    expect(SETTING_KEYS.length).toBeGreaterThan(10);
    expect(settingUpdateSchema.safeParse({ key: "email.backfill_days", value: 30 }).success).toBe(true);
    expect(settingUpdateSchema.safeParse({ key: "email.backfill_days", value: 0 }).success).toBe(false);
    expect(settingUpdateSchema.safeParse({ key: "scout.budget", value: {} }).success).toBe(false);
  });
});

describe("alert params validation", () => {
  const current = { hours: 24, days: [60, 30], label: "x", on: true };
  it("accepts same keys + types", () => {
    expect(validateAlertParams('{"hours": 12, "days": [30], "label": "y", "on": false}', current)).toMatchObject({ ok: true });
  });
  it("rejects non-objects and bad JSON", () => {
    expect(validateAlertParams("[1,2]", current).ok).toBe(false);
    expect(validateAlertParams("null", current).ok).toBe(false);
    expect(validateAlertParams("{hours: 1}", current).ok).toBe(false);
  });
  it("rejects type changes, nested objects, unknown and missing keys", () => {
    expect(validateAlertParams('{"hours": "12", "days": [30], "label": "y", "on": false}', current).ok).toBe(false);
    expect(validateAlertParams('{"hours": 12, "days": ["30"], "label": "y", "on": false}', current).ok).toBe(false);
    expect(validateAlertParams('{"hours": 12, "days": [30], "label": {"a": 1}, "on": false}', current).ok).toBe(false);
    expect(validateAlertParams('{"hours": 12, "days": [30], "label": "y", "on": false, "extra": 1}', current).ok).toBe(false);
    expect(validateAlertParams('{"hours": 12}', current).ok).toBe(false);
  });
  it("empty params stay empty", () => {
    expect(validateAlertParams("{}", {})).toMatchObject({ ok: true, value: {} });
    expect(validateAlertParams("", {})).toMatchObject({ ok: true, value: {} });
  });
});

describe("helpers", () => {
  it("slugify", () => {
    expect(slugify("Demo / Beta Review")).toBe("demo_beta_review");
    expect(slugify("  Café Olé!! ")).toBe("cafe_ole");
    expect(slugify("///")).toBe("");
  });
  it("parseList", () => {
    expect(parseList("NFL, nba,, NFL\nMLB")).toEqual(["NFL", "nba", "MLB"]);
    expect(parseList("Hot, VERBAL", { lowercase: true })).toEqual(["hot", "verbal"]);
  });
  it("moveItem", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(moveItem(items, "b", "up").map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(moveItem(items, "c", "down")).toBe(items);
  });
  it("parseJsonObject", () => {
    expect(parseJsonObject('{"termYears": 3}')).toMatchObject({ ok: true });
    expect(parseJsonObject("3").ok).toBe(false);
  });
  it("isUniqueViolation", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
  });
});

describe("schemas", () => {
  const uuid = "3f1c1a52-8a0e-4b7e-9d8a-1c2b3d4e5f60";
  it("pipeline color must be a palette swatch", () => {
    const base = { id: uuid, name: "Network", description: null, usdPerMuu: 1, defaultRevSharePct: 0.5, active: true };
    expect(pipelineUpdateSchema.safeParse({ ...base, color: "#5c98d5" }).success).toBe(true);
    expect(pipelineUpdateSchema.safeParse({ ...base, color: "#ff0000" }).success).toBe(false);
    expect(pipelineUpdateSchema.safeParse({ ...base, color: "#5C98D5", usdPerMuu: 0 }).success).toBe(false);
    expect(pipelineUpdateSchema.safeParse({ ...base, color: "#5C98D5", defaultRevSharePct: 1.5 }).success).toBe(false);
  });
  it("stage aliases are lowercased and deduped", () => {
    const r = stageUpdateSchema.parse({
      id: uuid,
      name: "Hot",
      probability: 0.9,
      category: "open",
      slaDays: 5,
      requiredFields: [],
      requiresApproval: false,
      importAliases: ["Hot", "hot", "Verbal"],
    });
    expect(r.importAliases).toEqual(["hot", "verbal"]);
  });
  it("custom field rules", () => {
    const base = { entity: "deal", pipelineKey: null, key: "tier", label: "Tier", fieldType: "select", options: [], requiredAtStages: [], helpText: null, sortOrder: 0 };
    expect(fieldDefSchema.safeParse(base).success).toBe(false);
    expect(fieldDefSchema.safeParse({ ...base, options: ["A"] }).success).toBe(true);
    expect(fieldDefSchema.safeParse({ ...base, fieldType: "text", key: "muu" }).success).toBe(false);
    expect(fieldDefSchema.safeParse({ ...base, fieldType: "text", key: "Bad Key" }).success).toBe(false);
    expect(fieldDefSchema.safeParse({ ...base, fieldType: "text", requiredAtStages: ["hot"] }).success).toBe(false);
    expect(fieldDefSchema.safeParse({ ...base, fieldType: "text", entity: "account", pipelineKey: "NET" }).success).toBe(false);
    expect(fieldDefSchema.parse({ ...base, fieldType: "text", options: ["x"] }).options).toEqual([]);
  });
  it("claims reject invalid regex", () => {
    const base = { text: "Paid in 8 seconds", status: "banned", pattern: "(paid in \\d+ seconds" };
    const r = claimSchema.safeParse(base);
    expect(r.success).toBe(false);
    expect(claimSchema.safeParse({ ...base, pattern: "paid in \\d+ seconds", expiresAt: "2026-12-31" }).success).toBe(true);
    expect(claimSchema.safeParse({ ...base, pattern: null, expiresAt: "31/12/2026" }).success).toBe(false);
  });
  it("product default terms must be a JSON object", () => {
    const base = { family: "Platform", name: "CMS", sku: null, description: null, pipelineKeys: ["NET"], pricingModel: "rev_share", status: "live", active: true };
    expect(productSchema.safeParse({ ...base, defaultTermsText: '{"termYears": 3}' }).success).toBe(true);
    expect(productSchema.safeParse({ ...base, defaultTermsText: "[1]" }).success).toBe(false);
  });
  it("domains and model ids", () => {
    expect(domainSchema.parse({ domain: " @RoundTable.io " }).domain).toBe("roundtable.io");
    expect(domainSchema.safeParse({ domain: "not a domain" }).success).toBe(false);
    expect(domainSchema.safeParse({ domain: "https://x.com" }).success).toBe(false);
    expect(modelTestSchema.safeParse({ tier: "fast", model: "openai/gpt-5-mini" }).success).toBe(true);
    expect(modelTestSchema.safeParse({ tier: "fast", model: "gpt-5-mini" }).success).toBe(false);
  });
});
