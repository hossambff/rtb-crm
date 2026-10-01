"use server";
import { revalidatePath } from "next/cache";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import * as s from "@/db/schema";
import { action, UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/admin/guard";
import { customCandidate, INPUT_KEYS, isMapTarget } from "./docx/detect";
import { validateTiers, type Tier } from "./docx/tiers";
import { getTemplate, loadTemplateTexts } from "./templates";
import { templateReviewBlockers, type FieldMapEntry, type TemplateParsed } from "./termsheet";

const idSchema = z.uuid();

async function load(id: string) {
  const t = await getTemplate(id);
  if (!t) throw new UserError("Template not found.");
  return t;
}

async function writeTemplate(id: string, patch: { fieldMap?: FieldMapEntry[]; parsed?: TemplateParsed }) {
  await db
    .update(s.proposalTemplates)
    .set({ ...(patch.fieldMap ? { fieldMap: patch.fieldMap } : {}), ...(patch.parsed ? { parsed: patch.parsed as Record<string, unknown> } : {}) })
    .where(eq(s.proposalTemplates.id, id));
  revalidatePath("/admin/templates");
  revalidatePath(`/admin/templates/${id}`);
}

/** Map each detected placeholder to a proposal input (or "ignore"). */
export const saveTemplateMapping = action(
  z.object({ id: idSchema, map: z.array(z.object({ token: z.string().min(1).max(400), input: z.string().min(1).max(60) })).max(400) }),
  async ({ id, map }, user) => {
    await requireAdmin(user);
    const t = await load(id);
    const cands = new Map((t.parsed.candidates ?? []).map((c) => [c.id, c]));
    const next: FieldMapEntry[] = [];
    for (const m of map) {
      const c = cands.get(m.token);
      if (!c) throw new UserError("The document changed under this mapping. Reload the page.");
      if (!isMapTarget(m.input)) throw new UserError(`"${m.input.slice(0, 40)}" is not a valid field. Custom fields use letters, digits and spaces (max 40).`);
      next.push({ token: c.id, input: m.input, occurrences: c.occurrences });
    }
    // Unlisted candidates keep their previous mapping.
    for (const f of t.fieldMap) if (!next.some((n) => n.token === f.token) && cands.has(f.token)) next.push(f);
    // Saving the mapping is the admin's review of it (required before activation — QA MAJ-19).
    await writeTemplate(id, { fieldMap: next, parsed: { ...t.parsed, mappingReviewed: true } });
    await audit({ actorId: user.id, action: "proposal_template.map", entity: "proposal_template", entityId: id, before: t.fieldMap, after: next });
    return { mapped: next.filter((f) => f.input !== "ignore").length };
  },
);

/** Add a literal phrase from the document as a placeholder (e.g. a market/region phrase). */
export const addCustomToken = action(z.object({ id: idSchema, token: z.string().trim().min(2, "Type at least 2 characters").max(200) }), async ({ id, token }, user) => {
  await requireAdmin(user);
  const t = await load(id);
  const cand = customCandidate(await loadTemplateTexts(id), token);
  if (!cand) throw new UserError("That exact text was not found in the document (it must sit within one paragraph).");
  const candidates = t.parsed.candidates ?? [];
  if (candidates.some((c) => c.id === cand.id)) throw new UserError("That text is already a placeholder.");
  if (candidates.length >= 400) throw new UserError("Too many placeholders on this template.");
  const parsed: TemplateParsed = { ...t.parsed, candidates: [...candidates, cand] };
  const fieldMap = [...t.fieldMap, { token: cand.id, input: "ignore", occurrences: cand.occurrences }];
  await writeTemplate(id, { parsed, fieldMap });
  await audit({ actorId: user.id, action: "proposal_template.add_token", entity: "proposal_template", entityId: id, after: { token: cand.id, occurrences: cand.occurrences } });
  return { token: cand.id, occurrences: cand.occurrences };
});

export const removeCustomToken = action(z.object({ id: idSchema, token: z.string().min(1).max(400) }), async ({ id, token }, user) => {
  await requireAdmin(user);
  const t = await load(id);
  const c = (t.parsed.candidates ?? []).find((x) => x.id === token);
  if (!c || c.kind !== "custom") throw new UserError("Only placeholders added by an admin can be removed.");
  const parsed: TemplateParsed = { ...t.parsed, candidates: (t.parsed.candidates ?? []).filter((x) => x.id !== token) };
  await writeTemplate(id, { parsed, fieldMap: t.fieldMap.filter((f) => f.token !== token) });
  await audit({ actorId: user.id, action: "proposal_template.remove_token", entity: "proposal_template", entityId: id, before: { token } });
  return { ok: true };
});

const tierSchema = z.object({
  label: z.string().trim().min(1, "Add a label").max(60),
  min: z.number().min(0).max(1e12).nullable(),
  max: z.number().min(0).max(1e12).nullable(),
  minExclusive: z.boolean().optional(),
  maxExclusive: z.boolean().optional(),
  partnerPct: z.number().min(0).max(100),
  rtbPct: z.number().min(0).max(100),
});

/** Admin review of the revenue-share tiers parsed from the document (numbers stay data, never code). */
export const saveTemplateTiers = action(
  z.object({ id: idSchema, tierTableIndex: z.number().int().min(0).max(50).nullable(), tiers: z.array(tierSchema).max(30) }),
  async ({ id, tierTableIndex, tiers }, user) => {
    await requireAdmin(user);
    const t = await load(id);
    const errs = validateTiers(tiers as Tier[]);
    if (errs.length) throw new UserError(errs.slice(0, 3).join(" "));
    const parsed: TemplateParsed = { ...t.parsed, tiers: tiers as Tier[], tierTableIndex, tiersReviewed: true };
    await writeTemplate(id, { parsed });
    await audit({ actorId: user.id, action: "proposal_template.tiers", entity: "proposal_template", entityId: id, before: { tiers: t.parsed.tiers ?? [] }, after: { tiers, tierTableIndex } });
    return { count: tiers.length };
  },
);

/** Which changes need executive approval before a term sheet can be sent. */
export const saveTemplateApproval = action(
  z.object({ id: idSchema, tierChange: z.boolean(), fields: z.array(z.enum(INPUT_KEYS)).max(INPUT_KEYS.length) }),
  async ({ id, tierChange, fields }, user) => {
    await requireAdmin(user);
    const t = await load(id);
    const parsed: TemplateParsed = { ...t.parsed, approval: { tierChange, fields: [...new Set(fields)] } };
    await writeTemplate(id, { parsed });
    await audit({ actorId: user.id, action: "proposal_template.approval_rules", entity: "proposal_template", entityId: id, before: t.parsed.approval, after: parsed.approval });
    return { ok: true };
  },
);

/** One active template per kind: activating one deactivates the others of its kind. */
export const setTemplateActive = action(z.object({ id: idSchema, active: z.boolean() }), async ({ id, active }, user) => {
  await requireAdmin(user);
  const t = await load(id);
  if (active) {
    const blockers = templateReviewBlockers(t);
    if (blockers.length) throw new UserError(`Not ready to activate: ${blockers.join(" ")}`);
  }
  await db.transaction(async (tx) => {
    if (active)
      await tx
        .update(s.proposalTemplates)
        .set({ active: false })
        .where(and(eq(s.proposalTemplates.kind, t.kind), ne(s.proposalTemplates.id, id), eq(s.proposalTemplates.active, true)));
    await tx.update(s.proposalTemplates).set({ active }).where(eq(s.proposalTemplates.id, id));
    await audit({ actorId: user.id, action: active ? "proposal_template.activate" : "proposal_template.deactivate", entity: "proposal_template", entityId: id, before: { active: t.active }, after: { active } }, tx);
  });
  revalidatePath("/admin/templates");
  revalidatePath(`/admin/templates/${id}`);
  revalidatePath("/proposals");
  return { active };
});
