import "server-only";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { can, dealAccessWhere, getHiddenFields, type AppUser } from "@/lib/rbac/server";
import { proFormaPrefill, type PrefillItem } from "./prefill";
import { approvalRules, proposalWhere } from "./access";
import { approvalTriggers, canExport, computeProForma, normalizeInputs, type ProFormaInputs, type ProFormaOutputs } from "./calc";

export type ProposalListRow = {
  id: string;
  kind: string;
  dealId: string;
  dealName: string;
  pipelineKey: string;
  accountName: string | null;
  version: number;
  versions: number;
  status: string;
  createdAt: string;
  createdByName: string | null;
  uplift: number;
  rtbShare: number;
  clientNetAfterShare: number;
  /** Coalition term sheets: the applicable tier label and partner share (0..100). */
  tierLabel: string | null;
  partnerPct: number | null;
};

export async function listProposals(user: AppUser) {
  const where = await proposalWhere(user, "view");
  const rows = await db
    .select({ p: s.proposals, dealName: s.deals.name, pipelineKey: s.pipelines.key, accountName: s.accounts.name, createdByName: s.user.name })
    .from(s.proposals)
    .innerJoin(s.deals, eq(s.deals.id, s.proposals.dealId))
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .leftJoin(s.user, eq(s.user.id, s.proposals.createdBy))
    .where(where)
    .orderBy(desc(s.proposals.createdAt))
    .limit(1000);
  // Latest version per deal and proposal kind.
  const byDeal = new Map<string, ProposalListRow>();
  const counts = new Map<string, number>();
  const keyOf = (p: { dealId: string; kind: string }) => `${p.dealId}:${p.kind}`;
  for (const r of rows) counts.set(keyOf(r.p), (counts.get(keyOf(r.p)) ?? 0) + 1);
  for (const r of rows) {
    const cur = byDeal.get(keyOf(r.p));
    if (cur && cur.version >= r.p.version) continue;
    const o = r.p.outputs as Partial<ProFormaOutputs>;
    const ts = r.p.outputs as { tier?: { label?: string; partnerPct?: number } | null };
    byDeal.set(keyOf(r.p), {
      id: r.p.id,
      kind: r.p.kind,
      dealId: r.p.dealId,
      dealName: r.dealName,
      pipelineKey: r.pipelineKey,
      accountName: r.accountName,
      version: r.p.version,
      versions: counts.get(keyOf(r.p)) ?? 1,
      status: r.p.status,
      createdAt: r.p.createdAt.toISOString(),
      createdByName: r.createdByName,
      uplift: Number(o.uplift ?? 0),
      rtbShare: Number(o.rtbShare ?? 0),
      clientNetAfterShare: Number(o.clientNetAfterShare ?? 0),
      tierLabel: r.p.kind === "pro_forma" ? null : (ts.tier?.label ?? null),
      partnerPct: r.p.kind === "pro_forma" ? null : typeof ts.tier?.partnerPct === "number" ? ts.tier.partnerPct : null,
    });
  }
  return [...byDeal.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getProposal(user: AppUser, id: string) {
  const where = await proposalWhere(user, "view");
  const [row] = await db
    .select({ p: s.proposals, deal: s.deals, pipelineKey: s.pipelines.key, accountName: s.accounts.name })
    .from(s.proposals)
    .innerJoin(s.deals, eq(s.deals.id, s.proposals.dealId))
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .where(and(eq(s.proposals.id, id), eq(s.proposals.kind, "pro_forma"), where));
  if (!row) return null;
  const versions = await db
    .select({ id: s.proposals.id, version: s.proposals.version, status: s.proposals.status, createdAt: s.proposals.createdAt, inputs: s.proposals.inputs, createdByName: s.user.name })
    .from(s.proposals)
    .leftJoin(s.user, eq(s.user.id, s.proposals.createdBy))
    .where(and(eq(s.proposals.dealId, row.p.dealId), eq(s.proposals.kind, "pro_forma")))
    .orderBy(asc(s.proposals.version));
  const approvals = await db
    .select({ a: s.approvals, requestedByName: s.user.name })
    .from(s.approvals)
    .leftJoin(s.user, eq(s.user.id, s.approvals.requestedBy))
    .where(and(eq(s.approvals.kind, "proposal"), inArray(s.approvals.entityId, versions.map((v) => v.id))))
    .orderBy(desc(s.approvals.createdAt));
  const rules = await approvalRules();
  const inputs = normalizeInputs(row.p.inputs);
  const outputs = computeProForma(inputs);
  const triggers = approvalTriggers(inputs, rules);
  const [canEdit, canApprove, canCreate] = await Promise.all([can(user, "proposals", "edit"), can(user, "proposals", "approve", "all"), can(user, "proposals", "create")]);
  return {
    proposal: {
      id: row.p.id,
      dealId: row.p.dealId,
      version: row.p.version,
      status: row.p.status,
      approvalReason: row.p.approvalReason,
      approvedBy: row.p.approvedBy,
      createdAt: row.p.createdAt.toISOString(),
    },
    deal: { id: row.deal.id, name: row.deal.name, pipelineKey: row.pipelineKey, accountName: row.accountName },
    inputs,
    outputs,
    triggers,
    exportable: canExport(row.p.status, triggers),
    versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, createdAt: v.createdAt.toISOString(), createdByName: v.createdByName, inputs: normalizeInputs(v.inputs) })),
    approvals: approvals.map((a) => ({
      id: a.a.id,
      entityId: a.a.entityId,
      status: a.a.status,
      requestedByName: a.requestedByName,
      createdAt: a.a.createdAt.toISOString(),
      decidedAt: a.a.decidedAt?.toISOString() ?? null,
      note: a.a.note,
      reasons: (a.a.payload as { reasons?: string[] }).reasons ?? [],
    })),
    perms: { canEdit, canApprove, canCreate },
    rules,
  };
}

