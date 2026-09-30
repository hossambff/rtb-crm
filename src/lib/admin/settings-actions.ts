"use server";
import { generateText, type LanguageModel } from "ai";
import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { aiAvailable } from "@/lib/ai";
import { auditConfig, requireAdmin, requireSuperAdmin } from "@/lib/admin/guard";
import { setSetting } from "@/lib/settings";
import { domainSchema, modelTestSchema } from "./config-schemas";
import { settingUpdateSchema, validateSetting } from "./settings-registry";

const PATH = "/admin/settings";

/** Update one whitelisted org setting (strict per-key schema; see settings-registry.ts). */
export const updateSetting = action(settingUpdateSchema, async (input, user) => {
  await requireAdmin(user);
  const checked = validateSetting(input.key, input.value); // defence in depth: whitelist + schema
  if (!checked.ok) throw new UserError(checked.error);
  const [before] = await db.select().from(s.appSettings).where(eq(s.appSettings.key, checked.key));
  await setSetting(checked.key, checked.value, user.id);
  await auditConfig(user, "admin.setting.update", "app_setting", checked.key, before?.value ?? null, checked.value, PATH);
  return { key: checked.key };
});

/* ───────────────────────────── Allowed sign-in domains (super admin) ───────────────────────────── */

export const addAllowedDomain = action(domainSchema, async (input, user) => {
  await requireSuperAdmin(user);
  const inserted = await db.insert(s.allowedDomains).values({ domain: input.domain }).onConflictDoNothing().returning();
  if (!inserted.length) throw new UserError(`${input.domain} is already allowed.`);
  await auditConfig(user, "admin.allowed_domain.add", "allowed_domain", input.domain, null, { domain: input.domain }, PATH);
  return { domain: input.domain };
});

export const removeAllowedDomain = action(domainSchema, async (input, user) => {
  await requireSuperAdmin(user);
  const [row] = await db.select().from(s.allowedDomains).where(eq(s.allowedDomains.domain, input.domain));
  if (!row) throw new UserError("Domain not found.");
  const [{ n }] = await db.select({ n: count() }).from(s.allowedDomains);
  if (Number(n) <= 1) throw new UserError("You can't remove the last allowed domain — nobody could sign in.");
  await db.delete(s.allowedDomains).where(eq(s.allowedDomains.domain, input.domain));
  await auditConfig(user, "admin.allowed_domain.remove", "allowed_domain", input.domain, { domain: row.domain }, null, PATH);
  return { domain: input.domain };
});

/* ───────────────────────────── AI model test ───────────────────────────── */

export type ModelTestResult = { success: boolean; model: string; latencyMs: number; reply?: string; error?: string };

function safeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/\b(sk|vck|key|token)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .slice(0, 200);
}

/** Try the model id currently typed in the input (not the saved one) with a tiny prompt; logged to agent_runs. */
export const testAiModel = action(modelTestSchema, async (input, user): Promise<ModelTestResult> => {
  await requireAdmin(user);
  if (!aiAvailable()) throw new UserError("AI gateway not configured");
  const prompt = "Reply with the single word OK.";
  const started = Date.now();
  let result: ModelTestResult;
  try {
    const res = await generateText({ model: input.model as LanguageModel, prompt, abortSignal: AbortSignal.timeout(20_000) });
    result = { success: true, model: input.model, latencyMs: Date.now() - started, reply: res.text.trim().slice(0, 120) };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    result = { success: false, model: input.model, latencyMs: Date.now() - started, error: timedOut ? "Timed out after 20s." : safeError(e) };
  }
  try {
    await db.insert(s.agentRuns).values({
      kind: "admin_model_test",
      userId: user.id,
      model: input.model,
      input: { tier: input.tier, promptChars: prompt.length } as never,
      output: (result.success ? { text: result.reply } : null) as never,
      latencyMs: result.latencyMs,
      error: result.error,
    });
  } catch {
    /* logging must never break the feature */
  }
  return result;
});
