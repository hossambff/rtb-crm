"use server";
import { revalidatePath } from "next/cache";
import { and, eq, max } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, type AppUser } from "@/lib/rbac/server";
import { assertProposalDeal } from "./access";
import { syncProposalApproval } from "./approval-state";
import { DATE_INPUTS, isMapTarget, parseIsoDate } from "./docx/detect";
import { getActiveTemplate, getTemplate, templateInfo, type TemplateRow } from "./templates";
import { termSheetDealContext, termSheetOutputs, todayIso, TERM_SHEET_PIPELINES } from "./term-sheet-queries";
import { cleanValue, normalizeTermSheetInputs, snapshotOf, templateReviewBlockers, termSheetExportable, termSheetLocked, TERM_SHEET_KIND, usedTargets, type TermSheetInputs } from "./termsheet";
import { withVersionRetry } from "./versioning";

const KIND_LABEL = "Coalition term sheet";

const formSchema = z.object({
  values: z.record(z.string().max(60), z.string().max(400)).refine((v) => Object.keys(v).length <= 60, "Too many fields"),
  muu: z.number().int().min(0).max(1e11).nullable(),
  tierIndex: z.number().int().min(0).max(50).nullable(),
  notes: z.string().trim().max(2000).optional(),
});

/** Keep only the template's mapped inputs; validate dates. */
function cleanValues(raw: Record<string, string>, targets: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of targets) {
    if (!isMapTarget(t) || t === "ignore") continue;
    const v = cleanValue(raw[t]);
    if (v && (DATE_INPUTS as string[]).includes(t) && !parseIsoDate(v)) throw new UserError("Dates must be valid (yyyy-mm-dd).");
    out[t] = v;
  }
  return out;
}

/** Never generate from a template an admin hasn't reviewed (mapping + tiers) — QA MAJ-19. */
function assertReviewed(t: TemplateRow) {
  if (templateReviewBlockers(t).length) throw new UserError("This term sheet template hasn't been reviewed by an admin yet, so it can't be used. Ask an admin to finish it under Admin → Templates.");
}

function buildInputs(t: TemplateRow, form: z.infer<typeof formSchema>, prefill: Record<string, string>, usdPerMuu: number): TermSheetInputs {
  const snapshot = snapshotOf(templateInfo(t));
  const targets = usedTargets(snapshot.fieldMap);
  if (form.tierIndex !== null && form.tierIndex >= snapshot.tiers.length) throw new UserError("That tier does not exist on this template.");
  return normalizeTermSheetInputs({
    templateId: t.id,
    templateVersion: t.version,
    templateSha256: t.sha256,
    values: cleanValues(form.values, targets),
    prefill: Object.fromEntries(targets.map((k) => [k, prefill[k] ?? ""])),
    muu: form.muu,
    usdPerMuu,
    tierIndex: form.tierIndex,
    notes: form.notes || undefined,
    snapshot,
  });
}

/** Insert a version + its deal document + activity in one transaction; then route approval. */
async function insertVersion(user: AppUser, dealId: string, inputs: TermSheetInputs, deal: { name: string; restricted: boolean; accountId: string | null }, from?: string) {
  const outputs = termSheetOutputs(inputs);
  // Concurrent versions collide on proposals_deal_kind_version_uq → the whole transaction is retried once.
  const created = await withVersionRetry(() => db.transaction(async (tx) => {
    const [{ v }] = await tx.select({ v: max(s.proposals.version) }).from(s.proposals).where(and(eq(s.proposals.dealId, dealId), eq(s.proposals.kind, TERM_SHEET_KIND)));
    const version = (v ?? 0) + 1;
    const [row] = await tx
      .insert(s.proposals)
      .values({ kind: TERM_SHEET_KIND, title: KIND_LABEL, dealId, version, inputs: inputs as never, outputs: outputs as never, status: "draft", createdBy: user.id })
      .returning({ id: s.proposals.id });
    const id = row!.id;
    const [doc] = await tx
      .insert(s.documents)
      .values({ dealId, accountId: deal.accountId, type: "proposal", name: `${KIND_LABEL} v${version}`, url: `/proposals/term-sheets/${id}`, status: "draft", version, uploadedBy: user.id })
      .returning({ id: s.documents.id });
    await tx.update(s.proposals).set({ outputs: { ...outputs, documentId: doc!.id } as never }).where(eq(s.proposals.id, id));
    await tx.insert(s.activities).values({
      type: "system",
      source: "system",
      subject: `${KIND_LABEL} v${version} created`,
      actorId: user.id,
      dealId,
      accountId: deal.accountId,
      metadata: { proposalId: id, kind: TERM_SHEET_KIND, version, documentId: doc!.id, ...(from ? { fromId: from } : {}) },
    });
    await audit(
      { actorId: user.id, action: from ? "proposal.new_version" : "proposal.create", entity: "proposal", entityId: id, after: { kind: TERM_SHEET_KIND, dealId, version, templateId: inputs.templateId, values: inputs.values, muu: inputs.muu, tierIndex: inputs.tierIndex, reasons: outputs.reasons, fromId: from } },
      tx,
    );
    return { id, version };
  }));
  await syncProposalApproval(user, { id: created.id, version: created.version, kindLabel: KIND_LABEL }, deal, outputs.reasons);
  revalidatePath("/proposals");
  revalidatePath(`/deals/${dealId}`);
  return { ...created, reasons: outputs.reasons };
}

