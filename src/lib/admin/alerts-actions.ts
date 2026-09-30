"use server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { auditConfig, requireAdmin } from "@/lib/admin/guard";
import { alertEnabledSchema, alertRuleUpdateSchema, validateAlertParams } from "./config-schemas";

const PATH = "/admin/alerts";

async function loadRule(code: string) {
  const [row] = await db.select().from(s.alertRules).where(eq(s.alertRules.code, code));
  if (!row) throw new UserError("Alert rule not found.");
  return row;
}

export const updateAlertRule = action(alertRuleUpdateSchema, async (input, user) => {
  await requireAdmin(user);
  const before = await loadRule(input.code);
  const params = validateAlertParams(input.paramsText, before.params ?? {});
  if (!params.ok) throw new UserError(`Parameters: ${params.error}`);
  const patch = { severity: input.severity, escalateAfterHours: input.escalateAfterHours, params: params.value };
  await db.update(s.alertRules).set(patch).where(eq(s.alertRules.code, input.code));
  await auditConfig(
    user,
    "admin.alert_rule.update",
    "alert_rule",
    before.code,
    { severity: before.severity, escalateAfterHours: before.escalateAfterHours, params: before.params },
    patch,
    PATH,
  );
  return { code: before.code };
});

export const setAlertRuleEnabled = action(alertEnabledSchema, async (input, user) => {
  await requireAdmin(user);
  const before = await loadRule(input.code);
  await db.update(s.alertRules).set({ enabled: input.enabled }).where(eq(s.alertRules.code, input.code));
  await auditConfig(user, input.enabled ? "admin.alert_rule.enable" : "admin.alert_rule.disable", "alert_rule", before.code, { enabled: before.enabled }, { enabled: input.enabled }, PATH);
  return { code: before.code, enabled: input.enabled };
});
