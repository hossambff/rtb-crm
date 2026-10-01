import "server-only";
import { createHash } from "node:crypto";
import { cache } from "react";
import { and, desc, eq, max } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AppUser } from "@/lib/rbac/server";
import { analyzeParts, partTexts } from "./docx/analyze";
import { assertSafePackage, DocxError, openDocx, readTextParts } from "./docx/package";
import type { PartText } from "./docx/detect";
import { normalizeApproval, templateReviewBlockers, TEMPLATE_KINDS, type FieldMapEntry, type TemplateInfo, type TemplateParsed } from "./termsheet";

export type TemplateRow = {
  id: string;
  kind: string;
  name: string;
  version: number;
  fileName: string;
  sha256: string;
  active: boolean;
  uploadedByName: string | null;
  createdAt: string;
  fieldMap: FieldMapEntry[];
  parsed: TemplateParsed;
};

/** Columns we select — never the file itself (fileB64) unless generating. */
const META = {
  id: s.proposalTemplates.id,
  kind: s.proposalTemplates.kind,
  name: s.proposalTemplates.name,
  version: s.proposalTemplates.version,
  fileName: s.proposalTemplates.fileName,
  sha256: s.proposalTemplates.sha256,
  active: s.proposalTemplates.active,
  fieldMap: s.proposalTemplates.fieldMap,
  parsed: s.proposalTemplates.parsed,
  createdAt: s.proposalTemplates.createdAt,
  uploadedByName: s.user.name,
};

function toRow(r: { createdAt: Date; parsed: Record<string, unknown>; fieldMap: FieldMapEntry[] } & Omit<TemplateRow, "createdAt" | "parsed" | "fieldMap">): TemplateRow {
  const parsed = (r.parsed ?? {}) as TemplateParsed;
  return { ...r, createdAt: r.createdAt.toISOString(), fieldMap: Array.isArray(r.fieldMap) ? r.fieldMap : [], parsed: { ...parsed, approval: normalizeApproval(parsed.approval) } };
}

export async function listTemplates(): Promise<TemplateRow[]> {
  const rows = await db
    .select(META)
    .from(s.proposalTemplates)
    .leftJoin(s.user, eq(s.user.id, s.proposalTemplates.uploadedBy))
    .orderBy(s.proposalTemplates.kind, desc(s.proposalTemplates.version))
    .limit(200);
  return rows.map(toRow);
}

export const getTemplate = cache(async (id: string): Promise<TemplateRow | null> => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await db.select(META).from(s.proposalTemplates).leftJoin(s.user, eq(s.user.id, s.proposalTemplates.uploadedBy)).where(eq(s.proposalTemplates.id, id));
  return r ? toRow(r) : null;
});

/** The live template of a kind — only when it is active AND reviewed (an unreviewed one is never offered to reps). */
export const getActiveTemplate = cache(async (kind: string): Promise<TemplateRow | null> => {
  const [r] = await db
    .select(META)
    .from(s.proposalTemplates)
    .leftJoin(s.user, eq(s.user.id, s.proposalTemplates.uploadedBy))
    .where(and(eq(s.proposalTemplates.kind, kind), eq(s.proposalTemplates.active, true)))
    .orderBy(desc(s.proposalTemplates.version))
    .limit(1);
  const row = r ? toRow(r) : null;
  return row && templateReviewBlockers(row).length === 0 ? row : null;
});

export function templateInfo(t: TemplateRow): TemplateInfo {
  return { id: t.id, version: t.version, name: t.name, sha256: t.sha256, fieldMap: t.fieldMap, parsed: t.parsed };
}

export const sha256Hex = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex");

/** The stored file, integrity-checked against its sha256. */
export const loadTemplateFile = cache(async (id: string): Promise<Buffer> => {
  const [r] = await db.select({ b64: s.proposalTemplates.fileB64, sha: s.proposalTemplates.sha256 }).from(s.proposalTemplates).where(eq(s.proposalTemplates.id, id));
  if (!r) throw new DocxError("Template not found.");
  const buf = Buffer.from(r.b64, "base64");
  if (sha256Hex(buf) !== r.sha) throw new DocxError("The stored template failed its integrity check. Re-upload it.");
  return buf;
});

/** Text parts (XML) of a stored template, parsed once per request. */
export const loadTemplateParts = cache(async (id: string): Promise<{ name: string; xml: string }[]> => readTextParts(await openDocx(await loadTemplateFile(id))));

export async function loadTemplateTexts(id: string): Promise<PartText[]> {
  return partTexts(await loadTemplateParts(id));
}

/**
 * Validate + analyze an uploaded .docx and store it as the next version of `kind` — always INACTIVE (a draft): an admin
 * reviews the mapping and tiers, then activates it explicitly (QA MAJ-19). Generation refuses unreviewed templates.
 */
export async function createTemplate(user: AppUser, input: { kind: string; name: string; fileName: string; data: Uint8Array }) {
  if (!TEMPLATE_KINDS.some((k) => k.kind === input.kind)) throw new DocxError("Unknown template kind.");
  const zip = await openDocx(input.data);
  await assertSafePackage(zip);
  const parts = await readTextParts(zip);
  const analysis = analyzeParts(parts);
  const sha256 = sha256Hex(input.data);
  const fieldMap: FieldMapEntry[] = analysis.candidates.map((c) => ({ token: c.id, input: c.suggested, occurrences: c.occurrences }));
  const parsed: TemplateParsed = {
    candidates: analysis.candidates,
    tierTables: analysis.tierTables,
    tiers: analysis.tierTables[0]?.tiers ?? [],
    tierTableIndex: analysis.tierTables.length ? 0 : null,
    tiersReviewed: false,
    mappingReviewed: false,
    approval: { tierChange: true, fields: [] },
    parts: parts.map((p) => p.name),
    stats: { ...analysis.stats, bytes: input.data.byteLength },
  };
  const row = await db.transaction(async (tx) => {
    const [{ v }] = await tx.select({ v: max(s.proposalTemplates.version) }).from(s.proposalTemplates).where(eq(s.proposalTemplates.kind, input.kind));
    const [r] = await tx
      .insert(s.proposalTemplates)
      .values({
        kind: input.kind,
        name: input.name,
        version: (v ?? 0) + 1,
        fileName: input.fileName,
        fileB64: Buffer.from(input.data).toString("base64"),
        sha256,
        fieldMap,
        parsed: parsed as Record<string, unknown>,
        active: false,
        uploadedBy: user.id,
      })
      .returning({ id: s.proposalTemplates.id, version: s.proposalTemplates.version, active: s.proposalTemplates.active });
    // Audit the metadata only — never the document content.
    await audit(
      {
        actorId: user.id,
        action: "proposal_template.upload",
        entity: "proposal_template",
        entityId: r!.id,
        after: { kind: input.kind, name: input.name, version: r!.version, fileName: input.fileName, sha256, bytes: input.data.byteLength, active: r!.active, candidates: analysis.candidates.length, tierTables: analysis.tierTables.length },
      },
      tx,
    );
    return r!;
  });
  return { ...row, candidates: analysis.candidates.length, tierTables: analysis.tierTables.length };
}