async function assertNetDeal(user: AppUser, dealId: string, act: "create" | "edit") {
  const { deal, pipelineKey } = await assertProposalDeal(user, dealId, act);
  if (!TERM_SHEET_PIPELINES.includes(pipelineKey)) throw new UserError("Coalition term sheets are for Network Development deals.");
  return deal;
}

export const createTermSheet = action(formSchema.extend({ dealId: z.uuid("Pick a deal") }), async (form, user) => {
  await assertCan(user, "proposals", "create");
  const deal = await assertNetDeal(user, form.dealId, "create");
  const t = await getActiveTemplate(TERM_SHEET_KIND);
  if (!t) throw new UserError("No active term sheet template. Ask an admin to upload one under Admin → Templates.");
  assertReviewed(t);
  const ctx = await termSheetDealContext(user, form.dealId);
  if (!ctx) throw new UserError("Deal not found or not visible to you.");
  const inputs = buildInputs(t, form, ctx.prefill, ctx.usdPerMuu);
  return insertVersion(user, form.dealId, inputs, deal);
});

export const updateTermSheet = action(formSchema.extend({ id: z.uuid() }), async (form, user) => {
  await assertCan(user, "proposals", "edit");
  const [before] = await db.select().from(s.proposals).where(eq(s.proposals.id, form.id));
  if (!before || before.kind !== TERM_SHEET_KIND) throw new UserError("Term sheet not found.");
  const deal = await assertNetDeal(user, before.dealId, "edit");
  if (termSheetLocked(before.status)) throw new UserError(`Version ${before.version} is ${before.status} and locked. Create a new version to change it.`);
  const prev = normalizeTermSheetInputs(before.inputs);
  // Drafts follow their own template's current mapping (admin fixes apply); sent versions never change.
  const t = await getTemplate(prev.templateId);
  if (!t) throw new UserError("This version's template is no longer available. Create a new version.");
  assertReviewed(t);
  const inputs = buildInputs(t, form, prev.prefill, prev.usdPerMuu);
  const outputs = termSheetOutputs(inputs);
  const stored = (before.outputs ?? {}) as Record<string, unknown>;
  await db.update(s.proposals).set({ inputs: inputs as never, outputs: { ...outputs, documentId: stored.documentId ?? null } as never }).where(eq(s.proposals.id, form.id));
  await syncProposalApproval(user, { id: form.id, version: before.version, kindLabel: KIND_LABEL }, deal, outputs.reasons);
  await audit({ actorId: user.id, action: "proposal.update", entity: "proposal", entityId: form.id, before: { values: prev.values, muu: prev.muu, tierIndex: prev.tierIndex }, after: { values: inputs.values, muu: inputs.muu, tierIndex: inputs.tierIndex, reasons: outputs.reasons } });
  revalidatePath("/proposals");
  revalidatePath(`/proposals/term-sheets/${form.id}`);
  return { id: form.id, reasons: outputs.reasons };
});