/** Deals a user can start a proposal on: Enterprise by default; NetDev/Sports when `includeAll`. */
export async function proposalDealOptions(user: AppUser, includeAll = false) {
  const visible = await dealAccessWhere(user, "view");
  return db
    .select({ id: s.deals.id, name: s.deals.name, pipelineKey: s.pipelines.key })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .where(and(visible, isNull(s.deals.deletedAt), inArray(s.pipelines.key, includeAll ? ["ENT", "NET", "SPT"] : ["ENT"])))
    .orderBy(asc(s.pipelines.sortOrder), asc(s.deals.name))
    .limit(3000);
}

/** A single deal the user can see and build a pro forma on (ENT/NET/SPT). */
export async function proposalDeal(user: AppUser, dealId: string) {
  const visible = await dealAccessWhere(user, "view");
  const [row] = await db
    .select({ id: s.deals.id, name: s.deals.name, pipelineKey: s.pipelines.key })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .where(and(visible, eq(s.deals.id, dealId), inArray(s.pipelines.key, ["ENT", "NET", "SPT"])));
  return row ?? null;
}

/** A6: prefill a new pro forma from the deal's commercial terms (hidden deal fields are never used). */
export async function prefillFromDeal(user: AppUser, dealId: string): Promise<{ inputs: Partial<ProFormaInputs>; filled: PrefillItem[] }> {
  const [row] = await db
    .select({ d: s.deals, unit: s.pipelines.unit, pipelineUsdPerMuu: s.pipelines.usdPerMuu, pipelineRevSharePct: s.pipelines.defaultRevSharePct })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .where(and(eq(s.deals.id, dealId), await dealAccessWhere(user, "view")));
  if (!row) return { inputs: {}, filled: [] };
  const hidden = await getHiddenFields(user.role, "deal");
  const d = row.d;
  return proFormaPrefill(
    {
      unit: row.unit,
      muu: d.muu,
      usdPerMuu: d.usdPerMuu,
      pipelineUsdPerMuu: row.pipelineUsdPerMuu,
      revSharePct: d.revSharePct,
      pipelineRevSharePct: row.pipelineRevSharePct,
      guaranteeType: d.guaranteeType,
      guaranteeMonthlyCents: d.guaranteeMonthlyCents,
      rampMonths: d.rampMonths,
      termYears: d.termYears,
      contractValueCents: d.contractValueCents,
      annualizedValueCents: d.annualizedValueCents,
    },
    hidden,
  );
}

/** Kind of a proposal the user can see (null = not found / not visible). Used to route /proposals/[id]. */
export async function proposalKindOf(user: AppUser, id: string): Promise<string | null> {
  const where = await proposalWhere(user, "view");
  const [row] = await db
    .select({ kind: s.proposals.kind })
    .from(s.proposals)
    .innerJoin(s.deals, eq(s.deals.id, s.proposals.dealId))
    .where(and(eq(s.proposals.id, id), where));
  return row?.kind ?? null;
}
