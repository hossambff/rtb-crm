import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import { dealValue } from "@/lib/pipeline-math";
import { dealAccessWhere, dealModule, ForbiddenError, inScope, scopeFor, type AppUser } from "@/lib/rbac/server";
import { SCOPE_RANK, type Scope } from "@/lib/rbac/model";
import { hiddenDealFields } from "@/lib/deals/service";
import { toCsv } from "@/lib/deals/csv";
import { dealFilterConds } from "./filter";
import type { DealFilter } from "./types";

const MAX_EXPORT = 5000;

/**
 * Cross-motion CSV export (KAN-5 "export (permissioned)"), same rules as the pipeline export (QA-19): per-motion
 * export scope or the org-wide Export grant; rows limited to what the user can view and to the export scope;
 * restricted (MNPI) deals never leave; hidden fields (rev share → net) are omitted. Audited.
 */
export async function exportDeals(user: AppUser, f: DealFilter) {
  const globalExport = await scopeFor(user, "export", "export");
  const view = await dealAccessWhere(user, "view");
  const owner = alias(s.user, "ex_owner");
  const rows = await db
    .select({ deal: s.deals, pipeline: s.pipelines, stage: s.stages, accountName: s.accounts.name, accountDomain: s.accounts.domain, accountRestricted: s.accounts.restricted, ownerName: owner.name })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .innerJoin(s.stages, eq(s.stages.id, s.deals.stageId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .leftJoin(owner, eq(owner.id, s.deals.ownerId))
    // SEC M-7: restricted deals AND deals on restricted accounts never leave (the latter are dropped below and counted).
    .where(and(view, eq(s.deals.restricted, false), ...dealFilterConds(user, f)))
    .orderBy(asc(s.pipelines.sortOrder), asc(s.deals.name))
    .limit(MAX_EXPORT);
  const scopeBy = new Map<string, Scope>();
  for (const key of new Set(rows.map((r) => r.pipeline.key))) {
    const pipe = await scopeFor(user, dealModule(key), "export");
    scopeBy.set(key, SCOPE_RANK[pipe] >= SCOPE_RANK[globalExport] ? pipe : globalExport);
  }
  if (rows.length && [...scopeBy.values()].every((sc) => sc === "none")) throw new ForbiddenError("Your role can't export deals.");
  const excludedRestricted = rows.filter((r) => r.accountRestricted).length;
  const allowed = rows.filter((r) => {
    if (r.accountRestricted) return false;
    const sc = scopeBy.get(r.pipeline.key) ?? "none";
    return sc !== "none" && inScope(user, sc, { ownerId: r.deal.ownerId, teamId: r.deal.teamId, pipelineKey: r.pipeline.key });
  });
  const hidden = await hiddenDealFields(user.role);
  const showNet = !hidden.has("revSharePct");
  // Field-level security: a column the role can't see is not exported (header and values).
  const vis = (field: string) => !hidden.has(field) && !hidden.has("*");
  const headers = ["Deal", "Account", "Domain", "Motion", "Stage", "Status", "Owner", "Priority", "MUU", "Gross USD", ...(showNet ? ["Net USD"] : []), "Probability", "Weighted USD", ...(vis("expectedCloseDate") ? ["Expected close"] : []), ...(vis("nextStep") ? ["Next step", "Next step due"] : []), ...(vis("healthScore") ? ["Health"] : []), ...(vis("tags") ? ["Tags"] : []), "Deal ID"];
  const out = allowed.map((r) => {
    const v = dealValue({
      unit: r.pipeline.unit,
      muu: r.deal.muu,
      usdPerMuu: r.deal.usdPerMuu,
      pipelineUsdPerMuu: r.pipeline.usdPerMuu,
      revSharePct: r.deal.revSharePct,
      pipelineRevSharePct: r.pipeline.defaultRevSharePct,
      contractValueCents: r.deal.contractValueCents,
      annualizedValueCents: r.deal.annualizedValueCents,
      stageProbability: r.stage.probability,
      probabilityOverride: r.deal.probabilityOverride,
      overrideStatus: r.deal.overrideStatus,
    });
    return [
      r.deal.name,
      r.accountName,
      r.accountDomain,
      r.pipeline.key,
      r.stage.name,
      r.deal.status,
      r.ownerName ?? "",
      r.deal.priority ?? "",
      r.pipeline.unit === "muu" ? v.muu : "",
      Math.round(v.grossUsd),
      ...(showNet ? [Math.round(v.netUsd)] : []),
      `${Math.round(v.probability * 100)}%`,
      Math.round(v.weightedGrossUsd),
      ...(vis("expectedCloseDate") ? [r.deal.expectedCloseDate?.toISOString().slice(0, 10) ?? ""] : []),
      ...(vis("nextStep") ? [r.deal.nextStep, r.deal.nextStepDueAt?.toISOString().slice(0, 10) ?? ""] : []),
      ...(vis("healthScore") ? [r.deal.healthScore ?? ""] : []),
      ...(vis("tags") ? [r.deal.tags.join(" ")] : []),
      r.deal.id,
    ];
  });
  await audit({ actorId: user.id, action: "deal.export", entity: "deals", after: { count: out.length, excludedRestrictedAccounts: excludedRestricted, filter: { ...f, ids: f.ids ? `${f.ids.length} ids` : undefined }, via: "deals_list" } });
  return { filename: `deals-${new Date().toISOString().slice(0, 10)}.csv`, csv: toCsv(headers, out), count: out.length, excludedRestricted: true, excludedRestrictedAccounts: excludedRestricted };
}