/** New version from any existing one: same values, the currently active template, a fresh prefill from the deal. */
export const newTermSheetVersion = action(z.object({ fromId: z.uuid() }), async ({ fromId }, user) => {
  await assertCan(user, "proposals", "create");
  const [src] = await db.select().from(s.proposals).where(eq(s.proposals.id, fromId));
  if (!src || src.kind !== TERM_SHEET_KIND) throw new UserError("Term sheet not found.");
  const deal = await assertNetDeal(user, src.dealId, "create");
  const prev = normalizeTermSheetInputs(src.inputs);
  const t = (await getActiveTemplate(TERM_SHEET_KIND)) ?? (await getTemplate(prev.templateId));
  if (!t) throw new UserError("No term sheet template available.");
  assertReviewed(t);
  const ctx = await termSheetDealContext(user, src.dealId);
  if (!ctx) throw new UserError("Deal not found or not visible to you.");
  const tiers = snapshotOf(templateInfo(t)).tiers;
  const inputs = buildInputs(t, { values: prev.values, muu: prev.muu, tierIndex: prev.tierIndex !== null && prev.tierIndex < tiers.length ? prev.tierIndex : null, notes: prev.notes }, ctx.prefill, ctx.usdPerMuu);
  return insertVersion(user, src.dealId, inputs, deal, fromId);
});

/** Manual status (no e-sign provider): draft/approved → sent → signed, each with its date. */
export const setTermSheetStatus = action(
  z.object({ id: z.uuid(), status: z.enum(["sent", "signed"]), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date") }),
  async ({ id, status, date }, user) => {
    await assertCan(user, "proposals", "edit");
    const [p] = await db.select().from(s.proposals).where(eq(s.proposals.id, id));
    if (!p || p.kind !== TERM_SHEET_KIND) throw new UserError("Term sheet not found.");
    await assertNetDeal(user, p.dealId, "edit");
    if (!parseIsoDate(date)) throw new UserError("Pick a valid date.");
    if (date > todayIso(user.timezone)) throw new UserError("The date can't be in the future.");
    const inputs = normalizeTermSheetInputs(p.inputs);
    const outputs = termSheetOutputs(inputs);
    const stored = (p.outputs ?? {}) as Record<string, unknown>;
    if (status === "sent") {
      if (!termSheetExportable(p.status, outputs.reasons)) throw new UserError("This version needs executive approval before it can be sent.");
      if (p.status !== "draft" && p.status !== "approved") throw new UserError(`Version ${p.version} is already ${p.status}.`);
    } else {
      if (p.status !== "sent") throw new UserError("Mark the term sheet as sent before recording the signature.");
      if (p.sentAt && date < p.sentAt.toISOString().slice(0, 10)) throw new UserError("The signature date can't be before the sent date.");
    }
    const at = new Date(`${date}T12:00:00Z`);
    const [deal] = await db.select({ accountId: s.deals.accountId }).from(s.deals).where(eq(s.deals.id, p.dealId));
    await db.transaction(async (tx) => {
      if (status === "sent") await tx.update(s.proposals).set({ status: "sent", sentAt: at }).where(eq(s.proposals.id, id));
      else await tx.update(s.proposals).set({ status: "signed", outputs: { ...stored, signedAt: at.toISOString() } as never }).where(eq(s.proposals.id, id));
      if (typeof stored.documentId === "string")
        await tx
          .update(s.documents)
          .set(status === "sent" ? { status: "sent", sentAt: at } : { status: "signed", signedAt: at })
          .where(and(eq(s.documents.id, stored.documentId), eq(s.documents.dealId, p.dealId)));
      await tx.insert(s.activities).values({
        type: "system",
        source: "manual",
        subject: `${KIND_LABEL} v${p.version} ${status === "sent" ? "sent" : "signed"}`,
        occurredAt: at,
        actorId: user.id,
        dealId: p.dealId,
        accountId: deal?.accountId ?? null,
        metadata: { proposalId: id, kind: TERM_SHEET_KIND, version: p.version, status },
      });
      await audit({ actorId: user.id, action: `proposal.${status}`, entity: "proposal", entityId: id, before: { status: p.status }, after: { status, date } }, tx);
    });
    revalidatePath("/proposals");
    revalidatePath(`/proposals/term-sheets/${id}`);
    revalidatePath(`/deals/${p.dealId}`);
    return { id, status };
  },
);
