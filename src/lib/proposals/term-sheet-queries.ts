import "server-only";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { can, dealAccessWhere, isFieldHiddenFor, type AppUser } from "@/lib/rbac/server";
import { logServerError } from "@/lib/errors";
import { proposalWhere } from "./access";
import { previewPart, blocksEmpty, type Block } from "./docx/preview";
import { getActiveTemplate, getTemplate, loadTemplateParts } from "./templates";
import {
  buildRules,
  normalizeTermSheetInputs,
  termSheetApprovalReasons,
  termSheetEconomics,
  termSheetExportable,
  TERM_SHEET_KIND,
  usedTargets,
  type TermSheetInputs,
} from "./termsheet";

export const TERM_SHEET_PIPELINES = ["NET"];

/** Today's date (yyyy-mm-dd) in the user's time zone. */
export function todayIso(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** NET deals the user can see (deal picker for a new term sheet). */
export async function termSheetDealOptions(user: AppUser) {
  return db
    .select({ id: s.deals.id, name: s.deals.name, accountName: s.accounts.name })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .where(and(await dealAccessWhere(user, "view"), isNull(s.deals.deletedAt), inArray(s.pipelines.key, TERM_SHEET_PIPELINES)))
    .orderBy(asc(s.deals.name))
    .limit(3000);
}

export type TermSheetDealContext = {
  deal: { id: string; name: string; pipelineKey: string; restricted: boolean; accountId: string | null; accountName: string | null };
  prefill: Record<string, string>;
  muu: number | null;
  usdPerMuu: number;
};

/** Deal + account + primary contact → prefilled values (server-side; the client never supplies the prefill). */
export async function termSheetDealContext(user: AppUser, dealId: string): Promise<TermSheetDealContext | null> {
  const [row] = await db
    .select({ d: s.deals, pipelineKey: s.pipelines.key, pipelineUsdPerMuu: s.pipelines.usdPerMuu, a: s.accounts })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .leftJoin(s.accounts, and(eq(s.accounts.id, s.deals.accountId), isNull(s.accounts.deletedAt)))
    .where(and(eq(s.deals.id, dealId), await dealAccessWhere(user, "view")));
  if (!row) return null;
  const d = row.d;
  let contact: { fullName: string; title: string | null } | null = null;
  if (d.primaryContactId) {
    [contact] = await db
      .select({ fullName: s.contacts.fullName, title: s.contacts.title })
      .from(s.contacts)
      .where(and(eq(s.contacts.id, d.primaryContactId), isNull(s.contacts.deletedAt)));
  }
  if (!contact) {
    const linked = await db
      .select({ fullName: s.contacts.fullName, title: s.contacts.title, role: s.dealContacts.role })
      .from(s.dealContacts)
      .innerJoin(s.contacts, eq(s.contacts.id, s.dealContacts.contactId))
      .where(and(eq(s.dealContacts.dealId, d.id), isNull(s.contacts.deletedAt)))
      .limit(20);
    contact = linked.find((c) => c.role === "decision_maker") ?? linked[0] ?? null;
  }
  const a = row.a;
  const custom = (a?.customFields ?? {}) as Record<string, unknown>;
  const legal = typeof custom.legalName === "string" && custom.legalName.trim() ? custom.legalName.trim() : (a?.name ?? "");
  const today = todayIso(user.timezone);
  const prefill: Record<string, string> = {
    recipientName: contact?.fullName ?? "",
    recipientTitle: contact?.title ?? "",
    companyLegalName: legal,
    brands: a?.name ?? d.name,
    region: a?.country ?? a?.region ?? "",
    letterDate: today,
    ndaEffectiveDate: today,
    ccLine: "",
    signatoryName: contact?.fullName ?? "",
    signatoryTitle: contact?.title ?? "",
  };
  return {
    deal: { id: d.id, name: d.name, pipelineKey: row.pipelineKey, restricted: d.restricted, accountId: d.accountId, accountName: a?.name ?? null },
    prefill,
    muu: d.muu ?? a?.muu ?? null,
    usdPerMuu: d.usdPerMuu ?? row.pipelineUsdPerMuu ?? 1,
  };
}

/** Everything derived from the inputs (stored as outputs; recomputed on view). */
export function termSheetOutputs(i: TermSheetInputs) {
  const e = termSheetEconomics(i, i.snapshot.tiers);
  const reasons = termSheetApprovalReasons(i, i.snapshot.approval, i.snapshot.tiers);
  const { unfilled } = buildRules(i.snapshot.candidates, i.snapshot.fieldMap, i.values);
  return {
    tier: e.tier ? { label: e.tier.label, band: e.tier.band, partnerPct: e.tier.partnerPct, rtbPct: e.tier.rtbPct } : null,
    tierIndex: e.tierIndex,
    impliedTierIndex: e.impliedTierIndex,
    tierOverridden: e.overridden,
    grossUsd: e.grossUsd,
    partnerUsd: e.partnerUsd,
    rtbUsd: e.rtbUsd,
    unfilled,
    reasons,
  };
}

export type DocPreview = { body: Block[]; headers: Block[][]; footers: Block[][]; error: string | null };

/** Preview blocks for a version: its template's parts with its own frozen mapping and values. */
export async function termSheetPreview(i: TermSheetInputs): Promise<DocPreview> {
  try {
    const parts = await loadTemplateParts(i.templateId);
    const { rules } = buildRules(i.snapshot.candidates, i.snapshot.fieldMap, i.values);
    const out: DocPreview = { body: [], headers: [], footers: [], error: null };
    for (const p of parts) {
      const blocks = previewPart(p.xml, p.name, rules);
      if (p.name === "word/document.xml") out.body = blocks;
      else if (blocksEmpty(blocks)) continue;
      else if (/header/.test(p.name)) out.headers.push(blocks);
      else if (/footer/.test(p.name)) out.footers.push(blocks);
      // footnotes / endnotes are filled in the .docx but not part of the on-screen preview
    }
    // identical headers/footers (first page / default) are shown once
    const dedupe = (list: Block[][]) => list.filter((b, idx) => list.findIndex((x) => JSON.stringify(x) === JSON.stringify(b)) === idx).slice(0, 2);
    out.headers = dedupe(out.headers);
    out.footers = dedupe(out.footers);
    return out;
  } catch (e) {
    logServerError("proposals.term_sheet_preview", e);
    return { body: [], headers: [], footers: [], error: "The template could not be read. Ask an admin to re-upload it." };
  }
}

export async function getTermSheet(user: AppUser, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const where = await proposalWhere(user, "view");
  const [row] = await db
    .select({ p: s.proposals, deal: s.deals, pipelineKey: s.pipelines.key, accountName: s.accounts.name })
    .from(s.proposals)
    .innerJoin(s.deals, eq(s.deals.id, s.proposals.dealId))
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .leftJoin(s.accounts, eq(s.accounts.id, s.deals.accountId))
    .where(and(eq(s.proposals.id, id), eq(s.proposals.kind, TERM_SHEET_KIND), where));
  if (!row) return null;
  const versions = await db
    .select({ id: s.proposals.id, version: s.proposals.version, status: s.proposals.status, createdAt: s.proposals.createdAt, createdByName: s.user.name })
    .from(s.proposals)
    .leftJoin(s.user, eq(s.user.id, s.proposals.createdBy))
    .where(and(eq(s.proposals.dealId, row.p.dealId), eq(s.proposals.kind, TERM_SHEET_KIND)))
    .orderBy(desc(s.proposals.version));
  const approvals = await db
    .select({ a: s.approvals, requestedByName: s.user.name })
    .from(s.approvals)
    .leftJoin(s.user, eq(s.user.id, s.approvals.requestedBy))
    .where(and(eq(s.approvals.kind, "proposal"), eq(s.approvals.entityId, id)))
    .orderBy(desc(s.approvals.createdAt))
    .limit(20);
  const inputs = normalizeTermSheetInputs(row.p.inputs);
  const outputs = termSheetOutputs(inputs);
  const stored = (row.p.outputs ?? {}) as { signedAt?: string | null; documentId?: string | null };
  const template = await getTemplate(inputs.templateId);
  const [canEdit, canCreate, canApprove] = await Promise.all([can(user, "proposals", "edit"), can(user, "proposals", "create"), can(user, "proposals", "approve", "all")]);
  return {
    proposal: {
      id: row.p.id,
      dealId: row.p.dealId,
      version: row.p.version,
      status: row.p.status,
      approvalReason: row.p.approvalReason,
      createdAt: row.p.createdAt.toISOString(),
      sentAt: row.p.sentAt?.toISOString() ?? null,
      signedAt: typeof stored.signedAt === "string" ? stored.signedAt : null,
    },
    deal: { id: row.deal.id, name: row.deal.name, pipelineKey: row.pipelineKey, accountName: row.accountName, restricted: row.deal.restricted },
    inputs,
    outputs,
    exportable: termSheetExportable(row.p.status, outputs.reasons),
    targets: usedTargets(inputs.snapshot.fieldMap),
    template: template ? { id: template.id, name: template.name, version: template.version, active: template.active } : null,
    versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
    approvals: approvals.map((a) => ({
      id: a.a.id,
      status: a.a.status,
      requestedByName: a.requestedByName,
      createdAt: a.a.createdAt.toISOString(),
      decidedAt: a.a.decidedAt?.toISOString() ?? null,
      note: a.a.note,
      reasons: ((a.a.payload as { reasons?: unknown }).reasons as string[] | undefined) ?? [],
    })),
    perms: { canEdit, canCreate, canApprove },
  };
}

export type DealProposalRow = { id: string; kind: string; version: number; status: string; createdAt: string; label: string };

/** Proposals on one deal (for the deal page panel). Null when the user can't use proposals or see the deal. */
export async function dealProposals(user: AppUser, dealId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(dealId)) return null;
  if (!(await can(user, "proposals", "view")) || (await isFieldHiddenFor(user.role, "proposal", "*"))) return null;
  const [deal] = await db
    .select({ id: s.deals.id, pipelineKey: s.pipelines.key })
    .from(s.deals)
    .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
    .where(and(eq(s.deals.id, dealId), await dealAccessWhere(user, "view")));
  if (!deal) return null;
  const rows = await db
    .select({ id: s.proposals.id, kind: s.proposals.kind, version: s.proposals.version, status: s.proposals.status, createdAt: s.proposals.createdAt, outputs: s.proposals.outputs })
    .from(s.proposals)
    .innerJoin(s.deals, eq(s.deals.id, s.proposals.dealId))
    .where(and(eq(s.proposals.dealId, dealId), await proposalWhere(user, "view")))
    .orderBy(desc(s.proposals.createdAt))
    .limit(50);
  const [canCreate, active] = await Promise.all([can(user, "proposals", "create"), deal.pipelineKey === "NET" ? getActiveTemplate(TERM_SHEET_KIND) : Promise.resolve(null)]);
  return {
    pipelineKey: deal.pipelineKey,
    rows: rows.map(
      (r): DealProposalRow => ({
        id: r.id,
        kind: r.kind,
        version: r.version,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        label:
          r.kind === TERM_SHEET_KIND
            ? (() => {
                const t = (r.outputs as { tier?: { label?: string; partnerPct?: number } | null }).tier;
                return t?.label ? `Tier ${t.label}${typeof t.partnerPct === "number" ? ` · partner ${t.partnerPct}%` : ""}` : "No tier";
              })()
            : "Pro forma",
      }),
    ),
    canCreate,
    hasTemplate: Boolean(active),
  };
}
